"""git log read as data, for both gits the editor reads (history.py, project_git.py): the format
that asks for some fields of each commit, its lines read back, and what names a commit."""

from __future__ import annotations

import re

HASH = re.compile(r"[0-9a-f]{7,40}")  # a commit's id, whole or abbreviated (fullmatch it)
FIELDS = {"commit": "%H", "time": "%ct", "author": "%an", "message": "%s"}


def log_format(*names: str) -> str:
    """git log's --format option for these fields (of FIELDS), one commit a line."""
    return "--format=" + "%x1f".join(FIELDS[n] for n in names)


def commits(out: str, *names: str) -> list[dict]:
    """The commits of a log written in log_format(*names), each as {name: value}; time in seconds."""
    found = []
    for line in out.splitlines():
        parts = line.split("\x1f")
        if len(parts) == len(names):
            commit: dict = dict(zip(names, parts))
            if "time" in commit:
                commit["time"] = int(commit["time"])
            found.append(commit)
    return found
