"""The data folder as a git repository: every change to the pages becomes a commit.

Edits arrive as the person types, so commits wait for a few quiet seconds and take everything
changed meanwhile (one commit per pause, not per keystroke). A server stopped before its
pause ends leaves files newer than the last commit; the next start commits them. Without git
on the machine, history is off and pages work as before.

Version names live in each page folder's labels.json ({commit: name}), versioned with the rest.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import threading
import time
from pathlib import Path

from git_log import HASH, commits, log_format

QUIET_SECS = 5.0
LOG_MAX = 200
# The repository's own identity: commits never borrow the person's global git config.
CONFIG = {"user.name": "mermaid-view", "user.email": "mermaid-view@localhost", "commit.gpgsign": "false"}


class History:
    def __init__(self, root: Path, quiet_secs: float = QUIET_SECS):
        self.root = root
        self.quiet_secs = quiet_secs
        self.git = shutil.which("git")
        self._lock = threading.Lock()  # one git command that writes at a time
        # The changes waiting for a quiet while: their messages, and when it ends (monotonic; None
        # when nothing waits). One worker, started at the first change, commits them then.
        self._quiet = threading.Condition()
        self._messages: list[str] = []
        self._due: float | None = None
        self._worker: threading.Thread | None = None
        if self.git:
            self._init()

    @property
    def enabled(self) -> bool:
        return self.git is not None

    def _run(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        assert self.git
        return subprocess.run(
            [self.git, "-C", str(self.root), *args],
            capture_output=True,
            text=True,
            check=check,
            env={"GIT_TERMINAL_PROMPT": "0", "PATH": "/usr/bin:/bin:/usr/local/bin", "HOME": str(self.root)},
        )

    def _init(self) -> None:
        made = not (self.root / ".git").exists()
        if made:
            try:
                self._run("init", "-q")
            except (OSError, subprocess.CalledProcessError):
                self.git = None  # no repository here: history is off, pages work as before
                return
        # Written when the repository is new or a value is not CONFIG's (one read otherwise).
        # Another server starting on this folder may be writing the same values: a miss is harmless.
        have = (
            {}
            if made
            else dict(
                line.split("=", 1)
                for line in self._run("config", "--local", "--list", check=False).stdout.splitlines()
                if "=" in line
            )
        )
        for key, value in CONFIG.items():
            if have.get(key) != value:
                self._run("config", key, value, check=False)
        ignore = self.root / ".gitignore"
        if not ignore.exists():
            ignore.write_text("outbox.json\n", "utf-8")  # where notes were kept before they stayed in memory
        self.commit_now("Changes from before this start")

    def changed(self, message: str) -> None:
        """A change to commit once the folder has been quiet for a while."""
        if not self.enabled:
            return
        with self._quiet:
            if message not in self._messages:
                self._messages.append(message)
            self._due = time.monotonic() + self.quiet_secs
            if self._worker is None:
                self._worker = threading.Thread(target=self._commit_when_quiet, daemon=True)
                self._worker.start()
            self._quiet.notify()

    def _commit_when_quiet(self) -> None:
        while True:
            with self._quiet:
                while self._due is None or self._due > time.monotonic():
                    self._quiet.wait(None if self._due is None else self._due - time.monotonic())
            self.flush()

    def flush(self) -> None:
        with self._quiet:
            messages, self._messages = self._messages, []
            self._due = None
        if messages:
            self.commit_now("; ".join(messages[:5]) + (" …" if len(messages) > 5 else ""))

    def commit_now(self, message: str) -> bool:
        """Commits everything changed; False when there was nothing to commit, or git could not:
        another server on this folder holds the repository's lock (each Claude Code session runs
        its own), or a git killed mid-commit left it behind. What changed goes with a later commit;
        the page itself is saved either way."""
        if not self.enabled:
            return False
        with self._lock:
            try:
                self._run("add", "-A", ".")
                if self._run("diff", "--cached", "--quiet", check=False).returncode == 0:
                    return False
                self._run("commit", "-q", "-m", message)
            except (OSError, subprocess.CalledProcessError):
                return False
            return True

    def log(self, page_id: str, index: int) -> list[dict]:
        """The commits that changed diagram `index` of a page, newest first, with their names."""
        if not self.enabled:
            return []
        paths = [f"pages/{page_id}/original-{index}.mmd", f"pages/{page_id}/edited-{index}.mmd"]
        fields = ("commit", "time", "message")
        out = self._run("log", f"-{LOG_MAX}", log_format(*fields), "--", *paths, check=False).stdout
        labels = self._labels(page_id)
        return [{**c, "label": labels.get(c["commit"], "")} for c in commits(out, *fields)]

    def text_at(self, page_id: str, index: int, commit: str) -> str | None:
        """Diagram `index` as it stood at a commit: the edit if there was one, else the original."""
        if not self.enabled or not HASH.fullmatch(commit):
            return None
        for name in (f"edited-{index}.mmd", f"original-{index}.mmd"):
            shown = self._run("show", f"{commit}:pages/{page_id}/{name}", check=False)
            if shown.returncode == 0:
                return shown.stdout
        return None

    def _labels(self, page_id: str) -> dict:
        try:
            return json.loads((self.root / "pages" / page_id / "labels.json").read_text("utf-8"))
        except (OSError, ValueError):
            return {}

    def label(self, page_id: str, commit: str, name: str) -> dict:
        """Names a version (an empty name removes it); the names are committed with the page."""
        labels = self._labels(page_id)
        if name.strip():
            labels[commit] = name.strip()[:60]
        else:
            labels.pop(commit, None)
        (self.root / "pages" / page_id / "labels.json").write_text(json.dumps(labels, ensure_ascii=False), "utf-8")
        self.commit_now(f"Name a version of {page_id}")
        return labels
