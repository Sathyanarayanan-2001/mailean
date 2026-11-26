"""Treat every email field as untrusted data.

Email subjects, senders and snippets are written by strangers. They reach two
places: the Claude prompt and the dashboard. This module makes them safe for
both: it removes control and bidi-override characters, caps length, and flags
text that looks like an attempt to give instructions to an AI.
"""

from __future__ import annotations

import html
import re
import unicodedata

# Bidi overrides can make text render in a different order than it is stored,
# which hides content from a human reviewer ("Trojan Source").
_BIDI = dict.fromkeys(map(ord, "‪‫‬‭‮⁦⁧⁨⁩‎‏"), None)
_WS = re.compile(r"\s+")
_URL = re.compile(r"\b(?:https?://|www\.)\S+", re.IGNORECASE)
_EMAIL = re.compile(r"^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$")

# Phrases seen in prompt-injection attempts. A hit does not block anything; it
# adds a "suspicious" flag so the dashboard can warn the reader.
_INJECTION_PATTERNS = [
    r"ignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|prompts?|rules)",
    r"disregard (?:all |any )?(?:the )?(?:previous|prior|above|system)",
    r"\byou are now\b",
    r"\b(?:system|developer) (?:prompt|message|instructions?)\b",
    r"\bnew instructions?\b",
    r"\bact as (?:an? )?(?:ai|assistant|admin|system)\b",
    r"</?\s*(?:system|assistant|instructions?|untrusted[_a-z0-9]*)\s*>",
    r"\b(?:classify|mark|label) (?:this|me) as\b",
    r"\bset (?:the )?priority to\b",
    r"\bjailbreak\b",
]
_INJECTION = re.compile("|".join(_INJECTION_PATTERNS), re.IGNORECASE)


def clean_text(value: object, limit: int) -> str:
    """Normalise untrusted text to one safe, bounded line."""
    if value is None:
        return ""
    text = str(value)
    # Gmail snippets arrive HTML-escaped (&amp;, &#39;); decode once so the UI
    # does not show entities, then rely on the UI's textContent for safety.
    text = html.unescape(text)
    text = unicodedata.normalize("NFKC", text).translate(_BIDI)
    text = "".join(ch if (ch.isprintable() or ch in " \t\n") else " " for ch in text)
    text = _WS.sub(" ", text).strip()
    if len(text) > limit:
        text = text[: max(0, limit - 1)].rstrip() + "…"
    return text


_CODE_CONTEXT = re.compile(r"\b(?:otp|one[- ]time|passcode|password|pin|verification|security code|login code|code)\b", re.IGNORECASE)
_CODE = re.compile(r"\b\d{4,8}\b")


def redact_codes(text: str) -> str:
    """Hide 4-8 digit numbers in text that talks about codes, so OTPs never land in git."""
    if text and _CODE_CONTEXT.search(text):
        return _CODE.sub("••••", text)
    return text


def strip_urls(text: str) -> str:
    """Remove links from model-written summaries so a phishing URL cannot be echoed."""
    return _WS.sub(" ", _URL.sub("[link]", text)).strip()


def looks_like_injection(*texts: str) -> bool:
    return any(_INJECTION.search(t or "") for t in texts)


def is_valid_email(value: str) -> bool:
    return bool(value) and len(value) <= 254 and bool(_EMAIL.match(value))


def parse_from_header(raw: str) -> tuple[str, str]:
    """Split 'Name <addr@x.com>' into (name, addr). Never raises."""
    raw = clean_text(raw, 300)
    match = re.match(r'^\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*$', raw)
    if match:
        name, addr = match.group(1).strip(), match.group(2).strip().lower()
    else:
        name, addr = "", raw.strip().strip("<>").lower()
    if not is_valid_email(addr):
        addr = ""
    if not name:
        name = addr.split("@")[0] if addr else "(unknown sender)"
    return clean_text(name, 80), addr
