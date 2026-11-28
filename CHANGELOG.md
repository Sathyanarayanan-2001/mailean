# Changelog

All notable changes are listed here. Dates are day first. Versions follow semantic versioning.

## Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 1.0.0 | 26/11/2026 | Sathyanarayanan, with Claude | First release. |
| 1.0.0 (CI) | 26/11/2026 | Sathyanarayanan, with Claude | Pages build and deploy split into two jobs. |
| 1.0.1 | 28/11/2026 | Sathyanarayanan, with Claude | Privacy policy page, so the Google OAuth app can be published. |
| 1.0.2 | 28/11/2026 | Sathyanarayanan, with Claude | Private repository setup fixes: push with git, safer CI and publish steps. |
| 1.0.3 | 28/11/2026 | Sathyanarayanan, with Claude | Plain-language Gmail API errors, starting with "Gmail API is turned off". |
| 1.1.0 | 28/11/2026 | Sathyanarayanan, with Claude | Email reader: full text, conversation, attachments, Open in Gmail. |
| 1.1.1 | 28/11/2026 | Sathyanarayanan, with Claude | Gmail quota fix: the first text sync hit Gmail's rate limit. |

## 1.1.1 - 28/11/2026

### Fixed
- The first sync with email text failed after 75 seconds: "Gmail's rate limit was still reached". Google changed the Gmail API quota on 1 May 2026. Reading a message now costs 20 units, or 60 with its full text; an attachment 20; moving to Trash 20. Each account may use 6,000 units a minute. Mailean still charged the old prices (5 units), so it sent calls about 4 to 12 times too fast. The agent now charges the current prices and stays at 80 % of the limit.
- A sync that stops part-way no longer loses its work: texts already saved are kept and not downloaded again, and their attachment counts are read back from the saved files.
- At most 300 new texts are saved per account per run, so a very large inbox fills in over a few runs instead of timing out. The sync job may now run for 45 minutes.

## 1.1.0 - 28/11/2026

### Added
- **Email reader.** Click a subject in Inbox to read the whole email: text, sender, recipients, date, the earlier messages of the conversation, and the attachment list. Previous and Next buttons (and the arrow keys) move through the list. Archive, Trash, Move, Read and Star queue the action and move to the next email. On phones the reader fills the screen.
- **Fetch attachments.** A new command, `fetch_attachments`, has the agent copy one email's files into the private repository. The dashboard downloads them as files. Limits: 15 MB per file, 25 MB per email, 5 emails per run. Files are deleted after 7 days.
- **Open in Gmail** (search by Message-ID) and **Copy Gmail search** for the Gmail phone app.
- Rows show a paperclip with the number of attachments.
- The sync saves the text of each new inbox email (`bodies/`), cleaned and capped at 20,000 characters, with codes masked. Variable `MAILEAN_STORE_BODIES=0` turns it off.

### Changed
- Encryption derives the key once per run (one salt, a random IV per file), so hundreds of encrypted texts stay fast to write and read.
- The command workflow skips the follow-up sync after a run that only fetched attachments.
- Privacy policy, README, SETUP, ARCHITECTURE and SECURITY describe the stored text and files.

### Security
- Email text is never rendered as HTML. Links show their real address; suspicious emails get no clickable links. Downloads never open in the page.


## 1.0.3 - 28/11/2026

### Fixed
- The first real sync failed with Gmail API error 403 `accessNotConfigured`: the Gmail API was off in the Google Cloud project that owns the OAuth client. The agent cut the message at 160 characters, which hid the fix. Gmail errors now become one plain sentence that names the project number and says what to switch on. The dashboard shows it in the account banner.
- `docs/SETUP.md`: step A18 checks the project picker before creating the client; a new troubleshooting row covers this error.

## 1.0.2 - 28/11/2026

### Fixed
- Setup step D5 told you to use GitHub's web uploader, which silently skips `.github`, so the private repository got no workflows. The guide now uses git, and adds a check step.
- CI could try to deploy Pages from the private repository when `MAILEAN_ROLE` was not set yet. The deploy now also requires a public repository.
- A triage run before the secrets exist published an empty state branch. Publishing now needs a state file; the audit step needs an audit file.
- `.gitignore` blocks `mailean-keys/`. The guide says plainly to keep the keys folder outside the code folder, and how to replace a client secret that was uploaded by mistake.

## 1.0.1 - 28/11/2026

### Added
- `privacy.html`: privacy policy describing which Google user data Mailean reads, how it is used, stored, shared and deleted, with the Limited Use statement. Google's Branding page requires a home page and a privacy policy link before an External app can switch to "In production".
- Static footer on the home page linking the privacy policy (readable without JavaScript); links from Guide and Settings.

### Changed
- `docs/SETUP.md` part A: Branding steps (home page, privacy link, authorized domain, no logo) before publishing.

## 1.0.0 - 26/11/2026

### Added
- Agent: multi-account Gmail sync with token refresh, quota pacing (80 units/s per mailbox), timeouts and exponential backoff with `Retry-After`.
- Agent: Claude triage with structured outputs (`claude-sonnet-5-5`), 4 parallel batches, per-message cache, and a rule-based fallback when the API is missing or fails.
- Agent: prompt-injection defences: nonce-tagged JSON data block, schema enums, re-validation, suspicious flag, and no model calls on the execution path.
- Agent: commands `delete`, `archive`, `move_to_label`, `mark_read`, `star`, `bulk_trash_sender` and `unsubscribe` (RFC 8058 one-click), with strict payload validation and audit records.
- State on a private `mailean-state` branch, squashed every sync; optional AES-256-GCM encryption.
- Dashboard: connect screen with token gate, Home, Inbox, Dashboard, Cleanup, Activity, Import & export, Settings and Guide; quick start; light and dark themes; bottom tabs on phones.
- Command queue drawer with "Execute via agent", run tracking and results.
- CSV export (UTF-8 with BOM, formula-safe, ids kept as text) and import with header detection, aliases and per-row preview.
- Folder sync through OneDrive with gzip save files, per-record merge and tombstones.
- Offline support (service worker), installable manifest and icons, Content Security Policy.
- Tests: 80 Python, 27 JavaScript, 14 browser (Playwright, axe-core); five golden examples.

### Fixed after release (CI only, app unchanged)
- The first Pages deploy failed with "No artifacts named github-pages were found": the artifact was not yet listed when upload and deploy ran in one job. Build and deploy are now separate jobs, as in GitHub's own Pages template.

### Performance (measured, see docs/QUALITY.md)
- Classification of 600 new emails: 6.02 s down to 1.51 s with a simulated 0.25 s per API call (4 batches in parallel).
- Inbox render with 3,000 conversations at 4x CPU slowdown: median 155 to 204 ms down to 66 to 76 ms (icon cloning, precomputed search keys, `content-visibility`).
