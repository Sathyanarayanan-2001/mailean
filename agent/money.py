"""Exact money handling in whole paise.

Amounts are parsed from text digit by digit, never through float, so
"1,23,456.78" becomes exactly 12345678 paise and totals never drift.
"""

from __future__ import annotations

import re

_AMOUNT_TEXT = re.compile(r"^\s*(-)?\s*([0-9][0-9,]*)(?:\.([0-9]{1,2}))?\s*$")
# Rupee amounts inside free text: ₹1,234.50 / Rs. 1234 / INR 1,23,456.78
_RUPEE_IN_TEXT = re.compile(r"(?:₹|\bRs\.?|\bINR)\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)", re.IGNORECASE)
MAX_PAISE = 10**15  # ₹10 lakh crore; anything larger is a parsing mistake


def to_paise(text: str | None) -> int | None:
    """Parse '1,23,456.78' or '1234.5' into paise. Return None when not a clean amount."""
    if text is None:
        return None
    match = _AMOUNT_TEXT.match(str(text))
    if not match:
        return None
    sign, whole, frac = match.groups()
    digits = whole.replace(",", "")
    if not digits:
        return None
    frac = (frac or "").ljust(2, "0")
    value = int(digits) * 100 + int(frac)
    if value > MAX_PAISE:
        return None
    return -value if sign else value


def find_rupee_amount(text: str) -> int | None:
    """First rupee amount mentioned in text, in paise."""
    match = _RUPEE_IN_TEXT.search(text or "")
    return to_paise(match.group(1)) if match else None


def format_inr(paise: int) -> str:
    """12345678 -> '1,23,456.78' (Indian lakh/crore grouping)."""
    if not isinstance(paise, int):
        raise TypeError("paise must be an int")
    sign = "-" if paise < 0 else ""
    paise = abs(paise)
    rupees, rem = divmod(paise, 100)
    digits = str(rupees)
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        digits = ",".join(groups + [tail])
    return f"{sign}{digits}.{rem:02d}"
