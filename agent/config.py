"""Configuration: paths, accounts and tunables, all read from the environment."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

ACCOUNT_ID_RE = re.compile(r"^[a-z0-9_]{1,32}$")

# The six buckets from the brief. Keys are stable identifiers stored in state;
# names are what the dashboard shows. Order here is the display order.
GROUPS = {
    "action_required": "Action Required",
    "awaiting_reply": "Awaiting Reply",
    "receipts_finance": "Receipts & Finance",
    "newsletters_reading": "Newsletters & Reading",
    "promotions_spam": "Promotions & Spam",
    "low_priority": "Low Priority / Archive",
}

SUGGESTED_ACTIONS = (
    "none",
    "reply",
    "archive",
    "mark_read",
    "move_to_label",
    "delete",
    "unsubscribe",
    "star",
)


class ConfigError(Exception):
    """A configuration problem the user must fix; the message says how."""


@dataclass(frozen=True)
class Account:
    id: str
    label: str
    email: str
    refresh_token: str


@dataclass(frozen=True)
class Settings:
    client_id: str
    client_secret: str
    accounts: tuple[Account, ...]
    query: str
    max_per_account: int
    model: str
    anthropic_key: str | None
    state_passphrase: str | None
    state_dir: Path
    store_snippets: bool = False

    @property
    def state_file(self) -> Path:
        return self.state_dir / "inbox.json"

    @property
    def audit_dir(self) -> Path:
        return self.state_dir / "audit"

    def account(self, account_id: str) -> Account | None:
        for acct in self.accounts:
            if acct.id == account_id:
                return acct
        return None


def _int_env(name: str, default: int, low: int, high: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    if not raw.isdigit():
        raise ConfigError(f"{name} must be a whole number between {low} and {high}; got {raw!r}.")
    value = int(raw)
    if not low <= value <= high:
        raise ConfigError(f"{name} must be between {low} and {high}; got {value}.")
    return value


def parse_accounts_secret(raw: str) -> tuple[str, str, tuple[Account, ...]]:
    """Parse the MAILEAN_ACCOUNTS secret written by scripts/setup_oauth.py."""
    if not raw or not raw.strip():
        raise ConfigError(
            "The MAILEAN_ACCOUNTS secret is empty. Run scripts/setup_oauth.py on your "
            "computer and paste its output into the repository secret."
        )
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigError(
            f"MAILEAN_ACCOUNTS is not valid JSON (line {exc.lineno}, column {exc.colno}). "
            "Paste the whole output of setup_oauth.py, including the outer braces."
        ) from None
    if not isinstance(data, dict):
        raise ConfigError("MAILEAN_ACCOUNTS must be a JSON object with client_id, client_secret and accounts.")
    client_id = str(data.get("client_id", "")).strip()
    client_secret = str(data.get("client_secret", "")).strip()
    if not client_id.endswith(".apps.googleusercontent.com"):
        raise ConfigError("MAILEAN_ACCOUNTS.client_id does not look like a Google OAuth client ID.")
    if not client_secret:
        raise ConfigError("MAILEAN_ACCOUNTS.client_secret is missing.")
    raw_accounts = data.get("accounts")
    if not isinstance(raw_accounts, list) or not raw_accounts:
        raise ConfigError("MAILEAN_ACCOUNTS.accounts must list at least one account.")
    seen: set[str] = set()
    accounts: list[Account] = []
    for index, item in enumerate(raw_accounts, start=1):
        if not isinstance(item, dict):
            raise ConfigError(f"Account #{index} in MAILEAN_ACCOUNTS is not an object.")
        acct_id = str(item.get("id", "")).strip()
        if not ACCOUNT_ID_RE.match(acct_id):
            raise ConfigError(
                f"Account #{index} has id {acct_id!r}. Use lower-case letters, digits and "
                "underscores only, for example account_1."
            )
        if acct_id in seen:
            raise ConfigError(f"Account id {acct_id!r} appears twice in MAILEAN_ACCOUNTS.")
        seen.add(acct_id)
        token = str(item.get("refresh_token", "")).strip()
        if not token:
            raise ConfigError(f"Account {acct_id} has no refresh_token. Run setup_oauth.py again.")
        label = str(item.get("label", acct_id)).strip()[:40] or acct_id
        email = str(item.get("email", "")).strip()[:254]
        accounts.append(Account(acct_id, label, email, token))
    return client_id, client_secret, tuple(accounts)


def load_settings(require_accounts: bool = True) -> Settings:
    state_dir = Path(os.environ.get("MAILEAN_STATE_DIR") or (REPO_ROOT / "state"))
    if require_accounts:
        client_id, client_secret, accounts = parse_accounts_secret(os.environ.get("MAILEAN_ACCOUNTS", ""))
    else:
        client_id, client_secret, accounts = "", "", ()
    query = os.environ.get("MAILEAN_QUERY", "in:inbox").strip() or "in:inbox"
    if len(query) > 300 or any(ord(ch) < 32 for ch in query):
        raise ConfigError("MAILEAN_QUERY must be a single line of at most 300 characters.")
    passphrase = os.environ.get("MAILEAN_STATE_PASSPHRASE") or None
    if passphrase is not None and len(passphrase) < 12:
        raise ConfigError("MAILEAN_STATE_PASSPHRASE must be at least 12 characters long, or left unset.")
    return Settings(
        client_id=client_id,
        client_secret=client_secret,
        accounts=accounts,
        query=query,
        max_per_account=_int_env("MAILEAN_MAX_PER_ACCOUNT", 300, 1, 2000),
        model=os.environ.get("MAILEAN_MODEL", "claude-sonnet-5-5").strip() or "claude-sonnet-5-5",
        anthropic_key=os.environ.get("ANTHROPIC_API_KEY") or None,
        state_passphrase=passphrase,
        state_dir=state_dir,
        # Snippets often hold one-time codes and private text, so they stay out of
        # the repository unless the owner opts in.
        store_snippets=os.environ.get("MAILEAN_STORE_SNIPPETS", "").strip() == "1",
    )
