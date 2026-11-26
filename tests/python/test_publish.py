"""State branch publishing against a real local git remote, including a race."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from agent import publish

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")


def sh(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture()
def remote(tmp_path):
    bare = tmp_path / "origin.git"
    sh(tmp_path, "init", "--quiet", "--bare", str(bare))
    sh(bare, "symbolic-ref", "HEAD", "refs/heads/main")  # like GitHub: default branch main
    work = tmp_path / "work"
    sh(tmp_path, "clone", "--quiet", str(bare), str(work))
    sh(work, "config", "user.email", "t@x.test")
    sh(work, "config", "user.name", "t")
    (work / "README.md").write_text("code\n")
    sh(work, "add", ".")
    sh(work, "commit", "--quiet", "-m", "code")
    sh(work, "push", "--quiet", "origin", "HEAD:main")
    return tmp_path, bare


def clone(tmp, bare, name):
    path = tmp / name
    sh(tmp, "clone", "--quiet", str(bare), str(path))
    return path


def files_on_branch(bare):
    return sorted(sh(bare, "ls-tree", "-r", "--name-only", publish.BRANCH).split())


def test_first_sync_creates_orphan_branch_and_squashes_history(remote, monkeypatch):
    tmp, bare = remote
    for n in range(3):
        repo = clone(tmp, bare, f"run{n}")
        monkeypatch.chdir(repo)
        publish.checkout(repo, repo / "state")
        (repo / "state" / "inbox.json").write_text(json.dumps({"run": n}))
        publish.squash(repo / "state", f"sync {n}", sleep=lambda s: None)
    assert files_on_branch(bare) == ["inbox.json"]                       # no code files leak in
    assert sh(bare, "rev-list", "--count", publish.BRANCH) == "1"         # history squashed
    assert json.loads(sh(bare, "show", f"{publish.BRANCH}:inbox.json")) == {"run": 2}


def test_command_audit_survives_a_concurrent_sync(remote):
    tmp, bare = remote
    first = clone(tmp, bare, "seed")
    publish.checkout(first, first / "state")
    (first / "state" / "inbox.json").write_text("{}")
    publish.squash(first / "state", "seed", sleep=lambda s: None)

    sync_repo, cmd_repo = clone(tmp, bare, "sync"), clone(tmp, bare, "cmd")
    publish.checkout(sync_repo, sync_repo / "state")      # both start from the same tip
    publish.checkout(cmd_repo, cmd_repo / "state")

    audit = cmd_repo / "state" / "audit" / "2026" / "b-20261126-031400-aaaa.json"
    audit.parent.mkdir(parents=True)
    audit.write_text('{"status":"ok"}')
    publish.append(cmd_repo / "state", "commands", sleep=lambda s: None)  # lands first

    (sync_repo / "state" / "inbox.json").write_text('{"fresh":true}')
    publish.squash(sync_repo / "state", "sync", sleep=lambda s: None)    # lease fails once, retries

    assert files_on_branch(bare) == ["audit/2026/b-20261126-031400-aaaa.json", "inbox.json"]
    assert sh(bare, "show", f"{publish.BRANCH}:inbox.json") == '{"fresh":true}'

    # And the other order: a sync squashes first, then a stale command run appends.
    late = clone(tmp, bare, "late")
    publish.checkout(late, late / "state")
    sync2 = clone(tmp, bare, "sync2")
    publish.checkout(sync2, sync2 / "state")
    (sync2 / "state" / "inbox.json").write_text('{"fresh":2}')
    publish.squash(sync2 / "state", "sync 2", sleep=lambda s: None)
    a2 = late / "state" / "audit" / "2026" / "b-20261126-031500-bbbb.json"
    a2.parent.mkdir(parents=True, exist_ok=True)
    a2.write_text('{"status":"ok"}')
    publish.append(late / "state", "commands 2", sleep=lambda s: None)
    assert "audit/2026/b-20261126-031500-bbbb.json" in files_on_branch(bare)
    assert sh(bare, "show", f"{publish.BRANCH}:inbox.json") == '{"fresh":2}'
