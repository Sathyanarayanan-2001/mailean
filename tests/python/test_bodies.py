"""Email text extraction, storage and pruning; fetching attachments. Made-up data only."""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from agent.bodies import (BodyStore, FileStore, clean_body, extract, html_to_text, message_id_header,
                          safe_filename)
from agent.classify import classify_all
from agent.commands import PayloadError, parse_payload
from agent.config import Account, Settings
from agent.execute_commands import execute, needs_sync
from agent.state import Sealer, decrypt_bytes, decrypt_json
from agent.sync_inbox import sync
from fakes import FakeGmail, FakeMessage, b64url

NOW = datetime(2026, 11, 28, 9, 0, tzinfo=timezone.utc)
MS = int(NOW.timestamp() * 1000)


def settings(tmp: Path, passphrase=None, bodies=True) -> Settings:
    return Settings("cid", "sec", (Account("account_1", "Personal", "me@x.test", "r"),), "in:inbox", 300,
                    "m", None, passphrase, tmp, store_bodies=bodies)


def rules(emails):
    return classify_all(emails, None, "rules")


# ---------------------------------------------------------------- extraction

def test_html_to_text_drops_script_keeps_structure_and_shows_link_targets():
    html = ("<html><head><style>p{}</style><title>x</title></head><body><script>alert(1)</script>"
            "<h1>Invoice</h1><p>Total &amp; tax: &#8377;2,499.00</p><ul><li>One</li><li>Two</li></ul>"
            '<p><a href="https://shop.test/pay">Pay now</a> or <a href="javascript:evil()">this</a></p>'
            '<img src="x.png" alt="logo"></body></html>')
    text, _ = clean_body(html_to_text(html))
    assert "alert" not in text and "p{}" not in text
    assert "Invoice" in text and "Total & tax: ₹2,499.00" in text
    assert "• One\n• Two" in text
    assert "Pay now (https://shop.test/pay)" in text      # real destination shown
    assert "javascript" not in text                        # non-http links are not shown
    assert "[logo]" in text


def test_clean_body_masks_codes_per_line_and_caps_length():
    text, truncated = clean_body("Your login code is 482913.\nOrder 123456 ships today.‮\x07 done")
    assert "482913" not in text and "Order 123456 ships today." in text   # only the code line is masked
    assert "‮" not in text and "\x07" not in text
    long, cut = clean_body("a" * 50, limit=10)
    assert cut and long.startswith("a" * 10) and "open the email in Gmail" in long
    assert truncated is False


def test_extract_prefers_plain_text_and_lists_attachments():
    g = FakeGmail("me@x.test", [FakeMessage("aaaaaa1", "aaaaaa1", "Shop <s@shop.test>", "Invoice", "s", MS,
                                            body="Plain body ₹1,23,456.78", html="<p>HTML body</p>",
                                            attachments=[("invoice.pdf", "application/pdf", b"%PDF-1.4 demo"),
                                                         ("../../etc/passwd", "text/plain", b"x")])])
    body = extract(g.get_full("aaaaaa1"))
    assert body["format"] == "plain" and body["text"] == "Plain body ₹1,23,456.78"
    assert body["attachments"] == [{"name": "invoice.pdf", "mime": "application/pdf", "size": 13},
                                   {"name": "_.._etc_passwd", "mime": "text/plain", "size": 1}]   # slashes gone: no path escape
    assert body["subject"] == "Invoice" and body["to"] == "me@example.test"   # FakeMessage default recipient


def test_extract_html_only_latin1_and_unknown_charset():
    msg = {"id": "aaaaaa2", "payload": {"mimeType": "text/html", "headers": [
        {"name": "Content-Type", "value": 'text/html; charset="iso-8859-1"'}],
        "body": {"data": b64url("<p>Caf\xe9</p>".encode("latin-1"))}}}
    assert extract(msg)["text"] == "Café"
    msg["payload"]["headers"][0]["value"] = "text/html; charset=x-made-up"
    assert extract(msg)["format"] == "html"   # unknown charset falls back to UTF-8 without crashing


def test_message_id_and_safe_names():
    assert message_id_header({"message-id": "<abc.123@mail.example.test>"}) == "<abc.123@mail.example.test>"
    assert message_id_header({"message-id": "<abc> OR in:anywhere"}) is None
    assert safe_filename("rëport (final)?.pdf") == "rëport _final_.pdf".replace("ë", "_")


# ---------------------------------------------------------------- sync integration

def box():
    return FakeGmail("me@x.test", [
        FakeMessage("aaaaaa1", "aaaaaa1", "Asha <asha@acme.test>", "Review please", "s", MS - 3600_000,
                    body="Please review section 4.", attachments=[("plan.pdf", "application/pdf", b"%PDF demo")]),
        FakeMessage("aaaaaa2", "aaaaaa1", "Asha <asha@acme.test>", "Re: Review please", "s", MS,
                    body="Reminder."),
        FakeMessage("bbbbbb1", "bbbbbb1", "News <n@news.test>", "Digest", "s", MS - 7200_000, html="<p>Five stories</p>"),
    ])


def test_sync_saves_text_once_and_prunes_when_mail_leaves_inbox(tmp_path):
    g = box()
    state = sync(settings(tmp_path), gmail_factory=lambda a: g, classify=rules, now=NOW)
    files = sorted(p.name for p in (tmp_path / "bodies" / "account_1").glob("*.json"))
    assert files == ["aaaaaa1.json", "aaaaaa2.json", "bbbbbb1.json"]
    saved = json.loads((tmp_path / "bodies" / "account_1" / "aaaaaa1.json").read_text())
    assert saved["text"] == "Please review section 4." and saved["attachments"][0]["name"] == "plan.pdf"
    thread = next(m for m in state["messages"] if m["thread_id"] == "aaaaaa1")
    assert thread["attachments"] == 1 and thread["has_body"] is True
    assert thread["message_id_header"] == "<aaaaaa2@mail.example.test>"
    assert state["bodies"] == {"stored": True, "encrypted": False, "max_chars": 20000}
    assert sum(1 for c in g.calls if c[0] == "get_full") == 3
    # Second run: nothing new, so no full downloads; the digest is archived, so its text goes.
    g.calls.clear()
    g.messages["bbbbbb1"].labels.remove("INBOX")
    sync(settings(tmp_path), gmail_factory=lambda a: g, classify=rules, now=NOW)
    assert [c for c in g.calls if c[0] == "get_full"] == []
    assert sorted(p.name for p in (tmp_path / "bodies" / "account_1").glob("*.json")) == ["aaaaaa1.json", "aaaaaa2.json"]


def test_bodies_off_removes_saved_texts(tmp_path):
    g = box()
    sync(settings(tmp_path), gmail_factory=lambda a: g, classify=rules, now=NOW)
    state = sync(settings(tmp_path, bodies=False), gmail_factory=lambda a: g, classify=rules, now=NOW)
    assert list((tmp_path / "bodies" / "account_1").glob("*.json")) == []
    assert state["bodies"]["stored"] is False and all(not m["has_body"] for m in state["messages"])


def test_encrypted_bodies_share_one_salt(tmp_path):
    g = box()
    sync(settings(tmp_path, passphrase="correct horse battery"), gmail_factory=lambda a: g, classify=rules, now=NOW)
    blobs = [json.loads(p.read_text()) for p in (tmp_path / "bodies" / "account_1").glob("*.json")]
    assert len({b["salt"] for b in blobs}) == 1 and len({b["iv"] for b in blobs}) == 3
    texts = sorted(decrypt_json(b, "correct horse battery")["text"] for b in blobs)
    assert texts == ["Five stories", "Please review section 4.", "Reminder."]


# ---------------------------------------------------------------- fetching attachments

def payload(*commands):
    return json.dumps({"v": 1, "batch_id": "b-20261128-090000-att001", "commands": list(commands)})


def test_fetch_attachments_saves_files_and_manifest(tmp_path):
    g = box()
    big = FakeMessage("cccccc1", "cccccc1", "Big <b@x.test>", "Huge", "s", MS, body="x",
                      attachments=[("small.txt", "text/plain", b"hello"), ("huge.bin", "application/octet-stream", b"0" * (16 * 1024 * 1024))])
    g.messages["cccccc1"] = big
    rec = execute(settings(tmp_path), payload({"account": "account_1", "op": "fetch_attachments", "ids": ["aaaaaa1", "cccccc1"]}),
                  gmail_factory=lambda a: g, started_at="2026-11-28T09:00:00Z")
    assert rec["status"] == "ok" and rec["results"][0]["succeeded"] == 2 and rec["results"][0]["manual"] == 1
    folder = tmp_path / "files" / "account_1" / "aaaaaa1"
    manifest = json.loads((folder / "manifest.json").read_text())
    assert manifest["files"] == [{"name": "plan.pdf", "mime": "application/pdf", "size": 9, "file": "01-plan.pdf", "encrypted": False}]
    assert (folder / "01-plan.pdf").read_bytes() == b"%PDF demo"
    huge = json.loads((tmp_path / "files" / "account_1" / "cccccc1" / "manifest.json").read_text())["files"]
    assert huge[0]["file"] == "01-small.txt" and "skipped" in huge[1] and "15 MB" in huge[1]["skipped"]
    assert needs_sync(rec) is False      # nothing changed in Gmail
    assert needs_sync({"results": [{"op": "archive"}, {"op": "fetch_attachments"}]}) is True


def test_fetch_attachments_encrypted_and_limits(tmp_path):
    g = box()
    execute(settings(tmp_path, passphrase="correct horse battery"),
            payload({"account": "account_1", "op": "fetch_attachments", "ids": ["aaaaaa1"]}), gmail_factory=lambda a: g)
    folder = tmp_path / "files" / "account_1" / "aaaaaa1"
    blob = json.loads((folder / "01-plan.pdf.enc.json").read_text())
    assert decrypt_bytes(blob, "correct horse battery") == b"%PDF demo"
    with pytest.raises(PayloadError, match="limited to 5"):
        parse_payload(payload({"account": "account_1", "op": "fetch_attachments", "ids": [f"aaaaa{i}0" for i in range(6)]}), {"account_1"})


def test_fetched_files_are_pruned_after_7_days_or_when_mail_leaves(tmp_path):
    store = FileStore(tmp_path)
    for mid, when in [("aaaaaa1", NOW), ("aaaaaa2", NOW - timedelta(days=8)), ("bbbbbb1", NOW)]:
        store.write("account_1", mid, 1, "f.txt", "text/plain", b"x")
        store.write_manifest("account_1", mid, {"fetched_at": when.strftime("%Y-%m-%dT%H:%M:%SZ"), "files": []})
    removed = store.prune({"account_1": {"aaaaaa1", "aaaaaa2"}}, NOW)
    assert removed == 2 and [p.name for p in (tmp_path / "files" / "account_1").iterdir()] == ["aaaaaa1"]


def test_sealer_derives_key_once():
    s = Sealer("correct horse battery", salt=bytes(16))
    a, b = s.seal_bytes(b"one"), s.seal_bytes(b"two")
    assert a["salt"] == b["salt"] and a["iv"] != b["iv"]
    assert decrypt_bytes(b, "correct horse battery") == b"two"


# ---------------------------------------------------------------- Gmail quota (changed by Google on 1 May 2026)

def test_quota_costs_match_googles_current_table():
    # Hand-copied from the Gmail API "Usage limits" page (checked 28/11/2026).
    from agent.gmail import COST, USER_UNITS_PER_MINUTE
    assert USER_UNITS_PER_MINUTE == 6000
    assert COST == {"get": 20, "get_full": 60, "attachment": 20, "list": 5, "batchModify": 50, "trash": 20,
                    "labels.list": 1, "labels.create": 5, "profile": 1}


def test_pacer_never_exceeds_6000_units_in_any_minute_with_six_threads_worth_of_calls():
    from agent.gmail import QuotaPacer
    t = [0.0]
    pacer = QuotaPacer(clock=lambda: t[0], sleep=lambda s: t.__setitem__(0, t[0] + s))
    spent = []  # (time, units)
    # The first body sync: 300 full fetches, then 300 metadata fetches and a few attachments.
    for units in [60] * 300 + [20] * 300 + [20] * 10:
        pacer.take(units)
        spent.append((t[0], units))
    total = sum(u for _, u in spent)
    assert t[0] >= (total - 80) / 80 - 1e-6          # paced at 80 units a second
    j = 0
    window = 0
    for i, (ti, u) in enumerate(spent):              # sliding 60-second window
        window += u
        while spent[j][0] <= ti - 60:
            window -= spent[j][1]
            j += 1
        assert window <= 6000, (ti, window)


def test_pacer_lets_a_call_dearer_than_the_bucket_through_and_repays_it():
    from agent.gmail import QuotaPacer
    t = [0.0]
    pacer = QuotaPacer(units_per_second=10, clock=lambda: t[0], sleep=lambda s: t.__setitem__(0, t[0] + s))
    pacer.take(50)      # more than the 10-unit bucket: waits for a full bucket, then runs into debt
    pacer.take(10)      # repays 40 units of debt first: about 5 seconds
    assert 4.9 <= t[0] <= 5.1


def test_get_full_is_charged_as_a_full_fetch():
    from agent.gmail import Gmail
    charged = []

    class Pacer:
        def take(self, units):
            charged.append(units)

    g = Gmail("token", pacer=Pacer())
    import agent.gmail as gm
    real = gm.http.request
    gm.http.request = lambda *a, **k: type("R", (), {"json": lambda self: {}})()
    try:
        g.get_full("abc123")
        g.get_metadata("abc123")
        g.get_attachment("abc123", "ATT1")
    finally:
        gm.http.request = real
    assert charged == [60, 20, 20]


def test_text_saving_resumes_after_a_run_that_stopped_part_way(tmp_path, monkeypatch):
    import agent.sync_inbox as si
    from agent.http import HttpError

    g = box()
    real_full = g.get_full
    calls = {"n": 0}

    def flaky_full(mid):
        calls["n"] += 1
        if calls["n"] == 3:
            raise HttpError(429, "Too many requests", reason="rateLimitExceeded")
        return real_full(mid)

    g.get_full = flaky_full
    monkeypatch.setattr(si, "FETCH_WORKERS", 1)       # deterministic order: newest first
    pw = "correct horse battery"
    state = sync(settings(tmp_path, passphrase=pw), gmail_factory=lambda a: g, classify=rules, now=NOW)
    assert "rate limit" in state["accounts"][0]["error"]
    saved = sorted(p.stem for p in (tmp_path / "bodies" / "account_1").glob("*.json"))
    assert len(saved) == 2                             # kept for the next run, not pruned
    # Next run: the two saved texts are not downloaded again, and their attachment counts come from the files.
    g.get_full = real_full
    g.calls.clear()
    state = sync(settings(tmp_path, passphrase=pw), gmail_factory=lambda a: g, classify=rules, now=NOW)
    assert state["accounts"][0]["error"] is None
    full = [c[1] for c in g.calls if c[0] == "get_full"]
    assert len(full) == 1 and full[0] not in saved
    thread = next(m for m in state["messages"] if m["thread_id"] == "aaaaaa1")
    assert thread["attachments"] == 1 and thread["has_body"] is True


def test_at_most_the_run_budget_of_new_texts_is_downloaded(tmp_path, monkeypatch):
    import agent.sync_inbox as si
    monkeypatch.setattr(si, "BODY_FETCHES_PER_RUN", 2)
    g = box()
    state = sync(settings(tmp_path), gmail_factory=lambda a: g, classify=rules, now=NOW)
    assert sum(1 for c in g.calls if c[0] == "get_full") == 2
    assert sum(1 for m in state["messages"] if m["has_body"]) >= 1
    g.calls.clear()
    sync(settings(tmp_path), gmail_factory=lambda a: g, classify=rules, now=NOW)
    assert sum(1 for c in g.calls if c[0] == "get_full") == 1
    assert len(list((tmp_path / "bodies" / "account_1").glob("*.json"))) == 3


def test_setting_a_passphrase_later_encrypts_texts_already_saved(tmp_path):
    g = box()
    sync(settings(tmp_path), gmail_factory=lambda a: g, classify=rules, now=NOW)
    files = sorted((tmp_path / "bodies" / "account_1").glob("*.json"))
    before = {f.name: json.loads(f.read_text()) for f in files}
    assert all("enc" not in v for v in before.values())
    g.calls.clear()
    pw = "correct horse battery"
    sync(settings(tmp_path, passphrase=pw), gmail_factory=lambda a: g, classify=rules, now=NOW)
    assert [c for c in g.calls if c[0] == "get_full"] == []          # no new Gmail downloads
    for f in files:
        blob = json.loads(f.read_text())
        assert blob["enc"] == "mailean-aesgcm-v1"
        assert decrypt_json(blob, pw) == before[f.name]              # same content, now encrypted
