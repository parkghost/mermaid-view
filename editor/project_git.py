"""A project's own git, read only: a file's commits and its text at one of them. The editor
never commits to a project; the person does, as with any other edit."""

import os
import shutil
import subprocess
from pathlib import Path

from git_log import HASH, commits, log_format


class ProjectGit:
    def __init__(self, root: Path):
        self.root = root
        self._enabled = False

    def _git(self, *args: str) -> str | None:
        try:
            done = subprocess.run(
                ["git", "-C", str(self.root), *args],
                capture_output=True,
                timeout=10,
                # Reading only: take no index lock a commit running alongside would trip on.
                env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        return done.stdout.decode("utf-8", errors="replace") if done.returncode == 0 else None

    @property
    def enabled(self) -> bool:
        """Whether the project is in a git work tree; a no is asked again (it may be one since)."""
        if not self._enabled:
            self._enabled = (
                bool(shutil.which("git")) and (self._git("rev-parse", "--is-inside-work-tree") or "").strip() == "true"
            )
        return self._enabled

    def head(self) -> str:
        """The commit checked out now ("" without git or commits): a commit or a checkout changes
        what an edit is compared with even when the file stays the same."""
        return (self._git("rev-parse", "HEAD") or "").strip() if self.enabled else ""

    def show(self, rel: str, commit: str = "HEAD") -> str | None:
        """The file's text at a commit; None when it was not there (or there is no git)."""
        if not self.enabled or not (commit == "HEAD" or HASH.fullmatch(commit)):
            return None
        # "./" makes the path relative to the project root, which may sit inside the repository.
        return self._git("show", f"{commit}:./{rel}")

    def log(self, rel: str, limit: int = 50) -> list[dict]:
        """The commits that changed the file, newest first (following renames)."""
        if not self.enabled:
            return []
        fields = ("commit", "time", "author", "message")
        return commits(self._git("log", "--follow", f"-n{limit}", log_format(*fields), "--", rel) or "", *fields)
