"""Retry/backoff behaviour and secret parsing."""

import json

import pytest

from agent import http
from agent.config import ConfigError, parse_accounts_secret
from agent.http import HttpError, Response, backoff_delay


class Script:
    """A fake network that replays a list of responses or exceptions."""

    def __init__(self, items):
        self.items = list(items)
        self.calls = 0

    def __call__(self, req, timeout):
        self.calls += 1
        item = self.items.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def ok(body=None):
    return Response(200, json.dumps(body or {"ok": True}).encode(), {})


def err(status, reason="", headers=None):
    body = {"error": {"code": status, "message": "x", "errors": [{"reason": reason}]}}
    return Response(status, json.dumps(body).encode(), headers or {})


def run(items, **kw):
    sleeps = []
    script = Script(items)
    http.set_transport(script, sleeps.append)
    try:
        return http.request("GET", "https://example.test/x", **kw), script.calls, sleeps
    finally:
        http.set_transport(sleep=lambda s: None)


def test_retries_429_then_succeeds_and_honours_retry_after():
    resp, calls, sleeps = run([err(429, headers={"retry-after": "3"}), ok()])
    assert resp.status == 200 and calls == 2 and sleeps == [3.0]


def test_retries_gmail_user_rate_limit_403():
    _, calls, _ = run([err(403, "userRateLimitExceeded"), err(503), ok()])
    assert calls == 3


def test_does_not_retry_plain_403_or_400():
    with pytest.raises(HttpError) as e:
        run([err(403, "insufficientPermissions"), ok()])
    assert e.value.status == 403
    with pytest.raises(HttpError):
        run([err(400, "invalid"), ok()])


def test_network_errors_retry_then_give_up():
    with pytest.raises(HttpError) as e:
        run([OSError("reset")] * 3, retries=2)
    assert e.value.status == 0


def test_backoff_grows_and_caps():
    assert 1 <= backoff_delay(0) < 2
    assert 8 <= backoff_delay(3) < 9
    assert backoff_delay(10) == 32.0
    assert backoff_delay(0, "120") == 32.0


GOOD = {"client_id": "123-abc.apps.googleusercontent.com", "client_secret": "s",
        "accounts": [{"id": "account_1", "label": "Personal", "email": "a@x.test", "refresh_token": "r1"},
                     {"id": "account_2", "label": "Work", "refresh_token": "r2"}]}


def test_parse_accounts_ok():
    cid, secret, accts = parse_accounts_secret(json.dumps(GOOD))
    assert cid.endswith("googleusercontent.com") and [a.id for a in accts] == ["account_1", "account_2"]


@pytest.mark.parametrize("mutate,needle", [
    (lambda d: d.update(client_id="nope"), "client ID"),
    (lambda d: d.update(accounts=[]), "at least one"),
    (lambda d: d["accounts"].append(dict(d["accounts"][0])), "appears twice"),
    (lambda d: d["accounts"][0].update(id="Account 1"), "lower-case"),
    (lambda d: d["accounts"][0].update(refresh_token=""), "refresh_token"),
])
def test_parse_accounts_errors_are_actionable(mutate, needle):
    data = json.loads(json.dumps(GOOD))
    mutate(data)
    with pytest.raises(ConfigError, match=needle):
        parse_accounts_secret(json.dumps(data))


def test_parse_accounts_bad_json():
    with pytest.raises(ConfigError, match="not valid JSON"):
        parse_accounts_secret("{oops")
