# Changelog

All notable changes are listed here. Dates are day first. Versions follow semantic versioning.

## Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 1.0.0 | 26/11/2026 | Sathyanarayanan, with Claude | First release. |
| 1.0.0 (CI) | 26/11/2026 | Sathyanarayanan, with Claude | Pages build and deploy split into two jobs. |
| 1.0.1 | 28/11/2026 | Sathyanarayanan, with Claude | Privacy policy page, so the Google OAuth app can be published. |

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
