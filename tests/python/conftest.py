"""Make the repository root and scripts/ importable, and keep tests offline."""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch):
    from agent import http

    http.set_transport(sleep=lambda s: None)
    yield
    http.set_transport()
