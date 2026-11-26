"""Command worker: apply the user's queued actions to Gmail and write an audit record.

Run:  COMMANDS_PAYLOAD='{"v":1,...}' python -m agent.execute_commands
The payload arrives through an environment variable, never through the shell
command line, so its text can never be run as code.

No language model is called here. Email content cannot influence what runs;
only the validated payload can.
Big-O: k commands touching m ids in total: O(m / 1000) batchModify calls,
O(m) trash calls, O(m) memory.
"""

from __future__ import annotations

import ipaddress
import os
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    __package__ = "agent"

from agent import http
from agent.commands import BULK_TRASH_CAP, Command, PayloadError, parse_payload
from agent.config import Account, ConfigError, Settings, load_settings
from agent.gmail import AuthError, Gmail, headers_of, refresh_access_token
from agent.http import HttpError
from agent.state import write_audit


def iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def safe_unsubscribe_url(url: str | None) -> str | None:
    """Only public https hosts; never localhost or raw IPs (no request to internal services)."""
    if not url or len(url) > 2000:
        return None
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host or parts.username or parts.password:
        return None
    if host in ("localhost",) or host.endswith((".localhost", ".local", ".internal")):
        return None
    try:
        ipaddress.ip_address(host)
        return None  # literal IPs are refused outright
    except ValueError:
        pass
    if "." not in host:
        return None
    return url


def one_click_unsubscribe(gmail: Gmail, message_id: str) -> str:
    """RFC 8058 one-click unsubscribe, using headers read fresh from Gmail."""
    msg = gmail.get_metadata(message_id)
    hdrs = headers_of(msg)
    post = hdrs.get("list-unsubscribe-post", "").lower()
    target = None
    for part in hdrs.get("list-unsubscribe", "").split(","):
        cand = part.strip().strip("<>").strip()
        if cand.lower().startswith("https://"):
            target = safe_unsubscribe_url(cand)
            break
    if not target or "list-unsubscribe=one-click" not in post:
        return "manual"  # the dashboard shows the sender's own link instead
    try:
        http.request("POST", target, form={"List-Unsubscribe": "One-Click"}, timeout=10, retries=1,
                     headers={"Accept": "*/*"}, allow_redirects=False)
    except HttpError as exc:
        # Some senders answer the POST with a redirect to a "you are unsubscribed"
        # page. We do not follow it, but the POST itself was accepted.
        if not 300 <= exc.status < 400:
            raise
    return "done"


def run_command(gmail: Gmail, cmd: Command, label_cache: dict[str, str]) -> dict:
    result = {"account": cmd.account, "op": cmd.op, "requested": len(cmd.ids), "succeeded": 0,
              "failed": 0, "manual": 0, "errors": []}
    if cmd.label:
        result["label"] = cmd.label
    if cmd.sender:
        result["sender"] = cmd.sender

    def fail(n: int, exc: Exception) -> None:
        result["failed"] += n
        msg = f"{exc.__class__.__name__}: {exc}"[:200]
        if msg not in result["errors"] and len(result["errors"]) < 5:
            result["errors"].append(msg)

    modify = {
        "archive": ([], ["INBOX"]),
        "mark_read": ([], ["UNREAD"]),
        "star": (["STARRED"], []),
    }
    if cmd.op in modify:
        add, remove = modify[cmd.op]
        try:
            result["succeeded"] = gmail.batch_modify(list(cmd.ids), add, remove)
        except HttpError as exc:
            fail(len(cmd.ids), exc)
    elif cmd.op == "move_to_label":
        try:
            label_id = gmail.ensure_label(cmd.label or "", label_cache)
            result["succeeded"] = gmail.batch_modify(list(cmd.ids), [label_id], ["INBOX"])
        except HttpError as exc:
            fail(len(cmd.ids), exc)
    elif cmd.op in ("delete", "bulk_trash_sender"):
        ids = list(cmd.ids)
        if cmd.op == "bulk_trash_sender":
            # Quoted address; -is:starred protects anything the user starred.
            query = f'from:"{cmd.sender}" -in:trash -is:starred'
            try:
                ids = [mid for mid, _ in gmail.list_message_ids(query, BULK_TRASH_CAP)]
            except HttpError as exc:
                fail(1, exc)
                return result
            result["requested"] = len(ids)
        for mid in ids:
            try:
                gmail.trash(mid)
                result["succeeded"] += 1
            except HttpError as exc:
                if exc.status == 404:  # already gone: the goal is met
                    result["succeeded"] += 1
                else:
                    fail(1, exc)
    elif cmd.op == "unsubscribe":
        for mid in cmd.ids:
            try:
                outcome = one_click_unsubscribe(gmail, mid)
                result["succeeded" if outcome == "done" else "manual"] += 1
            except HttpError as exc:
                fail(1, exc)
    return result


def execute(settings: Settings, raw_payload: str, *, gmail_factory: Callable[[Account], Gmail] | None = None,
            started_at: str | None = None) -> dict:
    started = started_at or iso_now()
    record: dict = {"batch_id": None, "started_at": started, "finished_at": None, "status": "rejected",
                    "results": [], "summary": {}}
    try:
        batch_id, commands = parse_payload(raw_payload, {a.id for a in settings.accounts})
    except PayloadError as exc:
        record["error"] = str(exc)
        stamp = started.replace("-", "").replace(":", "").replace("T", "-").rstrip("Z")
        record["batch_id"] = f"b-{stamp}-rejected"
        record["finished_at"] = iso_now()
        write_audit(settings.audit_dir, record)
        raise
    record["batch_id"] = batch_id

    def default_factory(acct: Account) -> Gmail:
        return Gmail(refresh_access_token(settings.client_id, settings.client_secret, acct.refresh_token))

    factory = gmail_factory or default_factory
    clients: dict[str, Gmail | Exception] = {}
    label_caches: dict[str, dict[str, str]] = {}
    for cmd in commands:
        if cmd.account not in clients:
            try:
                g = factory(settings.account(cmd.account))  # type: ignore[arg-type]
                clients[cmd.account] = g
                label_caches[cmd.account] = g.labels() if any(c.op == "move_to_label" and c.account == cmd.account for c in commands) else {}
            except (AuthError, HttpError) as exc:
                clients[cmd.account] = exc
        client = clients[cmd.account]
        if isinstance(client, Exception):
            record["results"].append({"account": cmd.account, "op": cmd.op, "requested": len(cmd.ids),
                                      "succeeded": 0, "failed": max(1, len(cmd.ids)), "manual": 0,
                                      "errors": [str(client)[:300]]})
            continue
        record["results"].append(run_command(client, cmd, label_caches[cmd.account]))
    totals = {k: sum(r[k] for r in record["results"]) for k in ("requested", "succeeded", "failed", "manual")}
    record["summary"] = totals
    record["status"] = "ok" if totals["failed"] == 0 else ("failed" if totals["succeeded"] == 0 else "partial")
    record["finished_at"] = iso_now()
    write_audit(settings.audit_dir, record)
    print(f"Batch {batch_id}: {totals['succeeded']} done, {totals['failed']} failed, "
          f"{totals['manual']} need a manual unsubscribe.")
    return record


def main() -> int:
    try:
        settings = load_settings()
        record = execute(settings, os.environ.get("COMMANDS_PAYLOAD", ""))
    except (ConfigError, PayloadError) as exc:
        print(f"::error::{exc}")
        return 2
    return 0 if record["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
