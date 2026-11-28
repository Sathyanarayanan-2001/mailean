# Mailean setup guide

Version 1.0.3 · 28/11/2026

This guide takes about 30 minutes. Each step is one action. Do the parts in order.

**Words used here**

- *Repository (repo):* a project folder on GitHub.
- *Secret:* a value GitHub stores encrypted and gives only to workflows. Nobody can read it back, not even you.
- *Workflow:* a script GitHub runs for you on its own computers (GitHub Actions).
- *Refresh token:* a long-lived key that lets the agent read and change your Gmail without your password.
- *Fine-grained token:* a GitHub key you create. You limit it to one repository and a few permissions.

**What you need**

- A GitHub account (the free plan works).
- One or more Gmail accounts.
- Python 3.9 or newer on your Windows laptop (only for step B).
- An Anthropic API key (optional; without it Mailean uses built-in rules).

---

## A. Google Cloud: allow Mailean to use Gmail

1. Open the Google Cloud console at `console.cloud.google.com` and sign in with any Google account. *(Unverified link: the build environment could not open Google pages; type the address yourself.)*
2. Create a project named `mailean` (project menu at the top, then **New project**).
3. Open **APIs & Services → Library**.
4. Search for **Gmail API**.
5. Press **Enable**.
6. Open **Google Auth Platform** (search for it in the top bar). Press **Get started**.
7. Enter the app name `Mailean (personal)` and your email address as the support email.
8. Choose **External** as the audience.
9. Enter your email address as the contact, accept the policy and press **Create**.
10. Open **Branding**.
11. Under **App domain**, set **Application home page** to `https://sathyanarayanan-2001.github.io/mailean/`.
12. Set **Application privacy policy link** to `https://sathyanarayanan-2001.github.io/mailean/privacy.html`.
13. Leave **Application terms of service link** empty. It is optional.
14. Under **Authorized domains**, press **Add domain** and enter `sathyanarayanan-2001.github.io`.
    *Why:* Google needs the "top private domain" of the two links. `github.io` is a public suffix, so your own subdomain is that domain.
15. Do **not** upload an app logo. A logo makes Google require a full verification.
16. Press **Save**.
17. Open **Audience** and press **Publish app**. Confirm with **In production**.
    *Why:* while an app is in "Testing", Google expires its refresh tokens after 7 days. Publishing stops that. You do not need Google's verification for your own accounts. You will see an "unverified app" warning when you sign in; that is expected.
    If the button is still grey, hover over it: Google lists the missing field. Fill it on the Branding page and save again.
18. Check the project picker at the top still shows `mailean`, the project where you enabled the Gmail API in step 5. Then open **Clients** and press **Create client**.
    *Why:* the client and the Gmail API must be in the same project. A client in another project fails with "Gmail API has not been used in project … before or it is disabled".
19. Choose **Desktop app** as the application type, name it `mailean-desktop`, and press **Create**.
20. Press **Download JSON**. Save the file as `client_secret.json` in its own folder, for example `C:\Users\you\mailean-keys\`.
    **Never put this folder inside the `mailean` code folder.** Anything in that folder can end up in a repository when you upload the code.

> If your console still shows the older menus, the same items are under **APIs & Services → OAuth consent screen** and **APIs & Services → Credentials → Create credentials → OAuth client ID**.

## B. Sign in to each Gmail account once

1. Download and unzip Mailean on your laptop.
2. Open a terminal (Windows: **PowerShell**) in the unzipped `mailean` folder.
3. Run:
   ```
   python scripts/setup_oauth.py --client-secret-file C:\Users\you\mailean-keys\client_secret.json
   ```
4. Type a name for the first account, for example `Personal`, and press Enter.
5. Your browser opens. Choose the Gmail account.
6. On "Google hasn't verified this app", choose **Advanced**, then **Go to Mailean (personal)**.
7. Review the Gmail permission and press **Continue**. Mailean asks for the `gmail.modify` scope: it can read mail and change labels, and move mail to Trash, but it cannot delete mail permanently.
8. Return to the terminal. Type `y` to add another account, or press Enter to finish.
9. Copy the single long line the script prints. It starts with `{"client_id":`. You paste it in part D.
10. Clear the terminal (`cls` on Windows). The line works like a password.

## C. Anthropic API key (optional but recommended)

1. Open the Anthropic Console and sign in.
2. Create an API key named `mailean`.
3. Copy it. It starts with `sk-ant-`.
4. Set a monthly spend limit in the Console's billing settings.
   *Rough cost:* the first sync of 600 conversations is about 24 requests. After that, only new mail is sent. Check current prices in the Console before relying on any estimate.

## D. The private data repository

1. On GitHub, press **New repository**.
2. Name it `gmail-command-center`.
3. Choose **Private**. This matters: it will hold your email summaries.
4. Press **Create repository**.
5. Put the code in the repository. Choose one way:
   - Ask Claude to push it for you, **or**
   - with git (install it from git-scm.com if needed), in a terminal:
     ```
     git clone https://github.com/Sathyanarayanan-2001/mailean.git
     cd mailean
     git remote add data https://github.com/Sathyanarayanan-2001/gmail-command-center.git
     git push data main
     ```

   Do **not** use the web page's **uploading an existing file**. It silently skips folders whose names start with a dot, such as `.github`, so no workflows arrive. The Actions tab then shows "Get started with GitHub Actions" instead of Mailean's workflows.
6. Check the repository's file list: you should see a `.github` folder, and **no** `mailean-keys` folder.
7. Open **Settings → Secrets and variables → Actions**.
8. Under **Secrets**, press **New repository secret**. Name `MAILEAN_ACCOUNTS`. Value: the line from part B, step 9.
9. Add a second secret named `ANTHROPIC_API_KEY` with the key from part C.
10. Switch to the **Variables** tab. Press **New repository variable**. Name `MAILEAN_ROLE`. Value `data`.
   *Why:* the triage and command workflows only run where this is set, so the public copy never touches mail.
11. Open **Settings → Actions → General**. Under **Workflow permissions**, keep **Read repository contents** selected. The workflows ask for the extra rights they need.
12. Open the **Actions** tab. If asked, press **I understand my workflows, go ahead and enable them**.
13. Choose **Scheduled triage** on the left, press **Run workflow**, and then **Run workflow** again.
14. Wait about two minutes for a green tick. A branch named `mailean-state` now exists. It holds `inbox.json`.

## E. Your fine-grained token

1. On GitHub, open your profile picture → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Name it `mailean-dashboard` and pick an expiry, for example 90 days.
3. Under **Repository access**, choose **Only select repositories** and pick `gmail-command-center`.
4. Under **Repository permissions**, set **Contents** to **Read-only**.
5. Set **Actions** to **Read and write**.
6. Press **Generate token** and copy it. It starts with `github_pat_`.

## F. The public dashboard repository and GitHub Pages

1. Create a second repository named `mailean`. Choose **Public**. (Free GitHub Pages needs a public repository. This one holds code only, never data.)
2. Put the same code in it as in part D, step 5 (git, or ask Claude; not the web uploader).
3. Open **Settings → Pages**.
4. Under **Build and deployment → Source**, choose **GitHub Actions**.
5. Open **Actions**, choose **CI**, and press **Run workflow**. Tests run first, then the site deploys.
6. Open `https://sathyanarayanan-2001.github.io/mailean/` once the run is green. *(This address goes live only after this step; it could not be checked before deployment.)*

> **Only want one repository?** With GitHub Pro you can publish Pages from a private repository. Then upload once to a private `mailean` repository, set `MAILEAN_ROLE` = `data`, and change the `deploy` job condition in `.github/workflows/ci.yml` to `vars.MAILEAN_ROLE == 'data'`. The site is still public, but the repository and its data are not.

## G. Connect the dashboard

1. Open the dashboard.
2. Enter `Sathyanarayanan-2001/gmail-command-center` as the repository.
3. Paste the token from part E.
4. Untick **Remember on this device** if the computer is shared.
5. Press **Connect**. Your inbox appears.
6. On your phone, open the same address, then choose **Add to Home screen** (Android: browser menu; iPhone: Share button).

## H. Optional settings (repository variables)

| Variable | Default | What it does |
|---|---|---|
| `MAILEAN_MODEL` | `claude-sonnet-5-5` | The Claude model for triage. |
| `MAILEAN_QUERY` | `in:inbox` | Gmail search for what to triage, for example `in:inbox newer_than:30d`. |
| `MAILEAN_MAX_PER_ACCOUNT` | `300` | The most messages read per account per sync (1 to 2000). |
| `MAILEAN_STORE_SNIPPETS` | not set | Set to `1` to keep 300-character snippets in the state file. |

| Secret | What it does |
|---|---|
| `MAILEAN_STATE_PASSPHRASE` | Encrypts the state file (at least 12 characters). Enter the same passphrase in the dashboard under **Settings → Encrypted state**. |

To change how often triage runs, edit the `cron` line in `.github/workflows/scheduled-triage.yml`. GitHub uses UTC, and scheduled runs can start a few minutes late. A private repository uses GitHub Actions minutes: 6 syncs a day at about 2 minutes each is roughly 360 minutes a month. Check your plan's allowance on GitHub's billing page.

## I. Add an account later

1. Run `python scripts/setup_oauth.py --client-secret-file … --merge previous.json`, where `previous.json` is a saved copy of the old line. Without a saved copy, simply sign in to all accounts again.
2. Replace the `MAILEAN_ACCOUNTS` secret with the new line.

## J. Remove access

1. In each Gmail account, open **Google Account → Security → Your connections to third-party apps & services → See all connections**, choose **Mailean (personal)**, and remove its access.
2. On GitHub, delete the fine-grained token under **Settings → Developer settings → Personal access tokens**.
3. Delete the `MAILEAN_ACCOUNTS` secret, or the whole private repository.
4. In the dashboard, open **Settings** and press **Forget token and cached inbox**.

## Troubleshooting

| You see | Cause | Fix |
|---|---|---|
| "Google refused the saved sign-in (invalid_grant)" in the dashboard | The refresh token expired or was revoked. | Repeat part B for that account and update the secret. If it happens every 7 days, do part A, steps 10 to 17. |
| "This repository is public" | The data repository is public. | Make it private: **Settings → General → Danger zone → Change visibility**. |
| "No inbox data yet" | The first sync has not finished. | Part D, step 13. |
| "The Gmail API is turned off in the Google Cloud project that owns your OAuth client" (Gmail API error 403, `accessNotConfigured`) | The OAuth client lives in a project where the Gmail API is not enabled. | In Google Cloud, select the project with the number shown, open **APIs & Services → Library → Gmail API** and press **Enable**. Wait about 5 minutes, then run **Scheduled triage** again. |
| The Actions tab shows "Get started with GitHub Actions" | The `.github` folder is missing: the web uploader skips folders starting with a dot. | Part D, step 5: push with git, or ask Claude. |
| A `mailean-keys` folder is in the repository | The keys folder sat inside the code folder when it was uploaded. | Delete the folder from the repository. Then, in Google Auth Platform → **Clients**, delete `mailean-desktop` and create a new Desktop client (part A, steps 18 to 20), so the uploaded secret no longer works. |
| Execute waits at "Waiting for GitHub to start the run" | Actions is busy, or `MAILEAN_ROLE` is missing. | Check the **Actions** tab. Make sure the variable is set in the private repository. |
| "The token is not allowed to …" | Token permissions are too narrow. | Part E, steps 3 to 5. |
