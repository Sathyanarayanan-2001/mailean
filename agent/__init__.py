"""Mailean agent: scheduled Gmail triage and command execution.

Runs inside GitHub Actions in the private data repository. Every module reads
secrets from environment variables only; nothing secret is ever written to disk.
"""

VERSION = "1.0.2"
RELEASE_DATE = "2026-11-28"
