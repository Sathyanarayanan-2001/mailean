"""Browser tests of the dashboard with Playwright (Chromium).

Run:  python -m pytest tests/e2e -q
Needs: pip install -r requirements-dev.txt && python -m playwright install chromium
       (or set CHROME_PATH to an installed Chrome). Skips itself if neither exists.

The GitHub API is replaced by a fake inside the browser (page.route), so the
real command flow (dispatch, find run, poll, audit) runs without a network.
"""

from __future__ import annotations

import functools
import http.server
import json
import os
import re
import socketserver
import sys
import threading
from pathlib import Path

import pytest

pw = pytest.importorskip("playwright.sync_api")
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
DOCS = ROOT / "docs"
DEMO = json.loads((DOCS / "demo-state.json").read_text(encoding="utf-8"))
DEMO_BODIES = json.loads((DOCS / "demo-bodies.json").read_text(encoding="utf-8"))
AXE = ROOT / "node_modules" / "axe-core" / "axe.min.js"
TOKEN = "github_pat_" + "A1" * 20
REPO = "sample-owner/gmail-command-center"


@pytest.fixture(scope="session")
def base_url():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=str(DOCS))
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}/"
    httpd.shutdown()


@pytest.fixture(scope="session")
def browser():
    with pw.sync_playwright() as p:
        path = os.environ.get("CHROME_PATH") or ("/usr/bin/google-chrome" if Path("/usr/bin/google-chrome").exists() else None)
        try:
            b = p.chromium.launch(executable_path=path) if path else p.chromium.launch()
        except Exception as exc:  # no browser installed
            pytest.skip(f"no Chromium available: {exc}")
        yield b
        b.close()


def new_page(browser, base_url, *, width=1280, height=900, scheme="light", quickstart_done=True, demo=False, bypass_csp=False):
    ctx = browser.new_context(viewport={"width": width, "height": height}, timezone_id="Asia/Kolkata",
                              color_scheme=scheme, is_mobile=width < 900, has_touch=width < 900, bypass_csp=bypass_csp)
    init = []
    if quickstart_done:
        init.append("localStorage.setItem('mailean:quickstart','true')")
    if demo:
        init.append("localStorage.setItem('mailean:demo','true')")
    if init:
        ctx.add_init_script(";".join(init))
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.on("console", lambda m: page.errors.append(m.text) if m.type == "error" else None)
    page.goto(base_url)
    page.wait_for_load_state("networkidle")
    return page


class FakeGitHub:
    """Answers the handful of GitHub REST calls the dashboard makes."""

    def __init__(self, private=True):
        self.private = private
        self.dispatched: list[dict] = []
        self.polls = 0

    def handle(self, route):
        url = route.request.url
        method = route.request.method
        if route.request.headers.get("authorization") != f"Bearer {TOKEN}":
            return route.fulfill(status=401, json={"message": "Bad credentials"})
        if re.search(r"/repos/[^/]+/[^/]+$", url):
            return route.fulfill(json={"full_name": REPO, "private": self.private})
        if "/contents/inbox.json" in url:
            return route.fulfill(status=200, body=json.dumps(DEMO), headers={"ETag": '"v1"', "Access-Control-Expose-Headers": "ETag"})
        if url.endswith("/dispatches") and method == "POST":
            self.dispatched.append(json.loads(route.request.post_data))
            return route.fulfill(status=204, body="")
        if "/workflows/run-commands.yml/runs" in url:
            runs = [{"id": 900 + i, "display_title": f"Mailean commands {d['inputs']['batch_id']}", "status": "queued",
                     "html_url": f"https://github.com/{REPO}/actions/runs/{900 + i}"} for i, d in enumerate(self.dispatched)]
            return route.fulfill(json={"workflow_runs": runs})
        m = re.search(r"/actions/runs/(\d+)$", url)
        if m:
            self.polls += 1
            done = self.polls >= 2
            return route.fulfill(json={"id": int(m.group(1)), "status": "completed" if done else "in_progress",
                                       "conclusion": "success" if done else None, "html_url": f"https://github.com/{REPO}/actions/runs/{m.group(1)}"})
        m = re.search(r"/contents/audit/\d{4}/(b-[^?]+)\.json", url)
        if m:
            payload = json.loads(self.dispatched[-1]["inputs"]["commands_payload"])
            n = sum(len(c.get("ids", [])) for c in payload["commands"])
            return route.fulfill(json={"batch_id": m.group(1), "status": "ok", "summary": {"requested": n, "succeeded": n, "failed": 0, "manual": 0}})
        return route.fulfill(status=404, json={"message": "Not Found"})


def test_first_visit_quick_start_then_connect_validation(browser, base_url):
    page = new_page(browser, base_url, quickstart_done=False)
    assert page.locator("#dlg").evaluate("d => d.open")
    page.get_by_role("button", name="Get started").click()
    assert page.locator("h2", has_text="Connect your private repository").is_visible()
    page.get_by_label("Repository").fill("not a repo")
    page.get_by_label("Fine-grained token").fill("hunter2")
    page.get_by_role("button", name="Connect", exact=True).click()
    assert "owner/name" in page.locator("#" + page.get_by_label("Repository").get_attribute("id") + "-err").inner_text()
    assert "github_pat_" in page.locator("#" + page.get_by_label("Fine-grained token").get_attribute("id") + "-err").inner_text()
    assert page.errors == []


def test_demo_two_taps_from_home_to_executed(browser, base_url):
    page = new_page(browser, base_url, demo=True)
    stage = page.get_by_role("button", name=re.compile(r"^Stage \d+ suggestions$"))
    n = int(re.search(r"\d+", stage.inner_text()).group())
    assert n > 0
    stage.click()                                                # tap 1
    page.get_by_role("button", name="Execute (demo)").click()    # tap 2
    page.wait_for_selector("text=Demo finished", timeout=10000)
    page.get_by_role("button", name="Close the queue").click()
    page.goto(base_url + "#/home")
    assert page.get_by_role("heading", name="Nothing to suggest right now").is_visible()
    page.goto(base_url + "#/activity")
    assert page.locator(".activity li").first.inner_text().startswith("Done")
    assert page.errors == []


def test_real_mode_dispatches_valid_payload_and_follows_the_run(browser, base_url):
    from agent.commands import parse_payload

    fake = FakeGitHub()
    page = new_page(browser, base_url)
    page.route("https://api.github.com/**", fake.handle)
    page.get_by_label("Repository").fill(REPO)
    page.get_by_label("Fine-grained token").fill(TOKEN)
    page.get_by_role("button", name="Connect", exact=True).click()
    page.wait_for_selector("text=suggested actions ready")
    page.goto(base_url + "#/inbox")
    first = page.locator(".mail").first
    subject = first.locator(".subject").inner_text()
    keys = [page.locator(".mail").nth(i).get_attribute("data-key") for i in range(3)]
    first.get_by_role("button", name=f"Archive: {subject}").click()
    page.locator(".mail").nth(1).locator("input.row-check").check()
    page.locator(".mail").nth(2).locator("input.row-check").check()
    page.locator(".bulkbar").get_by_role("button", name="Read").click()
    page.locator("#queue-btn").click()
    assert "Archive: 1 conversation" in page.locator("#queue-body").inner_text()
    page.get_by_role("button", name="Execute via agent").click()
    page.wait_for_selector("text=Finished", timeout=60000)
    assert len(fake.dispatched) == 1
    body = fake.dispatched[0]
    assert body["ref"] == "main"
    # Second method: the agent's own validator accepts exactly what the browser sent.
    batch_id, commands = parse_payload(body["inputs"]["commands_payload"], {"account_1", "account_2"})
    assert batch_id == body["inputs"]["batch_id"]
    assert sorted(c.op for c in commands) == ["archive", "mark_read"]
    assert page.locator("text=3 done, 0 failed").count() >= 1
    page.get_by_role("button", name="Close the queue").click()
    page.goto(base_url + "#/inbox")
    # The three acted-on conversations are hidden until the agent's next sync.
    for key in keys:
        assert page.locator(f'.mail[data-key="{key}"]').count() == 0
    assert page.errors == []


def test_public_repository_is_refused(browser, base_url):
    fake = FakeGitHub(private=False)
    page = new_page(browser, base_url)
    page.route("https://api.github.com/**", fake.handle)
    page.get_by_label("Repository").fill(REPO)
    page.get_by_label("Fine-grained token").fill(TOKEN)
    page.get_by_role("button", name="Connect", exact=True).click()
    page.wait_for_selector("text=This repository is public")


def test_import_preview_then_import(browser, base_url, tmp_path):
    page = new_page(browser, base_url, demo=True)
    page.goto(base_url + "#/data")
    ids = [m["id"] for m in DEMO["messages"][:2]]
    csv = tmp_path / "actions.csv"
    csv.write_text("My edits\n\nAccount,Message ID,Action,Label\n"
                   f"Personal,{ids[0]},archive,\nPersonal,{ids[1]},move,INBOX\nPersonal,zz,trash,\n", encoding="utf-8-sig")
    page.get_by_label("CSV file").set_input_files(str(csv))
    page.wait_for_selector("text=Header found on line 3")
    rows = page.locator(".data-table tbody tr")
    assert rows.count() == 3
    assert page.locator("text=1 ready, 0 skipped, 2 with errors").count() == 1
    assert page.locator("#queue-btn .count").inner_text() in ("0", "")   # nothing saved before Import
    page.get_by_role("button", name="Import 1 ready rows").click()
    pw.expect(page.locator("#queue-btn .count")).to_have_text("1")  # waits for the async save


def test_export_csv_keeps_ids_and_totals(browser, base_url):
    from agent.money import to_paise

    page = new_page(browser, base_url, demo=True)
    page.goto(base_url + "#/data")
    with page.expect_download() as dl:
        page.get_by_role("button", name=re.compile(r"^Inbox CSV")).click()
    text = Path(dl.value.path()).read_text(encoding="utf-8")
    assert text.startswith("﻿")
    import csv as csvmod
    rows = list(csvmod.reader(text.lstrip("﻿").splitlines()))
    header = rows[3]
    body = [r for r in rows[4:] if r]
    assert len(body) == len(DEMO["messages"])
    amt = header.index("Amount (₹)")
    assert sum(to_paise(r[amt]) or 0 for r in body) == sum(m["amount_paise"] or 0 for m in DEMO["messages"])
    ref = header.index("Reference")
    assert all(r[ref] == "" or r[ref].startswith('="') for r in body)


def test_offline_reload_keeps_data(browser, base_url):
    page = new_page(browser, base_url, demo=True)
    page.wait_for_selector("text=suggested actions ready")
    page.evaluate("navigator.serviceWorker.ready")
    page.reload()
    page.wait_for_load_state("networkidle")
    page.context.set_offline(True)
    page.reload()
    page.wait_for_selector("text=suggested actions ready", timeout=10000)
    page.goto(base_url + "#/dashboard")
    assert page.get_by_role("heading", name="Conversations by group").is_visible()
    page.context.set_offline(False)


@pytest.mark.parametrize("width", [320, 360, 390])
@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_phone_layout_no_sideways_scroll_and_44px_targets(browser, base_url, width, scheme):
    page = new_page(browser, base_url, width=width, height=780, scheme=scheme, demo=True)
    page.wait_for_selector("text=suggested actions ready")
    for route in ["home", "inbox", "dashboard", "cleanup", "activity", "data", "settings", "guide"]:
        page.goto(base_url + "#/" + route)
        page.wait_for_timeout(250)
        sw = page.evaluate("document.documentElement.scrollWidth")
        assert sw <= width, f"{route} scrolls sideways at {width}px ({sw})"
        small = page.evaluate("""() => [...document.querySelectorAll('main button, main a.btn, main .toc a, main .link-card, main .site-foot a, main select, main input:not([type=checkbox]):not([type=radio]):not([type=file]), .bottomnav .tab, .topbar button')]
            .filter(e => e.offsetParent !== null)
            .map(e => [e.textContent.trim().slice(0, 30) || e.getAttribute('aria-label') || e.tagName, Math.round(e.getBoundingClientRect().height), Math.round(e.getBoundingClientRect().width)])
            .filter(([, h, w]) => h < 44 || w < 44)""")
        assert small == [], f"{route}: targets under 44px: {small[:5]}"
    assert page.errors == []


def test_accessibility_axe_no_serious_issues(browser, base_url):
    if not AXE.exists():
        pytest.skip("run npm ci to install axe-core")
    for scheme in ("light", "dark"):
        # The page CSP blocks injected scripts (as it should); axe needs the bypass.
        page = new_page(browser, base_url, scheme=scheme, demo=True, bypass_csp=True)
        page.wait_for_selector("text=suggested actions ready")
        for route in ["home", "inbox", "dashboard", "cleanup", "activity", "data", "settings", "guide"]:
            page.goto(base_url + "#/" + route)
            page.wait_for_timeout(250)
            page.add_script_tag(path=str(AXE))
            res = page.evaluate("axe.run(document, {runOnly: ['wcag2a','wcag2aa','wcag21aa','wcag22aa']})")
            bad = [(v["id"], v["impact"], [n["target"] for n in v["nodes"]][:3]) for v in res["violations"] if v["impact"] in ("serious", "critical")]
            assert bad == [], f"{scheme} {route}: {bad}"


def test_privacy_policy_page_and_home_link(browser, base_url):
    # Google's Branding page needs a privacy policy on the home page's domain, linked
    # from the home page. The link must be in the static HTML, not added by script.
    html = (DOCS / "index.html").read_text(encoding="utf-8")
    assert 'href="privacy.html"' in html
    for scheme in ("light", "dark"):
        for width in (320, 1280):
            page = new_page(browser, base_url, width=width, scheme=scheme, bypass_csp=True)
            page.goto(base_url + "privacy.html")
            page.wait_for_load_state("networkidle")
            assert page.get_by_role("heading", name="Privacy policy", level=1).is_visible()
            text = page.inner_text("main")
            for needle in ("gmail.modify", "Limited Use", "Anthropic", "revoke access", "does not sell"):
                assert needle.lower() in text.lower(), needle
            assert page.evaluate("document.documentElement.scrollWidth") <= width
            if AXE.exists():
                page.add_script_tag(path=str(AXE))
                res = page.evaluate("axe.run(document, {runOnly: ['wcag2a','wcag2aa','wcag21aa','wcag22aa']})")
                assert [v["id"] for v in res["violations"] if v["impact"] in ("serious", "critical")] == []
            page.get_by_role("link", name="Back to Mailean").click()
            page.wait_for_selector(".site-foot a[href='privacy.html']")
            assert page.errors == [], page.errors


# ---------------------------------------------------------------- email reader

def open_reader_with_attachments(page):
    """Open the first listed email that has attachments; return its row key."""
    key = page.evaluate("""() => {
        const li = [...document.querySelectorAll('li.mail')].find((l) => l.querySelector('[title*="attachment"]'));
        li.querySelector('button.subject').click();
        return li.dataset.key;
    }""")
    page.wait_for_selector("#reader[open] .mail-text")
    return key


def first_line(text):
    return next(line for line in text.splitlines() if line.strip()).strip()


def test_demo_reader_shows_text_and_attachments_and_stages_actions(browser, base_url):
    page = new_page(browser, base_url, demo=True)
    page.wait_for_selector("text=suggested actions ready")
    page.goto(base_url + "#/inbox")
    key = open_reader_with_attachments(page)
    row = next(m for m in DEMO["messages"] if f"{m['account']}:{m['id']}" == key)
    body = DEMO_BODIES[key]
    reader = page.locator("#reader")
    assert reader.locator("#reader-title").inner_text() == row["subject"]
    assert first_line(body["text"]) in reader.locator(".mail-text").first.inner_text()
    assert body["to"] in reader.locator(".mail-meta").first.inner_text()
    names = [a["name"] for a in body["attachments"]]
    for n in names:
        assert reader.locator(".attach-list", has_text=n).count() == 1
    # Fetch (simulated in the demo), then download: the file is saved, never opened.
    reader.get_by_role("button", name="Fetch attachments").click()
    btn = reader.get_by_role("button", name=re.compile("^Download " + re.escape(names[0])))
    btn.wait_for(timeout=5000)
    with page.expect_download() as dl:
        btn.click()
    assert dl.value.suggested_filename == names[0]
    assert Path(dl.value.path()).read_text(encoding="utf-8").startswith("Made-up demo file")
    # Next and previous, by button and by keyboard.
    counter = reader.locator(".reader-nav .num")
    assert counter.inner_text().startswith("1 of") or counter.inner_text().split(" of ")[0].isdigit()
    start = int(counter.inner_text().split(" of ")[0].replace(",", ""))
    reader.get_by_role("button", name="Next ›").click()
    pw.expect(counter).to_have_text(re.compile(f"^{start + 1} of"))
    page.keyboard.press("ArrowLeft")
    pw.expect(counter).to_have_text(re.compile(f"^{start} of"))
    # Staging from the reader queues the action and moves to the next email.
    reader.get_by_role("button", name="Archive").click()
    pw.expect(counter).to_have_text(re.compile(f"^{start + 1} of"))
    pw.expect(page.locator("#queue-btn .count")).to_have_text("1")
    reader.get_by_role("button", name="Close the email").click()
    assert page.locator(f'.mail[data-key="{key}"] .tag.queued').inner_text() == "Queued: Archive"
    assert page.errors == []


def test_reader_links_are_safe_and_suspicious_links_are_not_clickable(browser, base_url):
    page = new_page(browser, base_url, demo=True)
    page.wait_for_selector("text=suggested actions ready")
    page.goto(base_url + "#/inbox")
    page.get_by_label("Search").fill("fault ride-through explained")
    page.locator("li.mail button.subject", has_text="fault ride-through explained").first.click()
    link = page.locator("#reader .mail-text a")
    link.first.wait_for()
    assert link.count() == 1
    assert link.first.get_attribute("href") == "https://gridnotes.test/frt"
    assert link.first.inner_text() == "https://gridnotes.test/frt"
    assert set(link.first.get_attribute("rel").split()) >= {"noopener", "noreferrer"}
    page.locator("#reader").get_by_role("button", name="Close the email").click()
    page.get_by_label("Search").fill("Invoice overdue")
    page.locator("li.mail button.subject", has_text="Invoice overdue").first.click()
    page.wait_for_selector("#reader .mail-text")
    text = page.locator("#reader .mail-text").inner_text()
    assert "https://unknown-vendor.test/pay-now" in text
    assert page.locator("#reader .mail-text a").count() == 0
    assert "shown as plain text" in page.locator("#reader").inner_text()
    assert page.errors == []


class ReaderGitHub(FakeGitHub):
    """Adds saved texts and fetched attachments, written by the agent's own code."""

    def __init__(self, state_blob, bodies, files_dir):
        super().__init__()
        self.state_blob = state_blob
        self.bodies = bodies
        self.files_dir = files_dir
        self.on_fetch = None

    def handle(self, route):
        url = route.request.url
        path = url.split("/contents/", 1)[1].split("?", 1)[0] if "/contents/" in url else ""
        if path == "inbox.json":
            return route.fulfill(status=200, body=json.dumps(self.state_blob), headers={"ETag": '"v1"', "Access-Control-Expose-Headers": "ETag"})
        m = re.fullmatch(r"bodies/([a-z0-9_]+)/([0-9A-Za-z]+)\.json", path)
        if m:
            blob = self.bodies.get(f"{m.group(1)}:{m.group(2)}")
            return route.fulfill(status=200, body=json.dumps(blob)) if blob else route.fulfill(status=404, json={"message": "Not Found"})
        if path.startswith("files/"):
            from urllib.parse import unquote
            f = self.files_dir / unquote(path)[len("files/"):]
            return route.fulfill(status=200, body=f.read_bytes()) if f.is_file() else route.fulfill(status=404, json={"message": "Not Found"})
        if url.endswith("/dispatches") and route.request.method == "POST":
            payload = json.loads(json.loads(route.request.post_data)["inputs"]["commands_payload"])
            if self.on_fetch and payload["commands"][0]["op"] == "fetch_attachments":
                self.on_fetch(payload)
        return super().handle(route)


def test_real_mode_reader_decrypts_texts_and_fetches_attachments(browser, base_url, tmp_path):
    from agent.bodies import FileStore
    from agent.commands import parse_payload
    from agent.execute_commands import fetch_attachments
    from agent.state import Sealer
    from scripts.fakes import FakeGmail, FakeMessage

    passphrase = "made-up passphrase for tests"
    sealer = Sealer(passphrase)
    bodies = {k: sealer.seal_json(v) for k, v in DEMO_BODIES.items()}
    fake = ReaderGitHub(sealer.seal_json(DEMO), bodies, tmp_path / "files")

    def agent_fetch(payload):
        # Second method: the agent's own validator and file writer produce what the browser reads.
        _, commands = parse_payload(json.dumps(payload), {"account_1", "account_2"})
        cmd = commands[0]
        body = DEMO_BODIES[f"{cmd.account}:{cmd.ids[0]}"]
        msg = FakeMessage(cmd.ids[0], "t1", "x <x@example.test>", "s", "", 0, body=body["text"],
                          attachments=[(a["name"], a["mime"], f"secret bytes of {a['name']}".encode()) for a in body["attachments"]])
        fetch_attachments(FakeGmail("me@example.test", [msg]), cmd.account, cmd.ids[0], FileStore(tmp_path, sealer))

    fake.on_fetch = agent_fetch
    page = new_page(browser, base_url)
    page.evaluate(f"sessionStorage.setItem('mailean:passphrase', {json.dumps(passphrase)})")
    page.route("https://api.github.com/**", fake.handle)
    page.get_by_label("Repository").fill(REPO)
    page.get_by_label("Fine-grained token").fill(TOKEN)
    page.get_by_role("button", name="Connect", exact=True).click()
    page.wait_for_selector("text=suggested actions ready", timeout=20000)
    page.goto(base_url + "#/inbox")
    key = open_reader_with_attachments(page)
    body = DEMO_BODIES[key]
    reader = page.locator("#reader")
    assert first_line(body["text"]) in reader.locator(".mail-text").first.inner_text()
    reader.get_by_role("button", name="Fetch attachments").click()
    name = body["attachments"][0]["name"]
    btn = reader.get_by_role("button", name=re.compile("^Download " + re.escape(name)))
    btn.wait_for(timeout=60000)
    assert len(fake.dispatched) == 1
    sent = json.loads(fake.dispatched[0]["inputs"]["commands_payload"])
    assert sent["commands"] == [{"account": key.split(":")[0], "op": "fetch_attachments", "ids": [key.split(":")[1]]}]
    stored = list((tmp_path / "files").rglob("*.enc.json"))
    assert stored and all(b"secret bytes" not in f.read_bytes() for f in stored)   # encrypted at rest
    with page.expect_download() as dl:
        btn.click()
    assert Path(dl.value.path()).read_bytes() == f"secret bytes of {name}".encode()
    assert dl.value.suggested_filename == name
    # The text is cached on the device still encrypted.
    cached = page.evaluate(f"""() => new Promise((res) => {{
        const r = indexedDB.open('mailean'); r.onsuccess = () => {{
            const q = r.result.transaction('kv').objectStore('kv').get({json.dumps('body:' + key)});
            q.onsuccess = () => res(q.result); }}; }})""")
    assert cached["enc"] == "mailean-aesgcm-v1" and "ct" in cached
    # "No files fetched yet" is a 404 by design; the browser logs it. Nothing else may fail.
    assert [e for e in page.errors if "status of 404" not in e] == []


@pytest.mark.parametrize("width", [320, 390])
def test_reader_on_phone_fills_the_screen_without_sideways_scroll(browser, base_url, width):
    page = new_page(browser, base_url, width=width, height=780, demo=True)
    page.wait_for_selector("text=suggested actions ready")
    page.goto(base_url + "#/inbox")
    open_reader_with_attachments(page)
    box = page.locator("#reader").bounding_box()
    assert round(box["width"]) == width and round(box["height"]) == 780
    assert page.evaluate("document.querySelector('#reader .reader-body').scrollWidth") <= width
    small = page.evaluate("""() => [...document.querySelectorAll('#reader button, #reader a.btn, #reader summary')]
        .filter(e => e.offsetParent !== null)
        .map(e => [e.textContent.trim().slice(0, 30) || e.getAttribute('aria-label'), Math.round(e.getBoundingClientRect().height), Math.round(e.getBoundingClientRect().width)])
        .filter(([, h, w]) => h < 44 || w < 44)""")
    assert small == [], small[:5]
    assert page.errors == []


def test_reader_accessibility_axe(browser, base_url):
    if not AXE.exists():
        pytest.skip("run npm ci to install axe-core")
    for scheme in ("light", "dark"):
        page = new_page(browser, base_url, scheme=scheme, demo=True, bypass_csp=True)
        page.wait_for_selector("text=suggested actions ready")
        page.goto(base_url + "#/inbox")
        open_reader_with_attachments(page)
        page.locator("#reader").get_by_role("button", name="Fetch attachments").click()
        page.locator("#reader .download-list").wait_for()
        page.add_script_tag(path=str(AXE))
        res = page.evaluate("axe.run('#reader', {runOnly: ['wcag2a','wcag2aa','wcag21aa','wcag22aa']})")
        bad = [(v["id"], v["impact"], [n["target"] for n in v["nodes"]][:3]) for v in res["violations"] if v["impact"] in ("serious", "critical")]
        assert bad == [], f"{scheme}: {bad}"
