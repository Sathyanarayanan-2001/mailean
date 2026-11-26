# Contributing

Version 1.0.0 · 26/11/2026

Thank you for helping. This is a personal tool, so keep changes small and focused.

## Ground rules

1. Never commit real email data, tokens, exports, backups or folder-sync save files. `.gitignore` blocks the usual names. Check `git status` before every commit.
2. Tests use made-up names, addresses and amounts only. Use the `.test` domain for addresses.
3. Hold money as integer paise. Never add rupees as floating-point numbers.
4. Treat every email field as untrusted. Render with `textContent`, never `innerHTML`.
5. Comments explain *why*, not *what*.

## Workflow

1. Create a branch: `git switch -c feature/short-name`.
2. Make the change, with a test that would fail without it.
3. Run the checks:
   ```bash
   python -m pytest tests/python
   npm test
   python scripts/eval_golden.py --rules
   python -m pytest tests/e2e
   ```
4. If you changed the triage prompt or schema, run `python scripts/eval_golden.py` with `ANTHROPIC_API_KEY` set, and paste the scores in the pull request.
5. If you changed the UI, attach screenshots at 320 px, 390 px and desktop width, in light and dark.
6. Open a pull request. CI must pass before you merge.
7. Add a line to `CHANGELOG.md` and bump the version in `agent/__init__.py`, `docs/app.js`, `docs/sw.js` (cache name) and `package.json`.

## Regenerating fixtures

- Demo data: `python scripts/make_demo_state.py`
- Oracles for the JavaScript tests: `python scripts/make_oracles.py`
- Lock files: `pip-compile --generate-hashes --strip-extras requirements.in` and `requirements-dev.in`; `npm install --package-lock-only`.
