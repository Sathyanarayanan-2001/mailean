# Security policy

Version 1.0.0 · 26/11/2026

## Reporting a problem

Please do not open a public issue for a security problem. Use GitHub's **Report a vulnerability** button on the repository's Security tab. You will get a reply within 7 days.

## What Mailean protects, and how

| Asset | Where it lives | Protection |
|---|---|---|
| Gmail refresh tokens and OAuth client | GitHub secret `MAILEAN_ACCOUNTS` (private repo) | Encrypted by GitHub; read only by workflows; access tokens masked in logs (`::add-mask::`). |
| Anthropic API key | GitHub secret `ANTHROPIC_API_KEY` | As above. Set a spend limit in the Anthropic Console. |
| Email summaries | `mailean-state` branch of the private repo | Private repository; workflows refuse to run if it is public; history squashed each sync; optional AES-256-GCM (`MAILEAN_STATE_PASSPHRASE`). |
| GitHub fine-grained token | Your browser (localStorage, or this tab only) | One repository; Contents read, Actions read and write; set an expiry. |

## Known risks you should understand

1. **Shared browser origin.** Every GitHub Pages project of one account is served from `https://<account>.github.io`. A script bug in *any* of your other Pages projects could read Mailean's localStorage, including the token. Mitigations: the token is limited to one repository and cannot read code elsewhere; untick "Remember on this device" to keep it in the tab only; give the token a short expiry; or serve Mailean from its own custom domain.
2. **The `gmail.modify` scope** can read mail and move mail to Trash. It cannot delete permanently. Mailean never sends mail. Revoke access at any time under **Google Account → Security → Your connections to third-party apps & services**.
3. **Unverified OAuth app.** Publishing your own app as "In production" without verification is meant for personal use only. Do not share the client with others.
4. **Prompt injection.** Emails may try to manipulate the triage. Model output is limited to labels and summaries, and it can never execute an action. Suspicious rows are flagged and are never auto-staged.
5. **Unsubscribe links** come from the sender. The agent only POSTs to public `https` hosts, refuses IP literals and local names, and does not follow redirects.
6. **Workflow inputs** reach the agent through environment variables, never through shell text. The payload is validated against a strict schema with an allow-list of operations.

## Supply chain

- Python dependencies are pinned with hashes (`requirements.txt`, installed with `--require-hashes`).
- GitHub Actions are pinned to full commit SHAs. Dependabot proposes weekly updates.
- The dashboard has no runtime dependencies. Fonts and icons are self-hosted. The Content Security Policy allows only this site and `api.github.com`.
