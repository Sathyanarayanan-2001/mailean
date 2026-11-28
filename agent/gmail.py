"""Thin Gmail REST client: token refresh, quota pacing, and the few calls we need."""

from __future__ import annotations

import os
import re
import threading
import time
import urllib.parse
from typing import Any, Iterable

from . import http

TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://gmail.googleapis.com/gmail/v1/users/me"
MESSAGE_ID_RE = re.compile(r"^[0-9A-Za-z]{6,64}$")
BATCH_MODIFY_LIMIT = 1000  # Gmail's documented maximum ids per batchModify call

# Quota units per method (Gmail API reference, "Per-method quota usage").
# Quota units per call, from Google's "Usage limits" page for the Gmail API, which
# changed on 1 May 2026: messages.get costs 20, or 60 with format=full.
COST = {"get": 20, "get_full": 60, "attachment": 20, "list": 5, "batchModify": 50, "trash": 20,
        "labels.list": 1, "labels.create": 5, "profile": 1}
USER_UNITS_PER_MINUTE = 6_000  # per user, per project


class AuthError(Exception):
    """The refresh token no longer works; the user must re-run setup_oauth.py."""


class QuotaPacer:
    """Token bucket that keeps one mailbox under its per-user quota.

    Google allows 6,000 quota units per user per minute (100 a second). We pace
    at 80 a second to leave headroom for retries; parallel fetch threads share
    one bucket. A call dearer than the bucket waits for a full bucket and then
    runs into debt, which later calls repay, so the long-run rate always holds.
    """

    def __init__(self, units_per_second: float = USER_UNITS_PER_MINUTE / 60 * 0.8, clock=time.monotonic, sleep=time.sleep):
        self.rate = units_per_second
        self.capacity = units_per_second
        self.tokens = units_per_second
        self.clock = clock
        self.sleep = sleep
        self.last = clock()
        self.lock = threading.Lock()

    def take(self, units: int) -> None:
        while True:
            with self.lock:
                now = self.clock()
                self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.rate)
                self.last = now
                need = min(units, self.capacity)
                if self.tokens >= need:
                    self.tokens -= units
                    return
                wait = (need - self.tokens) / self.rate
            self.sleep(wait)


_PROJECT_RE = re.compile(r"project (\d{6,})")


def explain_api_error(exc: http.HttpError) -> str:
    """Turn a Gmail API error into one plain sentence that says how to fix it.

    The raw message is long and was cut short in logs and on the dashboard, which
    hid the useful part (which Google Cloud project, and what to switch on).
    """
    reason = exc.reason or ""
    project = _PROJECT_RE.search(exc.message or "")
    where = f" (project number {project.group(1)})" if project else ""
    if reason in ("accessNotConfigured", "SERVICE_DISABLED") or "has not been used in project" in (exc.message or ""):
        return (f"The Gmail API is turned off in the Google Cloud project that owns your OAuth client{where}. "
                "In Google Cloud, select that project, open APIs & Services > Library > Gmail API and press Enable. "
                "Wait about 5 minutes, then run Scheduled triage again.")
    if reason in ("insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"):
        return ("The saved sign-in does not include Gmail access. Run scripts/setup_oauth.py again, allow the Gmail "
                "permission, and update the MAILEAN_ACCOUNTS secret.")
    if exc.status == 429 or reason in ("rateLimitExceeded", "userRateLimitExceeded"):
        return "Gmail's rate limit was still reached after several retries. The next scheduled run will try again."
    if exc.status >= 500 or exc.status == 0:
        return f"Gmail could not be reached (HTTP {exc.status or 'no response'}). The next scheduled run will try again."
    return f"Gmail API error {exc.status} ({reason or 'no reason given'}): {(exc.message or '')[:300]}"


def mask_in_actions_log(secret: str) -> None:
    """Ask GitHub Actions to hide a value derived at runtime (access tokens are not secrets)."""
    if secret and os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::add-mask::{secret}", flush=True)


def refresh_access_token(client_id: str, client_secret: str, refresh_token: str) -> str:
    try:
        resp = http.request(
            "POST",
            TOKEN_URL,
            form={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
            retries=3,
        )
    except http.HttpError as exc:
        if exc.status in (400, 401) and exc.reason in ("invalid_grant", "unauthorized_client", "invalid_client"):
            raise AuthError(
                f"Google refused the saved sign-in ({exc.reason}). Run scripts/setup_oauth.py again "
                "for this account and update the MAILEAN_ACCOUNTS secret. If this keeps happening "
                "every 7 days, set the OAuth app's publishing status to 'In production'."
            ) from None
        raise
    token = resp.json().get("access_token", "")
    if not token:
        raise AuthError("Google returned no access token. Run scripts/setup_oauth.py again.")
    mask_in_actions_log(token)
    return token


class Gmail:
    def __init__(self, access_token: str, pacer: QuotaPacer | None = None):
        self.headers = {"Authorization": f"Bearer {access_token}"}
        self.pacer = pacer or QuotaPacer()

    def _call(self, method: str, path: str, cost_key: str, **kwargs: Any) -> dict:
        self.pacer.take(COST[cost_key])
        return http.request(method, f"{API}{path}", headers=self.headers, **kwargs).json()

    def profile(self) -> dict:
        return self._call("GET", "/profile", "profile")

    def list_message_ids(self, query: str, limit: int) -> list[tuple[str, str]]:
        """Return up to `limit` (message_id, thread_id) pairs, newest first."""
        found: list[tuple[str, str]] = []
        page_token = ""
        while len(found) < limit:
            params = {"q": query, "maxResults": str(min(500, limit - len(found)))}
            if page_token:
                params["pageToken"] = page_token
            data = self._call("GET", "/messages?" + urllib.parse.urlencode(params), "list")
            for item in data.get("messages", []) or []:
                mid, tid = str(item.get("id", "")), str(item.get("threadId", ""))
                if MESSAGE_ID_RE.match(mid) and MESSAGE_ID_RE.match(tid):
                    found.append((mid, tid))
            page_token = data.get("nextPageToken", "")
            if not page_token:
                break
        return found[:limit]

    def get_metadata(self, message_id: str, extra_headers: Iterable[str] = ()) -> dict:
        if not MESSAGE_ID_RE.match(message_id):
            raise ValueError("invalid message id")
        names = ["From", "To", "Cc", "Subject", "Date", "Message-ID", "List-Unsubscribe", "List-Unsubscribe-Post", *extra_headers]
        query = urllib.parse.urlencode([("format", "metadata")] + [("metadataHeaders", n) for n in names])
        return self._call("GET", f"/messages/{message_id}?{query}", "get")

    def get_full(self, message_id: str) -> dict:
        """Whole message structure: headers, text parts inline, attachments as ids (3x the quota of metadata)."""
        if not MESSAGE_ID_RE.match(message_id):
            raise ValueError("invalid message id")
        return self._call("GET", f"/messages/{message_id}?format=full", "get_full")

    def get_attachment(self, message_id: str, attachment_id: str) -> bytes:
        if not MESSAGE_ID_RE.match(message_id):
            raise ValueError("invalid message id")
        # Attachment ids are long base64url strings from Gmail itself; quote them for the path.
        aid = urllib.parse.quote(attachment_id, safe="")
        data = self._call("GET", f"/messages/{message_id}/attachments/{aid}", "attachment", timeout=60)
        from .bodies import b64url_decode
        return b64url_decode(str(data.get("data", "")))

    def batch_modify(self, ids: list[str], add: list[str] | None = None, remove: list[str] | None = None) -> int:
        done = 0
        for start in range(0, len(ids), BATCH_MODIFY_LIMIT):
            chunk = ids[start : start + BATCH_MODIFY_LIMIT]
            body = {"ids": chunk, "addLabelIds": add or [], "removeLabelIds": remove or []}
            self._call("POST", "/messages/batchModify", "batchModify", json_body=body)
            done += len(chunk)
        return done

    def trash(self, message_id: str) -> None:
        if not MESSAGE_ID_RE.match(message_id):
            raise ValueError("invalid message id")
        self._call("POST", f"/messages/{message_id}/trash", "trash", json_body={})

    def labels(self) -> dict[str, str]:
        """Map lower-cased label name -> label id."""
        data = self._call("GET", "/labels", "labels.list")
        return {str(l.get("name", "")).lower(): str(l.get("id", "")) for l in data.get("labels", []) or []}

    def ensure_label(self, name: str, cache: dict[str, str]) -> str:
        key = name.lower()
        if key in cache:
            return cache[key]
        created = self._call(
            "POST",
            "/labels",
            "labels.create",
            json_body={"name": name, "labelListVisibility": "labelShow", "messageListVisibility": "show"},
        )
        cache[key] = str(created.get("id", ""))
        return cache[key]


def headers_of(message: dict) -> dict[str, str]:
    """Header list -> dict (first occurrence wins, names lower-cased)."""
    result: dict[str, str] = {}
    for h in (message.get("payload") or {}).get("headers", []) or []:
        name = str(h.get("name", "")).lower()
        if name and name not in result:
            result[name] = str(h.get("value", ""))
    return result
