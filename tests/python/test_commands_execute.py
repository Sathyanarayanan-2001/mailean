"""Command payload validation and execution against the in-memory Gmail."""

import json
from pathlib import Path

import pytest

from agent import http
from agent.commands import PayloadError, parse_payload
from agent.config import Account, Settings
from agent.execute_commands import execute, safe_unsubscribe_url
from agent.http import Response
from fakes import FakeGmail, FakeMessage

ACCTS = {"account_1", "account_2"}
BATCH = "b-20261126-084400-ab12cd"


def payload(*commands, batch=BATCH):
    return json.dumps({"v": 1, "batch_id": batch, "commands": list(commands)})


def test_valid_payload_dedupes_ids():
    bid, cmds = parse_payload(payload({"account": "account_1", "op": "archive", "ids": ["aaaaaa1", "aaaaaa1", "bbbbbb2"]}), ACCTS)
    assert bid == BATCH and cmds[0].ids == ("aaaaaa1", "bbbbbb2")


@pytest.mark.parametrize("cmd,needle", [
    ({"account": "account_9", "op": "archive", "ids": ["aaaaaa1"]}, "not configured"),
    ({"account": "account_1", "op": "forward", "ids": ["aaaaaa1"]}, "unknown op"),
    ({"account": "account_1", "op": "archive", "ids": ["../../x"]}, "malformed"),
    ({"account": "account_1", "op": "archive", "ids": []}, "non-empty"),
    ({"account": "account_1", "op": "archive", "ids": ["aaaaaa1"], "query": "in:anywhere"}, "unknown field"),
    ({"account": "account_1", "op": "move_to_label", "ids": ["aaaaaa1"], "label": "INBOX"}, "system label"),
    ({"account": "account_1", "op": "move_to_label", "ids": ["aaaaaa1"], "label": "a\nb"}, "control"),
    ({"account": "account_1", "op": "archive", "ids": ["aaaaaa1"], "label": "X"}, "only allowed"),
    ({"account": "account_1", "op": "bulk_trash_sender", "sender": 'x@y.com" OR in:anywhere'}, "valid sender"),
])
def test_payload_errors_say_what_to_fix(cmd, needle):
    with pytest.raises(PayloadError, match=needle):
        parse_payload(payload(cmd), ACCTS)


@pytest.mark.parametrize("raw,needle", [
    ("", "empty"), ("{", "not valid JSON"), ('{"v":2,"batch_id":"x","commands":[]}', "version"),
    (payload({"account": "account_1", "op": "archive", "ids": ["aaaaaa1"]}, batch="bad id"), "batch_id"),
    ("x" * 70000, "limit"),
])
def test_payload_envelope_errors(raw, needle):
    with pytest.raises(PayloadError, match=needle):
        parse_payload(raw, ACCTS)


def test_unsubscribe_url_safety():
    assert safe_unsubscribe_url("https://news.example.test/u/1")
    for bad in ["http://news.test/u", "https://127.0.0.1/u", "https://[::1]/u", "https://localhost/u",
                "https://intranet/u", "https://user:pw@news.test/u", "https://svc.internal/u", None]:
        assert safe_unsubscribe_url(bad) is None, bad


def make_settings(tmp_path: Path) -> Settings:
    return Settings("cid", "sec", (Account("account_1", "Personal", "me@x.test", "r"),), "in:inbox", 300,
                    "m", None, None, tmp_path)


def box():
    msgs = [FakeMessage(f"aaaaaa{i}", f"aaaaaa{i}", "Shop <offers@shop.test>", "Sale", "s", 1000 + i,
                        ["INBOX", "UNREAD"], "<https://shop.test/u>", "List-Unsubscribe=One-Click") for i in range(1, 6)]
    msgs.append(FakeMessage("cccccc1", "cccccc1", "Shop <offers@shop.test>", "Kept", "s", 900, ["INBOX", "STARRED"]))
    msgs.append(FakeMessage("dddddd1", "dddddd1", "Friend <f@pal.test>", "Hi", "s", 800, ["INBOX"], "<mailto:x@pal.test>"))
    return FakeGmail("me@x.test", msgs)


def test_execute_all_ops_and_audit(tmp_path, monkeypatch):
    g = box()
    posted = []
    http.set_transport(lambda req, t: posted.append((req.full_url, req.data)) or Response(200, b"", {}), lambda s: None)
    raw = payload(
        {"account": "account_1", "op": "archive", "ids": ["aaaaaa1"]},
        {"account": "account_1", "op": "mark_read", "ids": ["aaaaaa2"]},
        {"account": "account_1", "op": "star", "ids": ["aaaaaa3"]},
        {"account": "account_1", "op": "move_to_label", "ids": ["aaaaaa4"], "label": "Finance/Receipts"},
        {"account": "account_1", "op": "unsubscribe", "ids": ["aaaaaa5", "dddddd1"]},
        {"account": "account_1", "op": "bulk_trash_sender", "sender": "offers@shop.test"},
    )
    rec = execute(make_settings(tmp_path), raw, gmail_factory=lambda a: g, started_at="2026-11-26T03:14:00Z")
    m = g.messages
    assert "INBOX" not in m["aaaaaa1"].labels or "TRASH" in m["aaaaaa1"].labels
    assert "UNREAD" not in m["aaaaaa2"].labels
    assert any(l.startswith("Label_") for l in m["aaaaaa4"].labels) and "INBOX" not in m["aaaaaa4"].labels
    assert "TRASH" not in m["cccccc1"].labels            # starred mail survives bulk trash
    assert posted == [("https://shop.test/u", b"List-Unsubscribe=One-Click")]
    unsub = next(r for r in rec["results"] if r["op"] == "unsubscribe")
    assert (unsub["succeeded"], unsub["manual"]) == (1, 1)   # mailto-only needs a manual step
    bulk = next(r for r in rec["results"] if r["op"] == "bulk_trash_sender")
    # aaaaaa3 was starred earlier in this batch, so only 4 of the 5 are trashed.
    assert bulk["requested"] == 4 and bulk["succeeded"] == 4 and "TRASH" not in m["aaaaaa3"].labels
    assert rec["status"] == "ok"
    saved = json.loads((tmp_path / "audit" / "2026" / f"{BATCH}.json").read_text())
    assert saved["summary"]["failed"] == 0 and "subject" not in json.dumps(saved).lower()


def test_execute_partial_failure_and_rejection(tmp_path):
    g = box()
    g.fail_ids = {"aaaaaa2"}
    raw = payload({"account": "account_1", "op": "delete", "ids": ["aaaaaa1", "aaaaaa2"]})
    rec = execute(make_settings(tmp_path), raw, gmail_factory=lambda a: g)
    assert rec["status"] == "partial" and rec["summary"] == {"requested": 2, "succeeded": 1, "failed": 1, "manual": 0}
    with pytest.raises(PayloadError):
        execute(make_settings(tmp_path), "{bad", gmail_factory=lambda a: g, started_at="2026-11-26T03:15:00Z")
    rejected = list((tmp_path / "audit" / "2026").glob("*rejected.json"))
    assert len(rejected) == 1 and json.loads(rejected[0].read_text())["status"] == "rejected"


def test_audit_year_follows_batch_id_across_new_year(tmp_path):
    g = box()
    raw = payload({"account": "account_1", "op": "archive", "ids": ["aaaaaa1"]}, batch="b-20261231-235959-zz9yy8")
    execute(make_settings(tmp_path), raw, gmail_factory=lambda a: g, started_at="2027-01-01T00:00:03Z")
    assert (tmp_path / "audit" / "2026" / "b-20261231-235959-zz9yy8.json").exists()
