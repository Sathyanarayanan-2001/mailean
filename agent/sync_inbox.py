"""Scheduled sync worker: fetch inbox metadata, triage it, write the private state file.

Run:  python -m agent.sync_inbox
Big-O: n messages per account. Fetch O(n) API calls (paced), classification
O(n / 25) model calls for new messages only, grouping O(n) with hash maps,
sorting O(n log n). Memory O(n).
"""

from __future__ import annotations

import concurrent.futures as cf
import sys
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable

if __package__ in (None, ""):  # allow "python agent/sync_inbox.py" as well as "-m"
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    __package__ = "agent"

from agent import VERSION
from agent.bodies import BODY_MAX_CHARS, BodyStore, FileStore, extract, message_id_header
from agent.classify import ClassifyReport, EmailInput, Triage, classify_all, make_client
from agent.config import GROUPS, Account, ConfigError, Settings, load_settings
from agent.gmail import AuthError, Gmail, explain_api_error, headers_of, refresh_access_token
from agent.http import HttpError
from agent.sanitize import clean_text, parse_from_header, redact_codes
from agent.state import SCHEMA, Sealer, StateError, read_state, recent_audit, write_state

FETCH_WORKERS = 6
CLEANUP_MIN_COUNT = 3
CLEANUP_OLD_DAYS = 30
CLEANUP_GROUPS = ("promotions_spam", "newsletters_reading", "low_priority")


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def message_time(msg: dict, hdrs: dict[str, str]) -> datetime:
    """Gmail internalDate (ms) is reliable; the Date header is a fallback."""
    raw = str(msg.get("internalDate", ""))
    if raw.isdigit():
        return datetime.fromtimestamp(int(raw) / 1000, tz=timezone.utc)
    try:
        dt = parsedate_to_datetime(hdrs.get("date", ""))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError, IndexError):
        return datetime.now(timezone.utc)


def parse_unsubscribe(hdrs: dict[str, str]) -> dict[str, Any] | None:
    raw = hdrs.get("list-unsubscribe", "")
    if not raw:
        return None
    url = mailto = None
    for part in raw.split(","):
        target = part.strip().strip("<>").strip()
        low = target.lower()
        if low.startswith("https://") and url is None and len(target) <= 2000:
            url = clean_text(target, 2000)
        elif low.startswith("mailto:") and mailto is None and len(target) <= 500:
            mailto = clean_text(target, 500)
    if not url and not mailto:
        return None
    one_click = bool(url) and "list-unsubscribe=one-click" in hdrs.get("list-unsubscribe-post", "").lower()
    return {"one_click": one_click, "url": url, "mailto": mailto}


def fetch_account(gmail: Gmail, query: str, limit: int, now: datetime, *, account: str = "",
                  bodies: BodyStore | None = None, known: dict[str, int] | None = None) -> list[dict]:
    """Metadata for up to `limit` messages, fetched in parallel under the quota pacer.

    With a BodyStore, a message seen for the first time is fetched in full (same
    quota cost) and its text saved; messages already saved are fetched as metadata
    only. `known` maps message id -> attachment count from the previous run.
    """
    pairs = gmail.list_message_ids(query, limit)
    out: list[dict] = []
    known = known or {}

    def one(pair: tuple[str, str]) -> dict | None:
        mid, tid = pair
        attachments = known.get(mid)
        try:
            if bodies is not None and (mid not in known or not bodies.has(account, mid)):
                msg = gmail.get_full(mid)
                body = extract(msg, fetch_attachment=lambda aid: gmail.get_attachment(mid, aid))
                bodies.put(account, mid, body)
                attachments = len(body["attachments"])
            else:
                msg = gmail.get_metadata(mid)
        except HttpError as exc:
            if exc.status == 404:  # deleted between list and get
                return None
            raise
        hdrs = headers_of(msg)
        name, addr = parse_from_header(hdrs.get("from", ""))
        when = message_time(msg, hdrs)
        labels = [str(l) for l in msg.get("labelIds", []) or []]
        return {
            "id": mid,
            "thread_id": tid,
            "sender_name": name,
            "sender_email": addr,
            "subject": redact_codes(clean_text(hdrs.get("subject", ""), 200)) or "(no subject)",
            "snippet": redact_codes(clean_text(msg.get("snippet", ""), 300)),
            "date": iso(when),
            "age_days": max(0, (now - when).days),
            "labels": labels,
            "unread": "UNREAD" in labels,
            "starred": "STARRED" in labels,
            "unsubscribe": parse_unsubscribe(hdrs),
            "message_id_header": message_id_header({k.lower(): v for k, v in hdrs.items()}),
            "attachments": attachments,
            "has_body": bodies is not None and attachments is not None,
        }

    with cf.ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        for item in pool.map(one, pairs):
            if item:
                out.append(item)
    return out


def group_threads(account_id: str, messages: list[dict]) -> list[dict]:
    """One row per conversation: newest message represents it; actions cover all its ids. O(n)."""
    by_thread: dict[str, dict] = {}
    for m in messages:
        row = by_thread.get(m["thread_id"])
        if row is None:
            row = {**m, "account": account_id, "message_ids": [m["id"]], "attachments_total": m.get("attachments")}
            by_thread[m["thread_id"]] = row
            continue
        row["message_ids"].append(m["id"])
        if m.get("attachments") is not None:
            row["attachments_total"] = (row.get("attachments_total") or 0) + m["attachments"]
        row["unread"] = row["unread"] or m["unread"]
        row["starred"] = row["starred"] or m["starred"]
        if (m["date"], m["id"]) > (row["date"], row["id"]):
            keep_ids, unread, starred, total = row["message_ids"], row["unread"], row["starred"], row.get("attachments_total")
            row.update({**m, "account": account_id})
            row.update({"message_ids": keep_ids, "unread": unread, "starred": starred, "attachments_total": total})
    for row in by_thread.values():
        row["message_ids"].sort()
    return list(by_thread.values())


def cleanup_candidates(rows: list[dict]) -> list[dict]:
    """Senders worth bulk-cleaning: many messages, or old ones, in low-value groups. O(n log n)."""
    agg: dict[tuple[str, str], dict] = {}
    for r in rows:
        if r["group"] not in CLEANUP_GROUPS or not r["sender_email"]:
            continue
        key = (r["account"], r["sender_email"])
        a = agg.setdefault(key, {"account": r["account"], "sender_email": r["sender_email"],
                                 "sender_name": r["sender_name"], "count": 0, "oldest": r["date"],
                                 "newest": r["date"], "max_age_days": 0, "groups": {}, "unsubscribe": None,
                                 "message_ids": []})
        a["count"] += len(r["message_ids"])
        a["oldest"] = min(a["oldest"], r["date"])
        a["newest"] = max(a["newest"], r["date"])
        a["max_age_days"] = max(a["max_age_days"], r["age_days"])
        a["groups"][r["group"]] = a["groups"].get(r["group"], 0) + 1
        a["message_ids"].extend(r["message_ids"])
        if r.get("unsubscribe") and not a["unsubscribe"]:
            a["unsubscribe"] = {"message_id": r["id"], **r["unsubscribe"]}
    out = []
    for a in agg.values():
        if a["count"] >= CLEANUP_MIN_COUNT or a["max_age_days"] >= CLEANUP_OLD_DAYS:
            # Most common group; ties broken by GROUPS order so output is deterministic.
            order = list(GROUPS)
            a["group"] = max(a["groups"], key=lambda g: (a["groups"][g], -order.index(g)))
            del a["groups"]
            a["message_ids"].sort()
            out.append(a)
    out.sort(key=lambda a: (-a["count"], a["oldest"], a["sender_email"], a["account"]))
    return out


def sort_rows(rows: list[dict]) -> list[dict]:
    """Stable sort: priority desc, then date desc, then sender name, then id. O(n log n)."""
    rows = sorted(rows, key=lambda r: (r["sender_name"].lower(), r["id"]))
    rows = sorted(rows, key=lambda r: r["date"], reverse=True)
    return sorted(rows, key=lambda r: r["priority"], reverse=True)


def build_state(settings: Settings, fetched: dict[str, list[dict]], account_info: list[dict],
                previous: dict | None, classify: Callable[[list[EmailInput]], tuple[dict[str, Triage], ClassifyReport]],
                now: datetime, body_index: dict[str, dict[str, int]] | None = None) -> dict:
    # Reuse earlier triage for messages we have already classified: saves API cost
    # and keeps suggestions stable between runs. Lookup is a hash map: O(1) per id.
    cache: dict[str, dict] = {}
    for m in (previous or {}).get("messages", []):
        cache[f"{m.get('account')}:{m.get('id')}"] = m
    rows: list[dict] = []
    to_classify: list[EmailInput] = []
    for acct_id, msgs in fetched.items():
        for row in group_threads(acct_id, msgs):
            key = f"{acct_id}:{row['id']}"
            row["key"] = key
            rows.append(row)
            if key not in cache or not cache[key].get("group"):
                to_classify.append(EmailInput(
                    key=key, sender_name=row["sender_name"], sender_email=row["sender_email"],
                    subject=row["subject"], snippet=row["snippet"], labels=row["labels"],
                    has_unsubscribe=bool(row["unsubscribe"]), age_days=row["age_days"], unread=row["unread"]))
    results, report = classify(to_classify)
    triage_fields = ("group", "priority", "summary", "suggested_action", "suggested_label",
                     "amount_paise", "currency", "reference", "suspicious", "source")
    for row in rows:
        if row["key"] in results:
            row.update(results[row["key"]].to_state())
        else:
            prev = cache[row["key"]]
            row.update({f: prev.get(f) for f in triage_fields})
    # Accounts that failed this run keep their previous rows, marked stale, so a
    # temporary Google outage does not empty the dashboard.
    failed = {a["id"] for a in account_info if a.get("error")}
    for m in (previous or {}).get("messages", []):
        if m.get("account") in failed:
            rows.append({**m, "stale": True})
    rows = sort_rows(rows)
    for row in rows:
        row["attachments"] = row.pop("attachments_total", row.get("attachments"))
    public_fields = ("key", "id", "thread_id", "account", "message_ids", "sender_name", "sender_email",
                     "subject", "date", "age_days", "unread", "starred", "unsubscribe", "message_id_header",
                     "attachments", "has_body", *triage_fields)
    if settings.store_snippets:
        public_fields += ("snippet",)
    messages = [{f: r.get(f) for f in public_fields} | ({"stale": True} if r.get("stale") else {}) for r in rows]
    counts = {g: 0 for g in GROUPS}
    for m in messages:
        if m["group"] in counts:
            counts[m["group"]] += 1
    return {
        "schema": SCHEMA,
        "app": "mailean",
        "agent_version": VERSION,
        "generated_at": iso(now),
        "query": settings.query,
        "classifier": {"model": settings.model if report.llm else "rules", "llm": report.llm, "rules": report.rules,
                       "cached": len(rows) - len(to_classify), "failed_batches": report.failed_batches},
        "accounts": account_info,
        "groups": [{"key": k, "name": v, "count": counts[k]} for k, v in GROUPS.items()],
        "messages": messages,
        "cleanup": cleanup_candidates(messages),
        "audit": recent_audit(settings.audit_dir),
        "bodies": {"stored": settings.store_bodies, "encrypted": bool(settings.state_passphrase), "max_chars": BODY_MAX_CHARS},
        "body_index": body_index or {},
    }


def sync(settings: Settings, *, gmail_factory: Callable[[Account], Gmail] | None = None,
         classify: Callable | None = None, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    previous = read_state(settings.state_file, settings.state_passphrase)

    def default_factory(acct: Account) -> Gmail:
        return Gmail(refresh_access_token(settings.client_id, settings.client_secret, acct.refresh_token))

    factory = gmail_factory or default_factory
    if classify is None:
        client = make_client(settings.anthropic_key)
        classify = lambda emails: classify_all(emails, client, settings.model)  # noqa: E731
    fetched: dict[str, list[dict]] = {}
    info: list[dict] = []
    sealer = Sealer(settings.state_passphrase) if settings.state_passphrase else None
    bodies = BodyStore(settings.state_dir, sealer) if settings.store_bodies else None
    prev_index: dict[str, dict[str, int]] = (previous or {}).get("body_index") or {}
    body_index: dict[str, dict[str, int]] = {}
    for acct in settings.accounts:
        entry = {"id": acct.id, "label": acct.label, "email": acct.email, "fetched": 0,
                 "inbox_total": None, "error": None, "synced_at": iso(now)}
        try:
            gmail = factory(acct)
            profile = gmail.profile()
            entry["email"] = clean_text(profile.get("emailAddress", acct.email), 254)
            fetched[acct.id] = fetch_account(gmail, settings.query, settings.max_per_account, now, account=acct.id,
                                             bodies=bodies, known=prev_index.get(acct.id) or {})
            entry["fetched"] = len(fetched[acct.id])
            if bodies is not None:
                body_index[acct.id] = {m["id"]: m["attachments"] for m in fetched[acct.id] if m["attachments"] is not None}
        except AuthError as exc:
            entry["error"] = str(exc)
        except HttpError as exc:
            entry["error"] = explain_api_error(exc)
        if entry["error"]:
            print(f"[{acct.id}] {entry['error']}")
            prev_acct = next((a for a in (previous or {}).get("accounts", []) if a.get("id") == acct.id), None)
            if prev_acct:
                entry["synced_at"] = prev_acct.get("synced_at")
        info.append(entry)
        if entry["error"] and acct.id in prev_index:
            body_index[acct.id] = prev_index[acct.id]  # keep a failed account's saved texts for next time
    # Keep texts and fetched files only for messages still in the inbox.
    keep = {a: {m["id"] for m in msgs} for a, msgs in fetched.items()}
    if bodies is not None:
        bodies.prune(keep)
    else:
        BodyStore(settings.state_dir).prune({a.id: set() for a in settings.accounts})
    FileStore(settings.state_dir).prune(keep, now)
    state = build_state(settings, fetched, info, previous, classify, now, body_index)
    write_state(settings.state_file, state, settings.state_passphrase)
    c = state["classifier"]
    print(f"Wrote {len(state['messages'])} conversations from {len(info)} account(s); "
          f"classified {c['llm']} with Claude, {c['rules']} with rules, reused {c['cached']}.")
    return state


def main() -> int:
    try:
        settings = load_settings()
        state = sync(settings)
    except (ConfigError, StateError) as exc:
        print(f"::error::{exc}")
        return 2
    return 1 if all(a.get("error") for a in state["accounts"]) else 0


if __name__ == "__main__":
    sys.exit(main())
