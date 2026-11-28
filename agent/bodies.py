"""Full email text and attachments, for the owner's reader.

The dashboard's reader needs each email's text and its attachment list. This
module turns a Gmail `format=full` message into safe plain text, stores one
small file per message on the private state branch, and stores attachments the
owner asks for.

Safety rules:
- HTML is converted to plain text here; the dashboard never renders email HTML,
  so no email can run script or load trackers in the page.
- Text is capped, control and direction-override characters are removed, and
  lines that talk about one-time codes have their digits masked.
- Only messages still in the inbox keep a text file; each sync prunes the rest.
- Nothing here is sent to Claude.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterator

from .sanitize import clean_text, redact_codes

BODY_MAX_CHARS = 20_000
ATTACHMENT_FILE_MAX = 15 * 1024 * 1024    # one file
ATTACHMENT_TOTAL_MAX = 25 * 1024 * 1024   # all files of one message
FILES_KEEP_DAYS = 7
_BIDI = dict.fromkeys(map(ord, "‪‫‬‭‮⁦⁧⁨⁩‎‏"), None)
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._ -]+")
_MSGID = re.compile(r"^<[^<>\s]{3,250}@[^<>\s]{1,250}>$")


# ---------------------------------------------------------------- decoding

def b64url_decode(data: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
    except (binascii.Error, ValueError):
        return b""


def _charset(part: dict) -> str:
    for h in (part.get("headers") or []):
        if str(h.get("name", "")).lower() == "content-type":
            m = re.search(r'charset="?([A-Za-z0-9_.:-]+)"?', str(h.get("value", "")))
            if m:
                return m.group(1)
    return "utf-8"


def _decode_text(raw: bytes, charset: str) -> str:
    try:
        return raw.decode(charset, errors="replace")
    except LookupError:  # an unknown charset name from the sender
        return raw.decode("utf-8", errors="replace")


def _is_attachment(part: dict) -> bool:
    if part.get("filename"):
        return True
    for h in (part.get("headers") or []):
        if str(h.get("name", "")).lower() == "content-disposition" and "attachment" in str(h.get("value", "")).lower():
            return True
    return False


def walk(part: dict) -> Iterator[dict]:
    """Every MIME part, depth first. Iterative so a hostile, deeply nested mail cannot exhaust the stack."""
    stack = [part]
    seen = 0
    while stack and seen < 500:
        p = stack.pop()
        seen += 1
        yield p
        stack.extend(reversed(p.get("parts") or []))


# ---------------------------------------------------------------- HTML to text

class _TextFromHtml(HTMLParser):
    BLOCK = {"p", "div", "br", "tr", "table", "section", "article", "header", "footer", "blockquote",
             "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "hr", "pre"}
    SKIP = {"script", "style", "head", "title", "noscript", "template", "svg"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skip = 0
        self.href: str | None = None
        self.link_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.SKIP:
            self.skip += 1
        elif self.skip:
            return
        elif tag in self.BLOCK:
            self.out.append("\n")
        elif tag == "li":
            self.out.append("\n• ")
        elif tag == "td":
            self.out.append(" ")
        elif tag == "img":
            alt = dict(attrs).get("alt")
            if alt:
                self.out.append(f"[{alt}]")
        elif tag == "a":
            self.href = dict(attrs).get("href")
            self.link_text = []

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif self.skip:
            return
        elif tag == "a":
            # Show where a link really goes, so a reader cannot be misled by its text.
            text = "".join(self.link_text).strip()
            href = (self.href or "").strip()
            if href.lower().startswith(("http://", "https://")) and href not in text:
                self.out.append(f" ({href})")
            self.href = None
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data: str) -> None:
        if self.skip:
            return
        self.out.append(data)
        if self.href is not None:
            self.link_text.append(data)


def html_to_text(html: str) -> str:
    parser = _TextFromHtml()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # malformed HTML: keep what was parsed so far
        pass
    return "".join(parser.out)


# ---------------------------------------------------------------- cleaning

def clean_body(text: str, limit: int = BODY_MAX_CHARS) -> tuple[str, bool]:
    """Normalise to readable plain text. Returns (text, truncated)."""
    text = unicodedata.normalize("NFKC", text).translate(_BIDI)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(ch if (ch.isprintable() or ch in "\n\t") else " " for ch in text)
    lines = [re.sub(r"[ \t ]+", " ", ln).strip() for ln in text.split("\n")]
    # Mask one-time codes line by line, so other numbers in a long email are kept.
    lines = [redact_codes(ln) for ln in lines]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    truncated = len(text) > limit
    if truncated:
        text = text[:limit].rstrip() + "\n\n[… cut here: open the email in Gmail for the rest]"
    return text, truncated


def header_map(message: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for h in ((message.get("payload") or {}).get("headers") or []):
        name = str(h.get("name", "")).lower()
        if name and name not in out:
            out[name] = str(h.get("value", ""))
    return out


def message_id_header(hdrs: dict[str, str]) -> str | None:
    """RFC 822 Message-ID, for an exact Gmail search link. Validated: it ends up in a URL."""
    value = hdrs.get("message-id", "").strip()
    return value if _MSGID.match(value) else None


def attachment_parts(message: dict) -> list[dict]:
    parts = []
    for p in walk(message.get("payload") or {}):
        if not _is_attachment(p):
            continue
        body = p.get("body") or {}
        parts.append({
            "name": safe_filename(p.get("filename") or "attachment"),
            "mime": clean_text(p.get("mimeType") or "application/octet-stream", 100),
            "size": int(body.get("size") or 0),
            "attachment_id": str(body.get("attachmentId") or ""),
            "inline_data": body.get("data") or "",
        })
    return parts


def extract(message: dict, fetch_attachment=None, limit: int = BODY_MAX_CHARS) -> dict[str, Any]:
    """Text and attachment list from a Gmail `format=full` message.

    fetch_attachment(attachment_id) -> bytes is used only when Gmail keeps a
    long text part separately instead of inline.
    """
    plain: list[str] = []
    html: list[str] = []
    for p in walk(message.get("payload") or {}):
        mime = str(p.get("mimeType", "")).lower()
        if _is_attachment(p) or mime not in ("text/plain", "text/html"):
            continue
        body = p.get("body") or {}
        raw = b64url_decode(body["data"]) if body.get("data") else b""
        if not raw and body.get("attachmentId") and fetch_attachment and int(body.get("size") or 0) <= 2_000_000:
            raw = fetch_attachment(str(body["attachmentId"]))
        text = _decode_text(raw, _charset(p))
        (plain if mime == "text/plain" else html).append(text)
    if plain and any(t.strip() for t in plain):
        source, fmt = "\n\n".join(plain), "plain"
    elif html:
        source, fmt = html_to_text("\n".join(html)), "html"
    else:
        source, fmt = "", "none"
    text, truncated = clean_body(source, limit)
    hdrs = header_map(message)
    return {
        "id": str(message.get("id", "")),
        "from": clean_text(hdrs.get("from", ""), 300),
        "to": clean_text(hdrs.get("to", ""), 1000),
        "cc": clean_text(hdrs.get("cc", ""), 1000),
        "subject": redact_codes(clean_text(hdrs.get("subject", ""), 300)),
        "date": clean_text(hdrs.get("date", ""), 100),
        "text": text,
        "format": fmt,
        "truncated": truncated,
        "attachments": [{k: a[k] for k in ("name", "mime", "size")} for a in attachment_parts(message)],
    }


# ---------------------------------------------------------------- storage

def safe_filename(name: str) -> str:
    """A file name that is safe on every OS and in a URL path segment."""
    name = clean_text(name, 200).replace("/", "_").replace("\\", "_")
    name = _SAFE_NAME.sub("_", name).strip(" .")
    return name[:120] or "attachment"


class BodyStore:
    """One JSON file per message: bodies/<account>/<message id>.json on the state branch."""

    def __init__(self, state_dir: Path, sealer=None, passphrase: str | None = None):
        self.root = state_dir / "bodies"
        self.sealer = sealer
        self.passphrase = passphrase

    def path(self, account: str, message_id: str) -> Path:
        return self.root / account / f"{message_id}.json"

    def has(self, account: str, message_id: str) -> bool:
        return self.path(account, message_id).exists()

    def attachment_count(self, account: str, message_id: str) -> int | None:
        """Attachments listed in a saved text, or None if it cannot be read."""
        from .state import ENC_TAG, StateError, decrypt_json

        try:
            data = json.loads(self.path(account, message_id).read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("enc") == ENC_TAG:
                if not self.passphrase:
                    return None
                data = decrypt_json(data, self.passphrase)
            return len(data["attachments"])
        except (OSError, ValueError, KeyError, TypeError, StateError):
            return None

    def put(self, account: str, message_id: str, body: dict) -> None:
        path = self.path(account, message_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = self.sealer.seal_json(body) if self.sealer else body
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

    def prune(self, keep: dict[str, set[str]]) -> int:
        """Delete text files of messages no longer in the inbox, for accounts listed in keep."""
        removed = 0
        for account, ids in keep.items():
            folder = self.root / account
            if not folder.exists():
                continue
            for f in folder.glob("*.json"):
                if f.stem not in ids:
                    f.unlink()
                    removed += 1
        return removed


class FileStore:
    """Attachments the owner fetched: files/<account>/<message id>/ with a manifest."""

    def __init__(self, state_dir: Path, sealer=None):
        self.root = state_dir / "files"
        self.sealer = sealer

    def folder(self, account: str, message_id: str) -> Path:
        return self.root / account / message_id

    def write(self, account: str, message_id: str, index: int, name: str, mime: str, data: bytes) -> dict:
        folder = self.folder(account, message_id)
        folder.mkdir(parents=True, exist_ok=True)
        fname = f"{index:02d}-{safe_filename(name)}"
        if self.sealer:
            fname += ".enc.json"
            (folder / fname).write_text(json.dumps(self.sealer.seal_bytes(data)) + "\n", encoding="utf-8")
        else:
            (folder / fname).write_bytes(data)
        return {"name": safe_filename(name), "mime": mime, "size": len(data), "file": fname, "encrypted": bool(self.sealer)}

    def write_manifest(self, account: str, message_id: str, manifest: dict) -> None:
        folder = self.folder(account, message_id)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    def prune(self, keep: dict[str, set[str]], now: datetime, days: int = FILES_KEEP_DAYS) -> int:
        """Remove fetched files after `days`, or once their message has left the inbox."""
        removed = 0
        cutoff = now - timedelta(days=days)
        for account, ids in keep.items():
            base = self.root / account
            if not base.exists():
                continue
            for folder in base.iterdir():
                if not folder.is_dir():
                    continue
                fetched = None
                try:
                    fetched = datetime.fromisoformat(
                        json.loads((folder / "manifest.json").read_text(encoding="utf-8"))["fetched_at"].replace("Z", "+00:00"))
                except (OSError, ValueError, KeyError, json.JSONDecodeError):
                    pass
                if folder.name not in ids or fetched is None or fetched < cutoff:
                    for f in folder.iterdir():
                        f.unlink()
                    folder.rmdir()
                    removed += 1
        return removed


def iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
