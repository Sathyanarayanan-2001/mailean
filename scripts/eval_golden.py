#!/usr/bin/env python3
"""Score the triage against the five golden examples.

    python scripts/eval_golden.py            # rules, plus Claude if ANTHROPIC_API_KEY is set
    python scripts/eval_golden.py --rules    # rules only (no network)

Rubric per example (1 point each, 3 max):
  correct  - group is one of the expected groups and the suspicious flag matches
  complete - priority, action and (for receipts) the exact amount in paise are right
  format   - summary is 1-120 characters with no link; move_to_label carries a label
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from agent.classify import EmailInput, Triage, classify_all, classify_by_rules, make_client  # noqa: E402

GOLDEN = ROOT / "tests" / "fixtures" / "golden.json"


def score(t: Triage, expect: dict) -> dict[str, bool]:
    correct = t.group in expect["groups"] and t.suspicious == expect["suspicious"]
    complete = t.suggested_action in expect["actions"]
    if "min_priority" in expect:
        complete = complete and t.priority >= expect["min_priority"]
    if "max_priority" in expect:
        complete = complete and t.priority <= expect["max_priority"]
    if "amount_paise" in expect:
        complete = complete and t.amount_paise == expect["amount_paise"]
    fmt = 1 <= len(t.summary) <= 120 and "http" not in t.summary.lower()
    if t.suggested_action == "move_to_label":
        fmt = fmt and bool(t.suggested_label)
    return {"correct": correct, "complete": complete, "format": fmt}


def load() -> list[tuple[str, EmailInput, dict]]:
    data = json.loads(GOLDEN.read_text(encoding="utf-8"))
    return [(ex["name"], EmailInput(key=f"g{i}", **ex["email"]), ex["expect"]) for i, ex in enumerate(data["examples"], 1)]


def run(mode: str) -> tuple[int, int, list[str]]:
    examples = load()
    if mode == "rules":
        results = {e.key: classify_by_rules(e) for _, e, _ in examples}
    else:
        client = make_client(os.environ.get("ANTHROPIC_API_KEY"))
        if client is None:
            return 0, 0, ["skipped: no API key"]
        results, report = classify_all([e for _, e, _ in examples], client, os.environ.get("MAILEAN_MODEL", "claude-sonnet-5-5"))
        if report.rules:
            print(f"warning: {report.rules} example(s) fell back to rules: {report.errors}")
    got = 0
    lines = []
    for name, e, expect in examples:
        s = score(results[e.key], expect)
        got += sum(s.values())
        marks = " ".join(f"{k}={'Y' if v else 'N'}" for k, v in s.items())
        lines.append(f"  {name:<45} {marks}  [{results[e.key].group}, p{results[e.key].priority}, {results[e.key].suggested_action}]")
    return got, 3 * len(examples), lines


def main() -> int:
    modes = ["rules"] if "--rules" in sys.argv else ["rules", "llm"]
    worst = 1.0
    for mode in modes:
        got, total, lines = run(mode)
        if total == 0:
            print(f"{mode}: {lines[0]}")
            continue
        print(f"{mode}: {got}/{total}")
        print("\n".join(lines))
        worst = min(worst, got / total)
    return 0 if worst >= 0.8 else 1


if __name__ == "__main__":
    sys.exit(main())
