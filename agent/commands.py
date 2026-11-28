"""Validate the command payload sent from the dashboard.

The payload is the only thing that can change a mailbox, so it is checked
strictly: known keys only, known operations only, ids and labels by pattern,
and size limits. Anything wrong is rejected with a message that says what to fix.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from .config import ACCOUNT_ID_RE
from .gmail import MESSAGE_ID_RE
from .sanitize import is_valid_email

OPS = ("delete", "archive", "move_to_label", "mark_read", "star", "bulk_trash_sender", "unsubscribe", "fetch_attachments")
BATCH_ID_RE = re.compile(r"^b-\d{8}-\d{6}-[a-z0-9]{4,12}$")
SYSTEM_LABELS = {"inbox", "spam", "trash", "unread", "starred", "important", "sent", "draft", "chat"}
MAX_PAYLOAD_CHARS = 65_000
MAX_COMMANDS = 200
MAX_IDS_TOTAL = 5_000
MAX_UNSUBSCRIBE = 50
MAX_FETCH = 5  # messages whose attachments one run may fetch
BULK_TRASH_CAP = 1_000


class PayloadError(ValueError):
    pass


@dataclass(frozen=True)
class Command:
    account: str
    op: str
    ids: tuple[str, ...] = ()
    label: str | None = None
    sender: str | None = None


def validate_label(label: object) -> str:
    if not isinstance(label, str):
        raise PayloadError("move_to_label needs a 'label' text value.")
    name = label.strip()
    if not 1 <= len(name) <= 100:
        raise PayloadError("Label names must be 1 to 100 characters long.")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in name):
        raise PayloadError("Label names cannot contain control characters.")
    if name.lower() in SYSTEM_LABELS or name.upper().startswith("CATEGORY_"):
        raise PayloadError(f"'{name}' is a Gmail system label; choose your own label name.")
    if "//" in name or name.startswith("/") or name.endswith("/"):
        raise PayloadError("Nested labels use single slashes between names, like Finance/Receipts.")
    return name


def parse_payload(raw: str, known_accounts: set[str]) -> tuple[str, list[Command]]:
    if not raw or not raw.strip():
        raise PayloadError("The command payload is empty.")
    if len(raw) > MAX_PAYLOAD_CHARS:
        raise PayloadError(f"The command payload is {len(raw):,} characters; the limit is {MAX_PAYLOAD_CHARS:,}. Send fewer commands per run.")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PayloadError(f"The command payload is not valid JSON (character {exc.pos}).") from None
    if not isinstance(data, dict) or set(data) - {"v", "batch_id", "commands"}:
        raise PayloadError("The payload must be an object with only v, batch_id and commands.")
    if data.get("v") != 1:
        raise PayloadError("Unsupported payload version; reload the dashboard and try again.")
    batch_id = data.get("batch_id")
    if not isinstance(batch_id, str) or not BATCH_ID_RE.match(batch_id):
        raise PayloadError("batch_id is missing or malformed.")
    items = data.get("commands")
    if not isinstance(items, list) or not items:
        raise PayloadError("The payload has no commands.")
    if len(items) > MAX_COMMANDS:
        raise PayloadError(f"Too many commands ({len(items)}); the limit per run is {MAX_COMMANDS}.")
    commands: list[Command] = []
    total_ids = 0
    for n, item in enumerate(items, start=1):
        where = f"Command {n}"
        if not isinstance(item, dict):
            raise PayloadError(f"{where} is not an object.")
        extra = set(item) - {"account", "op", "ids", "label", "sender"}
        if extra:
            raise PayloadError(f"{where} has unknown field(s): {', '.join(sorted(extra))}.")
        account, op = item.get("account"), item.get("op")
        if not isinstance(account, str) or not ACCOUNT_ID_RE.match(account):
            raise PayloadError(f"{where} has an invalid account id.")
        if account not in known_accounts:
            raise PayloadError(f"{where} targets account '{account}', which is not configured in MAILEAN_ACCOUNTS.")
        if op not in OPS:
            raise PayloadError(f"{where} has unknown op {op!r}. Allowed: {', '.join(OPS)}.")
        label = sender = None
        ids: tuple[str, ...] = ()
        if op == "bulk_trash_sender":
            sender = item.get("sender")
            if not isinstance(sender, str) or not is_valid_email(sender.strip().lower()):
                raise PayloadError(f"{where}: bulk_trash_sender needs a valid sender email address.")
            sender = sender.strip().lower()
        else:
            raw_ids = item.get("ids")
            if not isinstance(raw_ids, list) or not raw_ids:
                raise PayloadError(f"{where}: '{op}' needs a non-empty ids list.")
            bad = [i for i in raw_ids if not isinstance(i, str) or not MESSAGE_ID_RE.match(i)]
            if bad:
                raise PayloadError(f"{where}: {len(bad)} message id(s) are malformed.")
            ids = tuple(dict.fromkeys(raw_ids))  # de-duplicate, keep order
            if op == "unsubscribe" and len(ids) > MAX_UNSUBSCRIBE:
                raise PayloadError(f"{where}: unsubscribe is limited to {MAX_UNSUBSCRIBE} messages per run.")
            if op == "fetch_attachments" and len(ids) > MAX_FETCH:
                raise PayloadError(f"{where}: fetch_attachments is limited to {MAX_FETCH} messages per run.")
            total_ids += len(ids)
        if op == "move_to_label":
            label = validate_label(item.get("label"))
        elif item.get("label") not in (None, ""):
            raise PayloadError(f"{where}: 'label' is only allowed with move_to_label.")
        commands.append(Command(account, op, ids, label, sender))
    if total_ids > MAX_IDS_TOTAL:
        raise PayloadError(f"The payload touches {total_ids:,} messages; the limit per run is {MAX_IDS_TOTAL:,}.")
    return batch_id, commands
