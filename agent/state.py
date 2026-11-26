"""Read and write the private state files, optionally encrypted.

Plain JSON is safe because the data repository is private. Setting the
MAILEAN_STATE_PASSPHRASE secret adds AES-256-GCM encryption as a second line of
defence: if the repository is ever made public by mistake, summaries stay
unreadable. The dashboard decrypts with the same passphrase in the browser.
"""

from __future__ import annotations

import base64
import json
import os
import tempfile
from pathlib import Path
from typing import Any

ENC_TAG = "mailean-aesgcm-v1"
PBKDF2_ITERATIONS = 600_000
SCHEMA = 1


class StateError(Exception):
    pass


def _derive_key(passphrase: str, salt: bytes, iterations: int) -> bytes:
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    except ImportError:
        # Never fall back to writing plain text when the user asked for encryption.
        raise StateError(
            "MAILEAN_STATE_PASSPHRASE is set but the 'cryptography' package is missing. "
            "Install requirements.txt, or remove the passphrase secret to store plain JSON."
        ) from None
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(passphrase.encode("utf-8"))


def encrypt_json(obj: Any, passphrase: str, *, salt: bytes | None = None, iv: bytes | None = None) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    salt = salt or os.urandom(16)
    iv = iv or os.urandom(12)
    key = _derive_key(passphrase, salt, PBKDF2_ITERATIONS)
    plaintext = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ct = AESGCM(key).encrypt(iv, plaintext, ENC_TAG.encode("ascii"))
    b64 = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731
    return {"enc": ENC_TAG, "kdf": "pbkdf2-sha256", "iter": PBKDF2_ITERATIONS, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}


def decrypt_json(blob: dict, passphrase: str) -> Any:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    try:
        salt = base64.b64decode(blob["salt"])
        iv = base64.b64decode(blob["iv"])
        ct = base64.b64decode(blob["ct"])
        iterations = int(blob.get("iter", PBKDF2_ITERATIONS))
    except (KeyError, ValueError, TypeError):
        raise StateError("The encrypted state file is damaged.") from None
    key = _derive_key(passphrase, salt, iterations)
    try:
        plain = AESGCM(key).decrypt(iv, ct, ENC_TAG.encode("ascii"))
    except InvalidTag:
        raise StateError("Wrong MAILEAN_STATE_PASSPHRASE: the state file could not be decrypted.") from None
    return json.loads(plain.decode("utf-8"))


def atomic_write_text(path: Path, text: str) -> None:
    """Write via a temp file and rename, so a crash never leaves half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def write_state(path: Path, state: dict, passphrase: str | None) -> None:
    payload: Any = encrypt_json(state, passphrase) if passphrase else state
    atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=False) + "\n")


def read_state(path: Path, passphrase: str | None) -> dict | None:
    """Previous state, or None when there is none yet. Raises StateError on a real problem."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print(f"Previous state at {path.name} is not valid JSON; starting fresh.")
        return None
    if isinstance(data, dict) and data.get("enc") == ENC_TAG:
        if not passphrase:
            raise StateError("The state file is encrypted but MAILEAN_STATE_PASSPHRASE is not set.")
        data = decrypt_json(data, passphrase)
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        print("Previous state has an unknown format; starting fresh.")
        return None
    return data


def write_audit(audit_dir: Path, record: dict) -> Path:
    # The folder year comes from the batch id (made by the browser) rather than the
    # run's start time, so a batch queued at 23:59:59 UTC on 31 December and run after
    # midnight is still found where the dashboard looks for it.
    bid = str(record.get("batch_id", ""))
    year = bid[2:6] if bid[:2] == "b-" and bid[2:6].isdigit() else str(record.get("started_at", "0000"))[:4]
    path = audit_dir / year / f"{record['batch_id']}.json"
    atomic_write_text(path, json.dumps(record, ensure_ascii=False, indent=1) + "\n")
    return path


def recent_audit(audit_dir: Path, limit: int = 50) -> list[dict]:
    """Newest audit summaries for the dashboard's Activity tab. O(f log f) for f files."""
    if not audit_dir.exists():
        return []
    # Batch ids start with a UTC timestamp (b-YYYYMMDD-HHMMSS-…), so name order is
    # time order. File mtimes are useless here: a git checkout resets them all.
    files = sorted(audit_dir.glob("*/*.json"), key=lambda p: (p.parent.name, p.name), reverse=True)
    out = []
    for p in files[:limit]:
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        out.append({k: rec.get(k) for k in ("batch_id", "started_at", "finished_at", "status", "summary")})
    out.sort(key=lambda r: (str(r.get("started_at") or ""), str(r.get("batch_id") or "")), reverse=True)
    return out
