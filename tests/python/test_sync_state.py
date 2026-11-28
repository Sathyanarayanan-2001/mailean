"""End-to-end sync against the in-memory Gmail, state encryption, and the OAuth helper."""

import base64
import hashlib
import json
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

import pytest

from agent.classify import classify_all
from agent.config import Account, Settings, parse_accounts_secret
from agent.gmail import AuthError
from agent.state import StateError, decrypt_json, encrypt_json, read_state, write_state
from agent.sync_inbox import cleanup_candidates, sort_rows, sync
from fakes import FakeGmail, FakeMessage
import setup_oauth

NOW = datetime(2026, 11, 26, 3, 0, tzinfo=timezone.utc)
MS = int(NOW.timestamp() * 1000)
DAY = 86_400_000


def settings(tmp: Path, accounts=("account_1",), passphrase=None) -> Settings:
    accts = tuple(Account(a, a.title(), f"{a}@x.test", "r") for a in accounts)
    return Settings("cid", "sec", accts, "in:inbox", 300, "m", None, passphrase, tmp)


def inbox() -> FakeGmail:
    return FakeGmail("me@x.test", [
        FakeMessage("aaaaaa1", "tttttt1", "Asha <asha@acme.test>", "Can you review?", "please", MS - DAY),
        FakeMessage("aaaaaa2", "tttttt1", "Asha <asha@acme.test>", "Re: Can you review?", "ping", MS - 3600_000),
        FakeMessage("bbbbbb1", "bbbbbb1", "Shop <offers@shop.test>", "50% off", "sale", MS - 40 * DAY,
                    ["INBOX", "CATEGORY_PROMOTIONS"], "<https://shop.test/u>"),
        FakeMessage("bbbbbb2", "bbbbbb2", "Shop <offers@shop.test>", "Deal", "sale", MS - 2 * DAY,
                    ["INBOX", "CATEGORY_PROMOTIONS"]),
        FakeMessage("cccccc1", "cccccc1", "Bank <alerts@bank.test>", "Rs. 1,23,456.78 debited", "txn ref 627153940211", MS - 5 * DAY),
        FakeMessage("zzzzzz1", "zzzzzz1", "Old <x@y.test>", "Archived", "x", MS, ["CATEGORY_UPDATES"]),  # not in inbox
    ])


def rules(emails):
    return classify_all(emails, None, "rules")


def test_sync_groups_threads_and_writes_state(tmp_path):
    g = inbox()
    state = sync(settings(tmp_path), gmail_factory=lambda a: g, classify=rules, now=NOW)
    keys = [m["key"] for m in state["messages"]]
    assert len(keys) == 4                                       # 5 inbox messages, 2 share a thread
    thread = next(m for m in state["messages"] if m["thread_id"] == "tttttt1")
    assert thread["id"] == "aaaaaa2" and thread["message_ids"] == ["aaaaaa1", "aaaaaa2"]
    bank = next(m for m in state["messages"] if m["id"] == "cccccc1")
    assert bank["amount_paise"] == 12345678 and bank["group"] == "receipts_finance"
    assert all("snippet" not in m for m in state["messages"])  # snippets stay out by default
    assert sum(gr["count"] for gr in state["groups"]) == 4
    on_disk = json.loads((tmp_path / "inbox.json").read_text())
    assert on_disk == state


def test_second_run_reuses_triage_and_classifies_only_new(tmp_path):
    g = inbox()
    calls = []

    def counting(emails):
        calls.append(len(emails))
        return rules(emails)

    sync(settings(tmp_path), gmail_factory=lambda a: g, classify=counting, now=NOW)
    g.messages["dddddd1"] = FakeMessage("dddddd1", "dddddd1", "New <n@x.test>", "Hi", "x", MS)
    state = sync(settings(tmp_path), gmail_factory=lambda a: g, classify=counting, now=NOW)
    assert calls == [4, 1] and state["classifier"]["cached"] == 4


def test_failed_account_keeps_previous_rows_marked_stale(tmp_path):
    g = inbox()
    sync(settings(tmp_path), gmail_factory=lambda a: g, classify=rules, now=NOW)

    def broken(acct):
        raise AuthError("Google refused the saved sign-in (invalid_grant).")

    state = sync(settings(tmp_path), gmail_factory=broken, classify=rules, now=NOW)
    assert state["accounts"][0]["error"].startswith("Google refused")
    assert len(state["messages"]) == 4 and all(m.get("stale") for m in state["messages"])


def test_cleanup_candidates_and_sort_are_deterministic(tmp_path):
    g = inbox()
    state = sync(settings(tmp_path), gmail_factory=lambda a: g, classify=rules, now=NOW)
    shop = [c for c in state["cleanup"] if c["sender_email"] == "offers@shop.test"]
    assert shop and shop[0]["count"] == 2 and shop[0]["max_age_days"] == 40
    rows = [dict(id=i, priority=p, date=d, sender_name=n) for i, p, d, n in
            [("a", 3, "2026-11-01", "Zed"), ("b", 3, "2026-11-01", "amy"), ("c", 5, "2026-10-01", "x"), ("d", 3, "2026-11-02", "m")]]
    assert [r["id"] for r in sort_rows(rows)] == ["c", "d", "b", "a"]   # priority, date desc, name, id


def test_encrypted_state_round_trip(tmp_path):
    state = {"schema": 1, "messages": [{"subject": "Secret ₹"}]}
    write_state(tmp_path / "inbox.json", state, "correct horse battery")
    raw = json.loads((tmp_path / "inbox.json").read_text())
    assert raw["enc"] == "mailean-aesgcm-v1" and "Secret" not in json.dumps(raw)
    assert read_state(tmp_path / "inbox.json", "correct horse battery") == state
    with pytest.raises(StateError, match="Wrong"):
        read_state(tmp_path / "inbox.json", "wrong passphrase!!")
    with pytest.raises(StateError, match="not set"):
        read_state(tmp_path / "inbox.json", None)


def test_crypto_fixture_for_js_cross_check():
    """Write a fixed-salt blob; tests/js/crypto.test.mjs decrypts it with WebCrypto (second method)."""
    blob = encrypt_json({"hello": "world", "amount_paise": 12345678}, "fixture passphrase 1",
                        salt=bytes(range(16)), iv=bytes(range(12)))
    path = Path(__file__).resolve().parents[1] / "fixtures" / "encrypted-state.json"
    path.write_text(json.dumps(blob, indent=1) + "\n", encoding="utf-8")
    assert decrypt_json(blob, "fixture passphrase 1")["amount_paise"] == 12345678


def test_setup_oauth_pkce_url_and_secret_format():
    verifier, challenge = setup_oauth.pkce_pair()
    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    assert challenge == expected and 43 <= len(verifier) <= 128
    url = setup_oauth.build_auth_url("id.apps.googleusercontent.com", "http://127.0.0.1:5000/", challenge, "st8")
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    assert q["scope"] == ["https://www.googleapis.com/auth/gmail.modify"]
    assert q["access_type"] == ["offline"] and q["prompt"] == ["consent"] and q["code_challenge_method"] == ["S256"]
    value = setup_oauth.assemble("id.apps.googleusercontent.com", "sec",
                                 [{"id": "account_1", "label": "Personal", "email": "a@x.test", "refresh_token": "r"}])
    # Second method: the agent's own parser accepts exactly what the helper prints.
    assert parse_accounts_secret(value)[2][0].label == "Personal"
    with pytest.raises(ValueError):
        setup_oauth.assemble("id", "s", [{"id": "account_1"}, {"id": "account_1"}])


def test_gmail_api_disabled_error_says_how_to_fix(tmp_path):
    """The real failure from the first private run: Gmail API off in the client's project."""
    from agent.http import HttpError

    msg = ("Gmail API has not been used in project 931236531062 before or it is disabled. Enable it by visiting "
           "https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=931236531062 then retry.")

    class Disabled:
        def profile(self):
            raise HttpError(403, msg, "accessNotConfigured")

    state = sync(settings(tmp_path), gmail_factory=lambda a: Disabled(), classify=rules, now=NOW)
    err = state["accounts"][0]["error"]
    assert "Gmail API is turned off" in err and "931236531062" in err and "Enable" in err


def test_explain_api_error_cases():
    from agent.gmail import explain_api_error
    from agent.http import HttpError

    assert "Gmail access" in explain_api_error(HttpError(403, "x", "insufficientPermissions"))
    assert "rate limit" in explain_api_error(HttpError(429, "x", "rateLimitExceeded"))
    assert "could not be reached (HTTP 503)" in explain_api_error(HttpError(503, "x"))
    assert "could not be reached (HTTP no response)" in explain_api_error(HttpError(0, "network error"))
    assert explain_api_error(HttpError(400, "Bad label", "invalidArgument")) == "Gmail API error 400 (invalidArgument): Bad label"
