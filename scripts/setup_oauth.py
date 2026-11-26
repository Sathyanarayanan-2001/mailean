#!/usr/bin/env python3
"""Sign in to one or more Gmail accounts once, and print the MAILEAN_ACCOUNTS secret.

Runs on Windows, macOS or Linux with plain Python 3.9+ (no packages to install).

    python scripts/setup_oauth.py --client-secret-file "C:\\Users\\me\\Downloads\\client_secret.json"

For each account it opens your browser, you approve access, and it captures a
refresh token on a temporary local address (127.0.0.1). At the end it prints one
JSON value. Paste it into the private repository as the secret MAILEAN_ACCOUNTS.

The output is a password-equivalent. Do not save it inside the repository.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import http.server
import json
import re
import secrets
import socket
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile"
SCOPE = "https://www.googleapis.com/auth/gmail.modify"
ACCOUNT_ID_RE = re.compile(r"^[a-z0-9_]{1,32}$")
TIMEOUT_SECONDS = 300


def pkce_pair() -> tuple[str, str]:
    """PKCE (RFC 7636): proves the code exchange comes from this script."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode("ascii")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    return verifier, challenge


def build_auth_url(client_id: str, redirect_uri: str, challenge: str, state: str, login_hint: str = "") -> str:
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        # offline + consent make Google return a refresh token every time.
        "access_type": "offline",
        "prompt": "consent",
    }
    if login_hint:
        params["login_hint"] = login_hint
    return f"{AUTH_URL}?{urllib.parse.urlencode(params)}"


def load_client(path: Path | None) -> tuple[str, str]:
    if path:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            sys.exit(f"Could not read {path}: {exc}. Download the JSON again from Google Cloud Console.")
        block = data.get("installed") or data.get("web") or {}
        if "web" in data:
            print("Note: this is a 'Web application' client. Create a 'Desktop app' client instead if sign-in fails.")
        cid, secret = block.get("client_id", ""), block.get("client_secret", "")
    else:
        cid = input("OAuth client ID: ").strip()
        secret = getpass.getpass("OAuth client secret (hidden): ").strip()
    if not cid.endswith(".apps.googleusercontent.com") or not secret:
        sys.exit("That client ID or secret does not look right. See docs/SETUP.md, step 1.")
    return cid, secret


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_code(port: int, expected_state: str) -> str:
    """Serve one request on 127.0.0.1:port and return the ?code=… value."""
    result: dict[str, str] = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            if query.get("state", [""])[0] != expected_state:
                result["error"] = "state mismatch (possible cross-site request); try again"
            elif "error" in query:
                result["error"] = query["error"][0]
            else:
                result["code"] = query.get("code", [""])[0]
            ok = "code" in result
            body = ("<h1>Mailean: signed in</h1><p>You can close this tab and return to the terminal.</p>" if ok
                    else "<h1>Mailean: sign-in failed</h1><p>Return to the terminal for details.</p>")
            self.send_response(200 if ok else 400)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))

        def log_message(self, *args):  # keep the terminal clean
            pass

    server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    server.timeout = TIMEOUT_SECONDS
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()
    thread.join(TIMEOUT_SECONDS + 5)
    server.server_close()
    if "code" in result and result["code"]:
        return result["code"]
    sys.exit(f"Sign-in did not complete: {result.get('error', 'timed out after 5 minutes')}.")


def post_form(url: str, form: dict[str, str]) -> dict:
    data = urllib.parse.urlencode(form).encode("ascii")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - fixed Google host
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        sys.exit(f"Google returned HTTP {exc.code}: {detail}")
    except urllib.error.URLError as exc:
        sys.exit(f"Could not reach Google ({exc.reason}). Check your internet connection and try again.")


def get_json(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - fixed Google host
        return json.loads(resp.read().decode("utf-8"))


def authorise_one(client_id: str, client_secret: str, hint: str = "") -> tuple[str, str]:
    port = free_port()
    redirect_uri = f"http://127.0.0.1:{port}/"
    verifier, challenge = pkce_pair()
    state = secrets.token_urlsafe(24)
    url = build_auth_url(client_id, redirect_uri, challenge, state, hint)
    print("\nOpening your browser to sign in. If it does not open, copy this address into it:\n" + url + "\n")
    webbrowser.open(url)
    code = wait_for_code(port, state)
    tokens = post_form(TOKEN_URL, {
        "code": code, "client_id": client_id, "client_secret": client_secret,
        "code_verifier": verifier, "grant_type": "authorization_code", "redirect_uri": redirect_uri,
    })
    refresh = tokens.get("refresh_token", "")
    if not refresh:
        sys.exit("Google did not return a refresh token. Remove Mailean at "
                 "https://myaccount.google.com/permissions and run this again.")
    email = ""
    try:
        email = get_json(PROFILE_URL, tokens.get("access_token", "")).get("emailAddress", "")
    except (urllib.error.URLError, ValueError):
        print("Signed in, but could not read the address. That is fine; continuing.")
    return email, refresh


def assemble(client_id: str, client_secret: str, accounts: list[dict]) -> str:
    """The exact MAILEAN_ACCOUNTS value: compact JSON on one line."""
    ids = [a["id"] for a in accounts]
    if len(ids) != len(set(ids)) or not all(ACCOUNT_ID_RE.match(i) for i in ids):
        raise ValueError("account ids must be unique and use a-z, 0-9 and _")
    return json.dumps({"client_id": client_id, "client_secret": client_secret, "accounts": accounts},
                      separators=(",", ":"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--client-secret-file", type=Path, help="Desktop-app OAuth JSON from Google Cloud Console")
    parser.add_argument("--merge", type=Path, help="A previous output file, to add accounts to it")
    parser.add_argument("--out", type=Path, help="Also save the result here (keep it OUTSIDE the repository)")
    args = parser.parse_args()

    client_id, client_secret = load_client(args.client_secret_file)
    accounts: list[dict] = []
    if args.merge:
        prev = json.loads(args.merge.read_text(encoding="utf-8"))
        accounts = list(prev.get("accounts", []))
        print(f"Loaded {len(accounts)} existing account(s) from {args.merge}.")
    while True:
        n = len(accounts) + 1
        default_label = ["Personal", "Work"][n - 1] if n <= 2 else f"Account {n}"
        label = input(f"Name for account {n} [{default_label}]: ").strip()[:40] or default_label
        email, refresh = authorise_one(client_id, client_secret)
        accounts.append({"id": f"account_{n}", "label": label, "email": email, "refresh_token": refresh})
        print(f"Added account_{n} ({label}{', ' + email if email else ''}).")
        if input("Add another Gmail account? [y/N]: ").strip().lower() not in ("y", "yes"):
            break
    value = assemble(client_id, client_secret, accounts)
    if args.out:
        out = args.out.resolve()
        if (Path.cwd() / ".git").exists() and Path.cwd().resolve() in out.parents:
            sys.exit("Refusing to save inside this git repository. Choose a folder outside it.")
        out.write_text(value, encoding="utf-8")
        print(f"Saved to {out}")
    print("\nCopy everything on the next line into the GitHub secret MAILEAN_ACCOUNTS:\n")
    print(value)
    print("\nThen clear your terminal history if others use this computer.")


if __name__ == "__main__":
    main()
