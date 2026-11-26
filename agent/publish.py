"""Publish state to the `mailean-state` branch of the private repository.

Why a separate branch: the code branch stays clean, and Pages never sees data.
Why squash: every sync replaces the branch with a single commit, so years of
email subjects do not pile up in git history.

Two writers can race (a scheduled sync and a command run), so:
- sync uses `--force-with-lease` against the commit it started from; if a command
  run pushed an audit file meanwhile, the lease fails, we pull that file in and retry.
- commands append one new, uniquely named audit file and rebase on rejection.

Run from the repository root:
  python -m agent.publish checkout state            # worktree of the state branch at ./state
  python -m agent.publish squash state "sync …"     # after sync_inbox
  python -m agent.publish append state "commands …" # after execute_commands
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

BRANCH = "mailean-state"
ATTEMPTS = 5


class PublishError(Exception):
    pass


def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise PublishError(f"git {' '.join(args[:2])} failed: {proc.stderr.strip()[:300]}")
    return proc


def remote_sha(cwd: Path) -> str:
    """Current tip of the state branch on origin, or '' if it does not exist yet."""
    out = git(cwd, "ls-remote", "origin", f"refs/heads/{BRANCH}").stdout.strip()
    return out.split()[0] if out else ""


def _identity(cwd: Path) -> None:
    git(cwd, "config", "user.name", "mailean-bot")
    git(cwd, "config", "user.email", "mailean-bot@users.noreply.github.com")


def checkout(repo: Path, target: Path) -> None:
    """Create a detached worktree of the state branch, or an empty orphan if it is new."""
    if target.exists() and any(target.iterdir()):
        raise PublishError(f"{target} already exists and is not empty.")
    exists = bool(git(repo, "ls-remote", "origin", f"refs/heads/{BRANCH}").stdout.strip())
    if exists:
        git(repo, "fetch", "--quiet", "--depth", "1", "origin", f"{BRANCH}")
        git(repo, "worktree", "add", "--quiet", "--detach", str(target), "FETCH_HEAD")
    else:
        git(repo, "worktree", "add", "--quiet", "--detach", str(target), "HEAD")
        git(target, "checkout", "--quiet", "--orphan", "state-new")
        git(target, "rm", "-r", "-f", "--quiet", "--cached", ".")
        for child in target.iterdir():
            if child.name != ".git":
                _remove(child)


def _remove(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        for child in path.iterdir():
            _remove(child)
        path.rmdir()
    else:
        path.unlink()


def squash(cwd: Path, message: str, sleep=time.sleep) -> str:
    _identity(cwd)
    for attempt in range(ATTEMPTS):
        base = remote_sha(cwd)
        if base:
            git(cwd, "fetch", "--quiet", "origin", BRANCH)
            # Bring in audit files another run pushed since we started; never
            # overwrite our own inbox.json.
            listed = git(cwd, "ls-tree", "-r", "--name-only", "FETCH_HEAD").stdout.split()
            for name in listed:
                if name.startswith("audit/") and not (cwd / name).exists():
                    git(cwd, "checkout", "FETCH_HEAD", "--", name)
        branch_tmp = f"squash-{int(time.time())}-{attempt}"
        git(cwd, "checkout", "--quiet", "--orphan", branch_tmp)
        git(cwd, "add", "--all", ".")
        git(cwd, "commit", "--quiet", "--allow-empty", "-m", message)
        lease = f"--force-with-lease=refs/heads/{BRANCH}:{base}"
        push = git(cwd, "push", "--quiet", lease, "origin", f"HEAD:refs/heads/{BRANCH}", check=False)
        if push.returncode == 0:
            return git(cwd, "rev-parse", "HEAD").stdout.strip()
        sleep(2 + attempt * 3)
    raise PublishError("Could not publish state after several attempts; the next run will retry.")


def append(cwd: Path, message: str, sleep=time.sleep) -> str:
    _identity(cwd)
    git(cwd, "add", "--all", ".")
    if not git(cwd, "status", "--porcelain").stdout.strip():
        return git(cwd, "rev-parse", "HEAD").stdout.strip()
    git(cwd, "commit", "--quiet", "-m", message)
    for attempt in range(ATTEMPTS):
        push = git(cwd, "push", "--quiet", "origin", f"HEAD:refs/heads/{BRANCH}", check=False)
        if push.returncode == 0:
            return git(cwd, "rev-parse", "HEAD").stdout.strip()
        sleep(2 + attempt * 3)
        mine = git(cwd, "rev-parse", "HEAD").stdout.strip()
        git(cwd, "fetch", "--quiet", "origin", BRANCH)
        # Replay only our one commit. It adds a uniquely named audit file, so it
        # applies cleanly even onto a branch that a sync has just squashed.
        git(cwd, "checkout", "--quiet", "--detach", "FETCH_HEAD")
        git(cwd, "cherry-pick", "--allow-empty", mine)
    raise PublishError("Could not publish the audit record after several attempts.")


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "checkout":
        try:
            checkout(Path.cwd(), Path(argv[2]).resolve())
        except PublishError as exc:
            print(f"::error::{exc}")
            return 1
        return 0
    if len(argv) != 4 or argv[1] not in ("squash", "append"):
        print("usage: python -m agent.publish checkout <dir> | squash|append <dir> <message>")
        return 2
    cwd = Path(argv[2]).resolve()
    try:
        sha = (squash if argv[1] == "squash" else append)(cwd, argv[3][:200])
    except PublishError as exc:
        print(f"::error::{exc}")
        return 1
    print(f"Published {BRANCH} at {sha[:10]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
