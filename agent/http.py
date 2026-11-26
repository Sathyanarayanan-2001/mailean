"""HTTP with timeouts, retry and exponential backoff, using only the standard library.

Why the standard library: the same helper is shared by setup_oauth.py, which the
user runs on a Windows laptop with no extra installs.
"""

from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}
# Gmail reports per-user rate limits as 403 with these reasons, not as 429.
RETRYABLE_REASONS = {"rateLimitExceeded", "userRateLimitExceeded", "backendError"}


class HttpError(Exception):
    def __init__(self, status: int, message: str, reason: str = ""):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.reason = reason
        self.message = message


@dataclass
class Response:
    status: int
    body: bytes
    headers: dict[str, str]

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8")) if self.body else {}


# Indirection so tests can replace the network without monkeypatching urllib.
Opener = Callable[[urllib.request.Request, float], Response]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse redirects: an unsubscribe link must not bounce us to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


_NO_REDIRECT = urllib.request.build_opener(_NoRedirect)


def _default_opener(req: urllib.request.Request, timeout: float) -> Response:
    open_fn = _NO_REDIRECT.open if getattr(req, "no_redirect", False) else urllib.request.urlopen
    try:
        with open_fn(req, timeout=timeout) as resp:  # noqa: S310 - https only, checked by callers
            return Response(resp.status, resp.read(), {k.lower(): v for k, v in resp.headers.items()})
    except urllib.error.HTTPError as exc:
        body = exc.read() if hasattr(exc, "read") else b""
        return Response(exc.code, body, {k.lower(): v for k, v in (exc.headers or {}).items()})


_opener: Opener = _default_opener
_sleep: Callable[[float], None] = time.sleep


def set_transport(opener: Opener | None = None, sleep: Callable[[float], None] | None = None) -> None:
    """Swap the network layer (tests use a fake Gmail)."""
    global _opener, _sleep
    _opener = opener or _default_opener
    _sleep = sleep or time.sleep


def _error_reason(resp: Response) -> tuple[str, str]:
    try:
        data = resp.json()
    except (ValueError, UnicodeDecodeError):
        return "", resp.body[:200].decode("utf-8", "replace")
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            reasons = [e.get("reason", "") for e in err.get("errors", []) if isinstance(e, dict)]
            return (reasons[0] if reasons else str(err.get("status", ""))), str(err.get("message", ""))[:300]
        if isinstance(err, str):
            return err, str(data.get("error_description", err))[:300]
    return "", ""


def backoff_delay(attempt: int, retry_after: str | None = None, cap: float = 32.0) -> float:
    """Seconds to wait before retry number `attempt` (0-based).

    Honour Retry-After when the server sends a number of seconds; otherwise
    2**attempt plus up to 1 s of jitter, so parallel workers do not retry in step.
    """
    if retry_after and retry_after.strip().isdigit():
        return min(float(retry_after.strip()), cap)
    return min((2 ** attempt) + random.random(), cap)


def request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    json_body: Any = None,
    form: dict[str, str] | None = None,
    timeout: float = 20.0,
    retries: int = 5,
    allow_redirects: bool = True,
) -> Response:
    """Send a request; retry transient failures; raise HttpError on final failure."""
    data: bytes | None = None
    hdrs = {"Accept": "application/json", "User-Agent": "mailean-agent/1.0"}
    hdrs.update(headers or {})
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    elif form is not None:
        data = urllib.parse.urlencode(form).encode("ascii")
        hdrs["Content-Type"] = "application/x-www-form-urlencoded"
    last_error: HttpError | None = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        req.no_redirect = not allow_redirects  # type: ignore[attr-defined]
        try:
            resp = _opener(req, timeout)
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
            last_error = HttpError(0, f"network error: {exc.__class__.__name__}")
            if attempt < retries:
                _sleep(backoff_delay(attempt))
                continue
            raise last_error from None
        if 200 <= resp.status < 300:
            return resp
        reason, message = _error_reason(resp)
        last_error = HttpError(resp.status, message or "request failed", reason)
        retryable = resp.status in RETRYABLE_STATUS or (resp.status == 403 and reason in RETRYABLE_REASONS)
        if retryable and attempt < retries:
            _sleep(backoff_delay(attempt, resp.headers.get("retry-after")))
            continue
        raise last_error
    raise last_error or HttpError(0, "request failed")
