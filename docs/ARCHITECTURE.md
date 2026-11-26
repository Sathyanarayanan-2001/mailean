# Mailean architecture

Version 1.0.0 · 26/11/2026

## 1. The GitOps loop

GitHub Pages can only serve static files. So the repository is both the database and the message bus:

1. **Sync.** `scheduled-triage.yml` runs every 4 hours. It runs `agent/sync_inbox.py`, which writes `inbox.json`. `agent/publish.py squash` then replaces the `mailean-state` branch with one commit.
2. **Read.** The dashboard reads `inbox.json` through the GitHub REST contents API with `?ref=mailean-state`. It sends `If-None-Match`, so an unchanged file costs a `304`.
3. **Command.** "Execute via agent" calls `POST /actions/workflows/run-commands.yml/dispatches` with `inputs.batch_id` and `inputs.commands_payload`.
4. **Track.** The workflow's `run-name` contains the batch id. The dashboard finds the run by that title and polls it until it completes.
5. **Report.** `agent/execute_commands.py` writes `audit/<year>/<batch_id>.json`. `publish.py append` adds it to the state branch. The dashboard reads it and shows the counts.
6. **Refresh.** The command workflow starts a new sync with `gh workflow run`. The dashboard polls for a newer `inbox.json` for up to 5 minutes.

### Two repositories, one codebase

| | `mailean` (public) | `gmail-command-center` (private) |
|---|---|---|
| Purpose | Serves the dashboard on Pages | Holds secrets, runs the agent, stores state |
| Variable `MAILEAN_ROLE` | not set | `data` |
| Runs `ci.yml` deploy job | yes | no |
| Runs triage and command workflows | no (jobs skip) | yes |
| Holds email data | never | only on branch `mailean-state` |

Both workflows also call `gh api repos/$GITHUB_REPOSITORY --jq .private` and stop if the repository is public. This guards against a wrongly set variable.

### Concurrency between writers

Two jobs can write the state branch: a sync and a command run.

- A **sync** pushes with `--force-with-lease=<sha it started from>`. Before it pushes, it copies in any audit files another run added. If the lease fails, it fetches and retries (5 attempts).
- A **command run** adds one uniquely named audit file. If its push is rejected, it cherry-picks its own commit onto the new tip. That cannot conflict, even onto a freshly squashed branch.
- Syncs share the concurrency group `mailean-sync`. A pending sync replaced by a newer one loses nothing.
- Command runs use **no** concurrency group, because GitHub cancels a *pending* run when a newer one joins a group. Gmail actions are idempotent, so overlap is safe.

`tests/python/test_publish.py` runs both orders of this race against a real local git remote.

## 2. Data shapes

### `inbox.json` (schema 1)

```json
{
  "schema": 1, "app": "mailean", "agent_version": "1.0.0", "generated_at": "2026-11-26T03:00:00Z",
  "classifier": {"model": "claude-sonnet-5-5", "llm": 12, "rules": 0, "cached": 288, "failed_batches": 0},
  "accounts": [{"id": "account_1", "label": "Personal", "email": "me@example.test", "fetched": 150, "error": null, "synced_at": "…"}],
  "groups": [{"key": "action_required", "name": "Action Required", "count": 24}],
  "messages": [{
    "key": "account_1:18c2f3a4b5d6e7f8", "id": "18c2f3a4b5d6e7f8", "thread_id": "18c2…",
    "account": "account_1", "message_ids": ["18c2…", "18c3…"],
    "sender_name": "Example Bank Alerts", "sender_email": "alerts@examplebank.test",
    "subject": "Rs. 2,499.00 debited", "date": "2026-11-25T10:01:00Z", "age_days": 1,
    "unread": true, "starred": false,
    "unsubscribe": {"one_click": true, "url": "https://…", "mailto": null},
    "group": "receipts_finance", "priority": 3, "summary": "Card debit of ₹2,499.00",
    "suggested_action": "move_to_label", "suggested_label": "Receipts",
    "amount_paise": 249900, "currency": "INR", "reference": "627153940211",
    "suspicious": false, "source": "llm"
  }],
  "cleanup": [{"account": "account_1", "sender_email": "offers@shop.test", "count": 18, "oldest": "…", "max_age_days": 64, "group": "promotions_spam", "message_ids": ["…"], "unsubscribe": {"message_id": "…", "one_click": true, "url": "…"}}],
  "audit": [{"batch_id": "b-20261125-183000-x1y2z3", "status": "ok", "summary": {"requested": 24, "succeeded": 24, "failed": 0, "manual": 0}}]
}
```

- One row per **conversation**: the newest message represents it, and `message_ids` lists every inbox message of that thread. An action covers all of them, as Gmail's own UI does.
- Money is stored only as integer **paise** (`amount_paise`). References stay text.
- Snippets are present only when `MAILEAN_STORE_SNIPPETS=1`.

### Command payload (workflow input `commands_payload`)

```json
{"v": 1, "batch_id": "b-20261126-031400-k3x9q2", "commands": [
  {"account": "account_1", "op": "archive", "ids": ["18c2f3a4b5d6e7f8"]},
  {"account": "account_1", "op": "move_to_label", "ids": ["18c2…"], "label": "Finance/Receipts"},
  {"account": "account_2", "op": "bulk_trash_sender", "sender": "offers@shop.test"},
  {"account": "account_1", "op": "unsubscribe", "ids": ["18c2…"]}
]}
```

| op | Gmail call |
|---|---|
| `archive` | `messages.batchModify` remove `INBOX` (1,000 ids per call) |
| `mark_read` | `messages.batchModify` remove `UNREAD` |
| `star` | `messages.batchModify` add `STARRED` |
| `move_to_label` | `labels.create` if missing, then `batchModify` add label and remove `INBOX` |
| `delete` | `messages.trash` per id (recoverable for 30 days) |
| `bulk_trash_sender` | `messages.list q=from:"addr" -in:trash -is:starred` (up to 1,000), then `messages.trash` |
| `unsubscribe` | Reads `List-Unsubscribe` fresh from Gmail. Sends an RFC 8058 one-click `POST` only to a public `https` host, with no redirects. Otherwise reports "manual". |

Limits: 65,000 characters, 200 commands and 5,000 ids per run, and 50 unsubscribes per command. The dashboard splits larger queues into several runs and sends them one after another.

### Browser records (synced between devices)

Each record is `{u: <ms>, v: …}`; a deletion is the tombstone `{d: 1, u}`. Keys: `q:<conversation key>` (queued action), `q:sender:<account>:<email>`, `l:<label>` (saved label), `h:<conversation key>` (acted on, hidden until the next sync), `b:<batch id>` (execution history).

## 3. Prompt-injection defences (layered)

1. Only metadata and a capped snippet are sent, never full bodies.
2. Emails are JSON-encoded inside `<untrusted_emails_<random nonce>>`. JSON escaping plus a nonce nobody knows means no email text can close the tag.
3. The system prompt says that everything inside the tag is data, never instructions.
4. **Structured outputs** (`output_config.format`, `json_schema`) restrict output to fixed enums: six groups, eight suggested actions, priority 1 to 5.
5. Each item is validated again in Python. Unknown refs are dropped, duplicates ignored, links stripped from summaries, and anything missing falls back to the rules.
6. A regex detector and the model's own `injection_suspected` flag mark rows **Suspicious**. Those rows never get auto-staged suggestions.
7. The structural guarantee: **no model output can trigger an action.** `execute_commands.py` never calls a model. Only the user's validated payload changes a mailbox.
8. Workflow inputs reach Python through environment variables, never through shell interpolation (`${{ }}` inside `run:`). This blocks script injection.

## 4. Complexity (n conversations, m ids, k senders)

| Operation | Time | Memory | Notes |
|---|---|---|---|
| Sync fetch | O(n) API calls | O(n) | Paced to 80 quota units/s per mailbox, 6 parallel fetches |
| Classification | O(n/25) model calls | O(n) | Only new messages; 4 batches in parallel; results cached by key |
| Thread grouping | O(n) | O(n) | Hash map by thread id |
| Sort (agent and browser) | O(n log n) | O(n) | Stable; ties broken by date, then name, then key |
| Cleanup candidates | O(n + k log k) | O(k) | Hash map by (account, sender) |
| State validation and index | O(n) | O(n) | `Map` by key and by message id; no list scans for lookups |
| Filter and search | O(n) | O(n) | Lower-cased search text computed once per load |
| Dashboard figures | O(n + k log k) | O(n) | One pass; top senders sorted |
| Merge of synced records | O(r) | O(r) | Hash map per key |
| CSV parse and preview | O(c) characters | O(c) | Runs in a Web Worker |
| Payload building | O(m log m) | O(m) | Sorted ids per command |

## 5. Front end

- Plain ES modules with no build step and no framework. The modules are `format`, `csv`, `merge`, `model`, `commands`, `store`, `sync`, `github`, `crypto`, `charts`, `dom`, `exporter` and `worker`.
- `docs/index.html` sets a strict Content Security Policy: `default-src 'self'` and `connect-src 'self' https://api.github.com`. Inline scripts are blocked. `theme-init.js` is a file so the saved theme applies before first paint.
- Rendering uses DOM nodes and `textContent` only. No `innerHTML` with data. Links pass through `safeUrl` (http, https and mailto only).
- Storage: IndexedDB `mailean` (cached state, folder handle, records) with an in-memory fallback. localStorage holds only `mailean:*` settings. Every origin-wide name starts with `mailean`, because all `*.github.io` projects of one account share an origin.
- Service worker (`mailean-v1.0.0`): network-first for the page with a 4-second timeout; cached static files; never caches `api.github.com`.
- Charts are HTML bars and columns with a Chart/Table toggle. Colour follows the group (fixed slot, never rank). There is one axis and a hairline grid. The categorical palette passes the dataviz validator's colour-vision checks in light and dark.
