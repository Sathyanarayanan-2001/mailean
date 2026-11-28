# Mailean quality record

Version 1.1.2 · 28/11/2026

This file records how Mailean was built and checked: stage checkpoints, two verification rounds by two methods, performance numbers, a usability walkthrough, an FMEA, DMAIC and root-cause analyses. Every number here comes from a run in the build environment. Anything not run is marked **Not run** or **Unverified**.

## 1. Stages and checkpoints

| # | Stage | Deliverables | Tests run at the checkpoint | Unresolved | Exit |
|---|---|---|---|---|---|
| 1 | Plan | File plan, data contracts, two-repository design | – | – | Pass |
| 2 | Core logic | `agent/*`, `docs/js/format, csv, merge, model, commands, crypto` | 79 Python, 22 JS | – | Pass |
| 3 | Storage and sync | `store.js`, `sync.js`, service worker, manifest | 27 JS (5 new sync tests) | – | Pass |
| 4 | Pages and styles | `index.html`, `app.js`, `styles.css`, charts | 14 browser tests; 4 failures found and fixed (see 7) | – | Pass |
| 5 | Import and export | `exporter.js`, CSV import preview, Web Worker | Round trip and preview tests | – | Pass |
| 6 | Documents and CI | Workflows, README, SETUP, ARCHITECTURE, SECURITY, CONTRIBUTING, CHANGELOG, LICENSE | actionlint + shellcheck, YAML parse | Live Pages URL cannot be checked before deployment | Pass |
| 7 | Round 2, then commit | Clean-clone rerun, Lighthouse, screenshots | All suites (section 2) | See section 10 | Pass |
| 10 | 1.1.2 seal saved texts | Existing plain texts encrypted once a passphrase is set | 101 Python (1 new) plus all other suites | – | Pass |
| 9 | 1.1.1 quota fix | Current Gmail quota prices, resumable text saving, 300 new texts per run | 100 Python (6 new), 38 JS, 21 browser, actionlint, golden 15/15 (section 2, round 4) | – | Pass |
| 8 | 1.1.0 reader | `agent/bodies.py`, `fetch_attachments`, `docs/js/mailtext.js`, reader in `app.js` | 94 Python, 38 JS, 21 browser tests (section 2, round 3) | "Open in Gmail" link form (section 10) | Pass |

Work was done on branch `feature/v1.0.0` and merged into `main` with `--no-ff` after every test passed. There was no GitHub access from the build environment, so this was a local merge, not a GitHub pull request.

## 2. Verification counts

### Round 1 (during the build)

| Check | Method A | Method B | Result |
|---|---|---|---|
| Agent logic | 79 pytest tests, hand-worked expectations | In-memory Gmail plus a real local git remote for publishing | 79/79 after fixes |
| Dashboard logic | 27 `node --test` tests, hand-worked | Python oracles: `zoneinfo` + `date.isocalendar()` on 610 dates; dashboard figures recomputed in Python | 27/27 |
| Browser flows | 14 Playwright tests | Browser payload re-validated by the Python agent validator | 14/14 after 4 fixes |
| Appearance | About 20 screenshots reviewed by eye (320, 360, 390 px, desktop; light, dark) | Automatic checks: no sideways scroll, targets of 44 px or more, axe-core WCAG 2.2 AA | 12 visual issues found and fixed (section 7) |

### Round 2 (final, from a clean clone of the committed branch, hash-locked dependencies)

| Check | Method A | Method B | Result |
|---|---|---|---|
| Agent unit tests | pytest, 80 tests | – | **80 passed, 0 failed** |
| Dashboard unit tests | node:test, 27 tests | Python oracle fixtures | **27 passed, 0 failed** |
| Browser tests | Playwright, 14 tests | axe-core, Python validator, Python `csv` reader | **14 passed, 0 failed** |
| Golden examples | Rubric scoring (rules) | – | **15/15** (Claude: **Not run**, no API key in the build environment) |
| Workflows | PyYAML parse | actionlint 1.7.12 with shellcheck | **clean** |
| Dependencies | `pip-compile --generate-hashes` | Fresh install with `--require-hashes` | **installs and passes** |
| Fixtures | Committed copies | Regenerated with the scripts: `git status` clean | **reproducible** |
| First load | Lighthouse 12.8.2, mobile, run 1 | Lighthouse, run 2 | **Perf 99, A11y 100, BP 100, SEO 100; LCP 1.8 s both runs** |
| Appearance | Screenshots reviewed by eye at 320 px dark, 390 px light, desktop dark | Automated layout tests at 320, 360 and 390 px, light and dark | **no overlaps, clipping or sideways scroll** |

### Round 3 (version 1.1.0: email reader and attachments)

| Check | Method A | Method B | Result |
|---|---|---|---|
| Agent unit tests | pytest, 94 tests (14 new: HTML to text, code masking, charsets, pruning, limits, encryption) | Fake Gmail builds real multipart messages; files checked on disk | **94 passed, 0 failed** |
| Dashboard unit tests | node:test, 38 tests (11 new: safe links, Gmail link, sizes, field checks) | Every text the Python agent wrote for the demo passes the browser's check unchanged | **38 passed, 0 failed** |
| Browser tests | Playwright, 21 tests (6 new) | Python encrypts texts and files with the agent's own code; the browser decrypts them; the agent's validator accepts the browser's `fetch_attachments` payload; downloaded bytes equal the originals | **21 passed, 0 failed** |
| Gmail search form | Gmail Help search result: `rfc822msgid:200503292@example.com` | The same help page opened directly: same row, no angle brackets | **matches**; the dashboard copies that form |
| Golden examples | Rubric scoring (rules) | – | **15/15** |
| Workflows | actionlint | – | **clean** |
| First load | Lighthouse, mobile, run 1: LCP 1.87 s | Run 2: LCP 1.88 s | **Perf 94, A11y 100, BP 100, SEO 100** |
| Appearance | Reader screenshots by eye at 320 px light, 375 and 390 px dark, desktop light | Automated: reader fills a 320 and 390 px screen, no sideways scroll, targets 44 px or more; axe-core on the open reader, light and dark | **pass** after 3 fixes (section 7) |

### Round 4 (version 1.1.1: Gmail quota)

| Check | Method A | Method B | Result |
|---|---|---|---|
| Quota prices | Gmail API "Usage limits" page found by web search: per user 6,000 units a minute; `messages.get` 20, or 60 with `format=full` | The same page opened directly: same figures, plus `attachments.get` 20 and `messages.trash` 20 | **match**; the agent's table equals them (test) |
| Pacing | Simulated clock: 610 calls never exceed 6,000 units in any 60-second window | Arithmetic: 300 full reads × 60 units ÷ 80 units a second ≈ 225 s | **pass** |
| Resume | Test: a run stopped by a rate-limit error keeps its saved texts; the next run downloads only the rest | Encrypted texts read back for their attachment counts | **pass** |
| Real sync | GitHub Actions run of Scheduled triage with 1.1.1 on 28/11/2026: success; the sync step took 2 min 45 s; no account errors | State branch read back: 300 saved texts in `bodies/`; `inbox.json` lists 289 conversations, all with text, 8 with attachments | **pass** |

### What the tests cover (each states input and hand-worked expected result)

- **Money to the paisa:** `1,23,456.78` → `12345678` paise; `0.10 + 0.20 + 1,23,456.78 + 99,999.99` = `2,23,457.07`; 5,000 random round trips in JS, 2,000 in Python.
- **Midnight and FY boundary:** `2026-03-31T18:29:59Z` → FY 2025-26; `18:30:00Z` → `01/04/2026 00:00`, FY 2026-27 (IST).
- **Month ends:** `2026-11-30T20:00:00Z` → `01/12/2026` in IST.
- **Leap years:** `29/02/2028` accepted; `29/02/2026` rejected with "not a leap year".
- **ISO week 53:** 31/12/2026 and 01/01/2027 → 2026-W53; 04/01/2027 → 2027-W01; 30/12/2024 → 2025-W01.
- **New Year batch:** a batch made at 23:59:59 UTC on 31/12/2026 and run on 01/01/2027 files its audit under 2026.
- **Two devices:** both add at the same time → both end with both; a deletion on one reaches the other; a late old file cannot bring it back.
- **Merge laws:** commutative, associative and idempotent over 2,000 random trials with many exact ties.
- **Offline:** reload, go offline, reload → the page opens and the data is still there.
- **Phones:** 320, 360 and 390 px, light and dark: no sideways scroll on 8 screens; every target is 44 px or more.
- **Round trip:** export all 128 demo conversations → parse → 128 rows; amount total equals the source to the paisa.
- **Dashboard figures:** every tile, group, week, month and priority figure equals the Python computation.
- **Security:** CSV formula injection neutralised; ids kept as `="…"`; the CSP blocked an injected inline script during testing; public repository refused; payload fields allow-listed; unsubscribe refuses `127.0.0.1`, `[::1]`, `localhost`, single-label hosts and credentials in URLs.

## 3. Golden examples (`tests/fixtures/golden.json`)

Rubric per example: **correct** (group and suspicious flag), **complete** (priority range, action, exact amount), **format** (summary 1–120 characters with no link; a label when the action is move). Three points each, 15 in total. Pass mark: 80 %.

| Example | Rules result | Score |
|---|---|---|
| Bank debit alert with a 12-digit reference | receipts_finance, P3, move_to_label, 249900 paise | 3/3 |
| Colleague asks for a review by Friday | action_required, P4, reply | 3/3 |
| Subscribed newsletter | newsletters_reading, P2, mark_read | 3/3 |
| Promotion with unsubscribe | promotions_spam, P1, unsubscribe | 3/3 |
| Prompt injection inside an invoice | receipts_finance, flagged suspicious | 3/3 |

Caveat: the rules were written with these examples in view, so 15/15 shows the fallback is wired correctly. It does not show general accuracy. Run `python scripts/eval_golden.py` with your API key after any prompt change.

## 4. Performance: slowest actions, before and after

| Action | Before | After | Change | How measured |
|---|---|---|---|---|
| Classify 600 new emails (first sync of two full inboxes) | 6.02 s | 1.51 s | 4 Claude batches in parallel | Fake Claude client, 0.25 s per call, 2 runs each (identical) |
| Open Inbox with 3,000 conversations | median 155 ms and 204 ms (two runs of 5) | median 66 ms and 76 ms | Icon cloning, search text computed once, `content-visibility: auto` | Chrome, 390 px, 4× CPU slowdown, time until first row appears |
| Profile of Inbox render (before the last fix) | JS about 20 ms per render; most time in style and layout | – | Led to `content-visibility` | Chrome DevTools CPU profile through CDP |

Real Claude latency per batch is longer than 0.25 s, so the absolute time saved on a real first sync is larger. The ratio stays about the worker count (4). The real figure is **Not measured** because there was no API key.

## 5. Usability walkthrough

**What was run:** a scripted walkthrough on a 390 px phone, starting from a first visit. It used only visible labels, and counted taps. **What was not run:** a test with a real first-time person. That is still to do (protocol below).

| Task | Taps | Result |
|---|---|---|
| T1 Open the demo on first visit | 2 | Pass |
| T2 Find this FY's receipts total | 0 (on Home) | Pass, ₹5,66,609.12 |
| T3 Apply all of Claude's suggestions | 2 (+1 to close) | Pass |
| T4 Trash all mail from one noisy sender | 7 | Pass. Improvement candidate: an "Execute now" choice in the confirm dialog would save 2 taps. |
| T5 Export the inbox for Excel | 3 | Pass |

Fixes made because of the walkthrough and screenshots: on phones the filters filled the whole first screen, so the extra filters now fold away and a group menu replaces six chip rows. The bulk action bar now appears only after you select something.

**Protocol for a real person (15 minutes):** give them the dashboard in demo mode and these five tasks, one at a time, without help. Note where they hesitate, any wrong tap and the time taken. Fix anything that blocks a task before connecting real mail.

## 6. FMEA (severity × occurrence × detection, each 1–10; RPN = product)

| # | Area | Failure mode | Effect | Cause | S | O | D | RPN | Control in place |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Import | Wrong column mapped as Action | Wrong action queued | Ambiguous headers | 7 | 3 | 3 | 63 | Aliases matched exactly; preview with status per row; nothing saved until Import |
| 2 | Import | Excel turns ids into 6.27E+11 | Rows fail or hit wrong mail | Excel number coercion | 7 | 5 | 2 | 70 | Ids exported as `="…"`; strict id regex rejects mangled ids |
| 3 | Import | Header not found after preamble | Import impossible | Extra lines on top | 3 | 4 | 1 | 12 | Header search over the first 20 lines; clear error |
| 4 | Evaluation | Prompt injection changes a group or priority | Misleading triage | Hostile email text | 5 | 4 | 4 | 80 | Nonce-tagged JSON, schema enums, flag; suggestions only; never auto-staged |
| 5 | Evaluation | Model output truncated or invalid | Batch unclassified | `max_tokens`, outage | 4 | 3 | 2 | 24 | stop_reason check; rules fallback per batch; counts in state |
| 6 | Evaluation | Wrong amount parsed | Wrong totals | Model or regex error | 5 | 4 | 5 | 100 | Amount only for receipts; digits-only string to paise; shown per row for review |
| 7 | Evaluation | OTP copied into a subject or summary | Secret stored in git | Codes in subjects | 7 | 4 | 4 | 112 | Code redaction; snippets off by default; history squashed |
| 8 | Storage | State committed to a public repository | Privacy breach | Wrong repository visibility | 10 | 2 | 2 | 40 | Workflows refuse public repos; dashboard refuses; `MAILEAN_ROLE` gate; optional encryption |
| 9 | Storage | Sync and command runs overwrite each other | Lost audit or state | Concurrent pushes | 5 | 3 | 2 | 30 | Lease on squash; cherry-pick append; tested both orders |
| 10 | Storage | Refresh token expires after 7 days | Sync stops | OAuth app left in Testing | 6 | 6 | 2 | 72 | SETUP steps A10–A17 (privacy page, then publish); error banner names the fix; other accounts keep working |
| 11 | Storage | Folder-sync file read while still downloading | Merge error | OneDrive late delivery | 3 | 6 | 2 | 36 | File skipped and retried; status shown |
| 12 | Storage | Two devices act on the same item | Double action | Shared queue | 3 | 3 | 4 | 36 | Gmail actions are idempotent; tombstones propagate; history kept |
| 13 | Reporting | Dashboard total differs from data | Wrong decision | Float maths, time zone | 6 | 2 | 1 | 12 | Integer paise; Python oracle cross-check |
| 14 | Reporting | Week or FY wrong at a boundary | Misfiled period | Time zone or midnight | 4 | 3 | 1 | 12 | Zone-aware parts; 610-date oracle; edge tests |
| 15 | Reporting | Hidden rows stay hidden after a failed run | Missing mail in view | Optimistic hide | 4 | 3 | 3 | 36 | Hide only after success; cleared on the next sync |
| 16 | Execution | Payload too large for a workflow input | Run refused | Huge selections | 4 | 3 | 2 | 24 | Split under 60,000 characters, 5,000 ids, 200 commands; sent one by one |
| 17 | Reader | Email HTML runs script or loads a tracking image | Privacy or security breach | Hostile email | 9 | 3 | 2 | 54 | HTML reduced to text by the agent; the page shows text nodes only; CSP blocks remote images and scripts |
| 18 | Reader | Link text disguises the real address | Phishing click | Hostile email | 7 | 4 | 3 | 84 | Visible text is always the real URL; http(s) only; no clickable links in suspicious emails |
| 19 | Attachments | Malicious file opened | Malware on the device | Hostile attachment | 9 | 3 | 5 | 135 | Saved as a file, never opened in the page; extra confirmation for suspicious emails; owner must scan. Remaining action: scan before opening |
| 20 | Storage | Email text or files outlive the email | Data kept longer than needed | Missed pruning | 6 | 3 | 3 | 54 | Pruned every sync; files after 7 days; tested; optional encryption; `MAILEAN_STORE_BODIES=0` |
| 22 | Storage | Gmail rate limit stops the sync | Stale inbox, texts missing | Quota prices changed by Google | 5 | 3 | 3 | 45 | Current prices in one table with a test; 80 % pacing; Retry-After honoured; saved work kept; 300 new texts per run |
| 21 | Reader | Text missing for a new email | Owner cannot review | Email arrived after the last sync | 3 | 6 | 1 | 18 | Clear note with the fix; "Open in Gmail" |

The highest risks (RPN 100 and over) are #19 attachments, #7 OTPs and #6 amounts. All have controls. Remaining actions: scan downloaded files before opening them (#19); review receipts totals against your bank before relying on them (#6).

## 7. Root-cause analyses (5 Whys) for defects found during the build

**D1. Settings scrolled sideways by 4 px at 320 px.**
1. Why? The page was 324 px wide.
2. Why? A card was wider than the screen.
3. Why? Its button row would not shrink.
4. Why? `.row` was a non-wrapping flex row, and buttons use `white-space: nowrap`.
5. Why? The row style was written for desktop toolbars and never checked with two long labels at 320 px.

Fix: `.row` wraps by default. Control: the automated 320 px test covers every screen.

**D2. A hand-edited CSV with `="1a00…"` failed to import.**
1. Why? The id read as `=1a00…`.
2. Why? The parser removed the quotes in the middle of a field.
3. Why? It treated any `"` as the start of a quoted field.
4. Why? RFC 4180 says quotes are special only at the start of a field; the parser did not follow that.
5. Why? The first tests only used CSV that Mailean itself wrote, which is always fully quoted.

Fix: a quote opens a quoted field only at the start of a field. Control: the import test now includes a hand-typed row.

**D3. Audit record not found for a batch crossing midnight UTC on 31 December.**
1. Why? The dashboard looked in `audit/2026/` while the agent wrote `audit/2027/`.
2. Why? The agent used the run's start time.
3. Why? The browser and the agent took the year from different clocks.
4. Why? The folder name was designed before the batch id carried a date.
5. Why? No test crossed a year boundary for audits.

Fix: the folder year comes from the batch id. Control: `test_audit_year_follows_batch_id_across_new_year`.

**D4. First real sync failed: "Gmail API has not been used in project 931236531062 before or it is disabled" (28/11/2026).**
1. Why did the sync fail? Gmail refused every call with 403 `accessNotConfigured`.
2. Why? The Gmail API was not enabled in the Google Cloud project that owns the OAuth client.
3. Why? The client was replaced after the keys upload, and the new client was in a different project from the one where the API was enabled.
4. Why was that not caught at once? The setup guide did not say to check the project picker before creating a client.
5. Why was the fix not obvious from the log? The agent cut Google's message at 160 characters, before the link that says what to enable.

Fix: step A18 checks the project; Gmail errors are explained in one plain sentence with the project number. Control: `test_gmail_api_disabled_error_says_how_to_fix` replays the exact message.

Other issues fixed during appearance review: inbox column headers out of line with their columns; a summary that repeated the subject; filters filling the phone screen; a cluttered bulk bar; rupee axis labels overflowing the chart; grid lines under their labels; link-buttons in the wrong colour in dark mode; table-of-contents chips under 44 px; a hint that pointed to the wrong guide step; the drawer close glyph; the cleanup "Archive" label.

**D5. The reader showed the word "null" above the email (1.1.0, found on the first screenshot).**
1. Why? A text node "null" was added to the reader.
2. Why? An optional part (the summary) was `null` when there was nothing to show.
3. Why? It was passed to the browser's own `Element.append`, which turns `null` into text.
4. Why? The rest of the app uses the `append` helper from `dom.js`, which skips `null`; the new code mixed the two.
5. Why? No test looked for stray text in a new view.

Fix: every reader call that can receive `null` uses the helper. Control: the browser tests read the reader's text, and screenshots are reviewed by eye.

**D6. On a phone, the reader's close button was 37 px wide.**
1. Why? The button shrank.
2. Why? It shares a flex row with a long, wrapping title.
3. Why? Flex items may shrink by default.
4. Why? Earlier dialogs had short titles, so it never happened.
5. Why? The 44 px check did not cover dialogs.

Fix: the dialog close button does not shrink. Control: a new test checks every target in the open reader at 320 and 390 px.

**D7. Queueing from the reader did not update the Queue count.**
1. Why? The count stayed at 0.
2. Why? The top bar was not redrawn.
3. Why? Elsewhere the whole page is redrawn after staging; the reader skips that to keep its place.
4. Why? The count lives in the top bar, which only `renderChrome` updates.
5. Why? The reader's staging path was new and not yet tested.

Fix: the reader redraws the top bar after staging. Control: the browser test checks the count.

**D8. The first real sync with email text failed: "Gmail's rate limit was still reached after several retries" (28/11/2026).**
1. Why? Gmail answered 429 even after five retries with backoff.
2. Why? The agent used about 17,000 quota units in 75 seconds; Gmail allows 6,000 a minute per account.
3. Why? The pacer charged 5 units for each message read, but a full read costs 60.
4. Why? Google changed the Gmail API prices on 1 May 2026. The cost table came from the older price list, while the per-minute limit came from the new one.
5. Why was it not caught? The tests used a fake Gmail with no quota, nothing compared the table with Google's page, and metadata-only syncs had stayed close enough to the limit to pass.

Fix: the table now holds the current prices, checked against Google's page by two methods, and a test pins it. A sliding-window test proves the pacing. Saved texts survive a stopped run. Control: a real sync on GitHub after the fix succeeded (section 2, round 4).

## 8. DMAIC

- **Define:** one person, several Gmail accounts, daily triage on a laptop and phone. Goal: sort and clear mail in bulk without exposing any email data.
- **Measure:** first load (LCP 1.8 s on mobile), Inbox render (66–76 ms for 3,000 rows at 4× CPU slowdown), classification time (1.51 s per 600 emails with 0.25 s calls), taps per task (2 for the main task), test counts (80 + 27 + 14).
- **Analyse:** the CPU profile showed layout, not JavaScript, dominated Inbox rendering. The 5 Whys above found two parser and design gaps. The FMEA ranks OTP leakage and amount parsing highest.
- **Improve:** `content-visibility` and icon cloning; parallel batches; code redaction; quote handling; year from batch id; phone filter layout.
- **Control:** CI runs all four suites on every push and pull request. Dependabot raises weekly pin updates. The golden set gates prompt changes. Lighthouse and screenshot steps are listed in CONTRIBUTING.md and the pull request template.

## 9. How each rule of the brief was handled

| Rule | Status |
|---|---|
| First load under 2 s on a mid-range phone, checked with Lighthouse | Applied: LCP 1.8 s (two runs) |
| Comments explain why | Applied |
| Escape and sanitise every value; validate every input | Applied: `textContent` only, `safeUrl`, CSV guard, strict validators in browser and agent |
| Stable sort with tie-breaks | Applied: priority → date → name → key (both languages) |
| Big-O, O(n log n) or better; hash maps for id lookups | Applied: ARCHITECTURE.md section 4 |
| Money in integer paise, lakh grouping | Applied: `amount_paise`; `formatInr` / `format_inr` |
| FY, ISO weeks, derived dates, day-first input, 24-hour times | Applied |
| CSV with BOM and quoting; import with header detection, aliases, preview, nothing saved until Import | Applied |
| pathlib for paths | Applied in the agent and scripts |
| Optional dependencies fail gracefully | Applied: no `anthropic` or key → rules; no Worker → main thread; no CompressionStream → plain JSON; no folder API → device-only. A missing `cryptography` with a passphrase set **fails loudly** on purpose rather than writing plain text. |
| Folder sync rules (gzip, newest 3, per-record merge, tombstones, 3 s write, page hide, skip late files, status) | Applied |
| Service worker, manifest with 192, 512 and maskable icons, CSP | Applied |
| Design rules (slate, emerald, IBM Plex Sans, type scale, focus, reduced motion, phone layout, 44 px, WCAG AA, chart table toggle) | Applied; axe-core and Lighthouse accessibility 100 |
| Repository best practice, CI test then deploy, pinned and locked dependencies | Applied; actions pinned to commit SHAs |
| No personal data committed; tests use made-up data | Applied: `.test` domains only; `.gitignore` blocks exports, backups and saves |
| OCR optional; Windows AppUserModelID | **Not applicable:** no OCR and no desktop window (the app installs as a PWA) |
| Earlier-answer lesson about grid-code documents per country | **Not applicable:** it belongs to the AnaGrid project, not Mailean |
| Run long work off the UI thread | Applied: CSV in a Worker; WebCrypto, gzip and network are asynchronous |

## 10. Known limits and unverified items

- The live address https://sathyanarayanan-2001.github.io/mailean/: GitHub reports each Pages deployment as successful. The page itself could not be opened from the build environment, so its content online is **Unverified**.
- **Open in Gmail** builds `mail.google.com/mail/?authuser=<address>#search/rfc822msgid:<id>`. The search operator is documented by Gmail Help; the `authuser` parameter and the `#search/` address form are not documented there and were not tried against a real Gmail account: **Unverified**. **Copy Gmail search** uses only the documented operator.
- Reading full messages (`format=full`) ran against real Gmail on GitHub on 28/11/2026: it hit the rate limit with 1.1.0 (D8) and succeeded with 1.1.1 (section 2, round 4). Fetching attachments from real Gmail is **Not run** until you press "Fetch attachments".
- The Claude path was tested with a fake client. A real API call, cost and accuracy are **Not run**.
- The Gmail API was tested with an in-memory fake. The real OAuth flow in `setup_oauth.py` is **Not run** end to end (its URL building, PKCE and output format are tested).
- GitHub Actions runs (scheduled triage, run commands, Pages deploy) are **Not run** on GitHub. They are linted, and their Python steps are tested locally, including git publishing against a real local remote.
- Google and GitHub console pages could not be opened from the build environment. SETUP.md uses menu paths confirmed by Google and GitHub help pages instead of links.
- The usability test was scripted, not done with a person.
