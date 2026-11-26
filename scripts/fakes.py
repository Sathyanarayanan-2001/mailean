"""An in-memory Gmail used by the tests and by make_demo_state.py.

It implements the same methods as agent.gmail.Gmail, with a tiny query parser
for the few search terms Mailean uses. All data is made up.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class FakeMessage:
    id: str
    thread_id: str
    sender: str
    subject: str
    snippet: str
    internal_ms: int
    labels: list[str] = field(default_factory=lambda: ["INBOX", "UNREAD"])
    unsubscribe: str = ""
    unsubscribe_post: str = ""


class FakeGmail:
    def __init__(self, email: str, messages: list[FakeMessage]):
        self.email = email
        self.messages = {m.id: m for m in messages}
        self.label_ids = {"inbox": "INBOX", "starred": "STARRED", "unread": "UNREAD"}
        self.calls: list[tuple] = []
        self.fail_ids: set[str] = set()

    # --- read
    def profile(self) -> dict:
        self.calls.append(("profile",))
        return {"emailAddress": self.email, "messagesTotal": len(self.messages)}

    def _match(self, m: FakeMessage, query: str) -> bool:
        if "in:inbox" in query and "INBOX" not in m.labels:
            return False
        if "-in:trash" in query and "TRASH" in m.labels:
            return False
        if "in:trash" not in query and "TRASH" in m.labels:
            return False
        if "-is:starred" in query and "STARRED" in m.labels:
            return False
        sender = re.search(r'from:"([^"]+)"', query)
        if sender and sender.group(1).lower() not in m.sender.lower():
            return False
        return True

    def list_message_ids(self, query: str, limit: int) -> list[tuple[str, str]]:
        self.calls.append(("list", query, limit))
        hits = [m for m in self.messages.values() if self._match(m, query)]
        hits.sort(key=lambda m: (m.internal_ms, m.id), reverse=True)
        return [(m.id, m.thread_id) for m in hits[:limit]]

    def get_metadata(self, message_id: str, extra_headers=()) -> dict:
        self.calls.append(("get", message_id))
        m = self.messages[message_id]
        headers = [{"name": "From", "value": m.sender}, {"name": "Subject", "value": m.subject}]
        if m.unsubscribe:
            headers.append({"name": "List-Unsubscribe", "value": m.unsubscribe})
        if m.unsubscribe_post:
            headers.append({"name": "List-Unsubscribe-Post", "value": m.unsubscribe_post})
        return {"id": m.id, "threadId": m.thread_id, "labelIds": list(m.labels), "snippet": m.snippet,
                "internalDate": str(m.internal_ms), "payload": {"headers": headers}}

    # --- write
    def batch_modify(self, ids, add=None, remove=None) -> int:
        from agent.http import HttpError

        self.calls.append(("batchModify", tuple(ids), tuple(add or []), tuple(remove or [])))
        if self.fail_ids & set(ids):
            raise HttpError(500, "simulated failure")
        for i in ids:
            m = self.messages[i]
            m.labels = [l for l in m.labels if l not in (remove or [])]
            for l in add or []:
                if l not in m.labels:
                    m.labels.append(l)
        return len(ids)

    def trash(self, message_id: str) -> None:
        from agent.http import HttpError

        self.calls.append(("trash", message_id))
        if message_id in self.fail_ids:
            raise HttpError(500, "simulated failure")
        if message_id not in self.messages:
            raise HttpError(404, "not found")
        m = self.messages[message_id]
        m.labels = [l for l in m.labels if l != "INBOX"] + ["TRASH"]

    def labels(self) -> dict[str, str]:
        self.calls.append(("labels",))
        return dict(self.label_ids)

    def ensure_label(self, name: str, cache: dict[str, str]) -> str:
        key = name.lower()
        if key not in cache:
            self.calls.append(("labels.create", name))
            cache[key] = f"Label_{len(cache) + 1}"
            self.label_ids[key] = cache[key]
        return cache[key]
