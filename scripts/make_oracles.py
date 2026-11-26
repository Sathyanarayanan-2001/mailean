#!/usr/bin/env python3
"""Write independent "oracle" answers that the JavaScript tests must match.

This is the second method of verification: the dashboard's calendar maths and
figures are computed here with Python's own date library (zoneinfo,
date.isocalendar) and plain loops, with no code shared with docs/js.

    python scripts/make_oracles.py
"""

from __future__ import annotations

import json
import random
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
TZ = ZoneInfo("Asia/Kolkata")
NOW = datetime(2026, 11, 26, 3, 0, tzinfo=timezone.utc)


def fy_start(d: date) -> int:
    return d.year if d.month >= 4 else d.year - 1


def calendar_oracle() -> list[dict]:
    rng = random.Random(42)
    cases = []
    # Hand-picked edges: FY boundary at IST midnight, leap day, ISO week 53, year turns.
    edges = ["2026-03-31T18:29:59Z", "2026-03-31T18:30:00Z", "2024-02-29T00:00:00Z", "2026-12-31T12:00:00Z",
             "2027-01-01T12:00:00Z", "2027-01-03T18:29:00Z", "2027-01-03T18:30:00Z", "2020-12-31T00:00:00Z",
             "2021-01-03T10:00:00Z", "2028-02-29T20:00:00Z"]
    instants = [datetime.fromisoformat(e.replace("Z", "+00:00")) for e in edges]
    start = datetime(2019, 1, 1, tzinfo=timezone.utc)
    for _ in range(600):
        instants.append(start + timedelta(seconds=rng.randint(0, 12 * 365 * 86400)))
    for t in instants:
        local = t.astimezone(TZ)
        y, w, _ = local.date().isocalendar()
        cases.append({"utc": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "local": local.strftime("%d/%m/%Y %H:%M"),
                      "iso_year": y, "iso_week": w, "fy_start": fy_start(local.date())})
    return cases


def dashboard_oracle() -> dict:
    state = json.loads((ROOT / "docs" / "demo-state.json").read_text(encoding="utf-8"))
    msgs = state["messages"]
    local_now = NOW.astimezone(TZ).date()
    fy = fy_start(local_now)
    by_group = Counter(m["group"] for m in msgs)
    receipts_total = 0
    receipts_by_month: Counter = Counter()
    weeks: Counter = Counter()
    for m in msgs:
        d = datetime.fromisoformat(m["date"].replace("Z", "+00:00")).astimezone(TZ).date()
        y, w, _ = d.isocalendar()
        weeks[f"{y}-W{w:02d}"] += 1
        if m["group"] == "receipts_finance" and m["amount_paise"] is not None and fy_start(d) == fy:
            receipts_total += m["amount_paise"]
            receipts_by_month[f"{d.year}-{d.month:02d}"] += m["amount_paise"]
    # Last 8 ISO weeks ending with the current one.
    monday = local_now - timedelta(days=local_now.weekday())
    last8 = []
    for i in range(7, -1, -1):
        y, w, _ = (monday - timedelta(weeks=i)).isocalendar()
        last8.append({"key": f"{y}-W{w:02d}", "value": weeks.get(f"{y}-W{w:02d}", 0)})
    return {
        "now": NOW.strftime("%Y-%m-%dT%H:%M:%SZ"), "tz": "Asia/Kolkata",
        "total": len(msgs), "unread": sum(1 for m in msgs if m["unread"]),
        "by_group": dict(by_group), "receipts_total_paise": receipts_total,
        "receipts_by_month": dict(receipts_by_month), "last8_weeks": last8,
        "by_priority": dict(Counter(str(m["priority"]) for m in msgs)),
    }


def main() -> None:
    FIX.mkdir(parents=True, exist_ok=True)
    (FIX / "calendar-oracle.json").write_text(json.dumps(calendar_oracle(), indent=0) + "\n", encoding="utf-8")
    (FIX / "dashboard-oracle.json").write_text(json.dumps(dashboard_oracle(), indent=1) + "\n", encoding="utf-8")
    print("Wrote tests/fixtures/calendar-oracle.json and dashboard-oracle.json")


if __name__ == "__main__":
    main()
