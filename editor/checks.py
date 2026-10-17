"""Checking diagrams for the MCP tools: the server cannot run Mermaid's parser, an editor tab can.
A check is handed to one open tab as the event `check` (an unguessable id, the sources, the type
the caller expects); the tab runs Mermaid 12.1.0's parser and the editor's lint on each source and
POSTs the reports to /api/checks/<id>. The server waits a few seconds for the answer, then tries
the next tab; with no tab answering, the check is "not checked", never a success.

Only a pending check's id is answered, only by the tab it was handed to, and only once.
"""

import secrets
import threading
import time
from dataclasses import dataclass, field

from viewers import Viewers

ANSWER_WAIT = 4.0  # seconds one tab has to answer
TOTAL_WAIT = 8.0  # seconds a check may take, whichever tabs are tried
MAX_FINDINGS = 200
SEVERITIES = ("error", "warning", "info")


@dataclass
class Pending:
    viewer: str
    count: int  # how many sources: an answer must report on each
    done: threading.Event = field(default_factory=threading.Event)
    reports: list[dict] | None = None


def _text(value, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _finding(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    line = raw.get("line")
    severity = raw.get("severity")
    return {
        "line": line if isinstance(line, int) and not isinstance(line, bool) and line > 0 else 1,
        "severity": severity if severity in SEVERITIES else "error",
        "rule": _text(raw.get("rule"), 64),
        "message": _text(raw.get("message"), 2000),
    }


def normalized(raw) -> dict | None:
    """A tab's report on one source, kept to its known fields; None when it is not one."""
    if not isinstance(raw, dict) or not isinstance(raw.get("ok"), bool):
        return None

    def findings(key: str) -> list[dict]:
        listed = raw.get(key)
        return [f for f in map(_finding, listed[:MAX_FINDINGS]) if f] if isinstance(listed, list) else []

    errors, warnings = findings("errors"), findings("warnings")
    return {
        "checked": True,
        "ok": raw["ok"] and not errors,
        "type": _text(raw.get("type"), 64) or None,
        "typeName": _text(raw.get("typeName"), 64) or None,
        "checker": _text(raw.get("checker"), 300),
        "errors": errors,
        "warnings": warnings,
    }


class Checks:
    """The checks handed to the tabs of viewers; editor_url: the editor's page, where a check that
    found no tab tells the person to open one."""

    def __init__(self, viewers: Viewers, editor_url: str):
        self.viewers, self.editor_url = viewers, editor_url
        self.answer_wait, self.total_wait = ANSWER_WAIT, TOTAL_WAIT
        self._lock = threading.Lock()
        self._pending: dict[str, Pending] = {}

    def run(self, sources: list[str], type_id: str = "") -> list[dict] | None:
        """Each source's report from an open tab (in order); None when no tab answered."""
        deadline = time.monotonic() + self.total_wait
        for viewer in self.viewers.recent():
            left = deadline - time.monotonic()
            if left <= 0:
                break
            check_id = secrets.token_urlsafe(24)
            pending = Pending(viewer.id, len(sources))
            with self._lock:
                self._pending[check_id] = pending
            try:
                data = {"id": check_id, "sources": sources, "type": type_id}
                if self.viewers.deliver(viewer, "check", data, min(left, self.answer_wait)) and pending.done.wait(
                    max(0.0, min(deadline - time.monotonic(), self.answer_wait))
                ):
                    return pending.reports
            finally:
                with self._lock:
                    self._pending.pop(check_id, None)
        return None

    def check(self, sources: list[str], type_id: str = "") -> list[dict]:
        """Each source's report, or, with no tab answering, a report that says it was not checked."""
        reports = self.run(sources, type_id)
        if reports is not None:
            return reports
        why = "no open editor tab answered in time" if self.viewers.recent() else "no editor tab is open"
        return [{"checked": False, "reason": f"{why} (open {self.editor_url} to enable checking)"} for _ in sources]

    def answer(self, check_id: str, viewer_id: str, reports) -> bool:
        """A tab's answer to the check it was handed. False: no such pending check (unknown, over,
        or handed to another tab) or not a report on each of its sources."""
        with self._lock:
            pending = self._pending.get(check_id)
            if pending is None or pending.viewer != viewer_id or pending.done.is_set():
                return False
            if not isinstance(reports, list) or len(reports) != pending.count:
                return False
            kept = [normalized(r) for r in reports]
            if any(r is None for r in kept):
                return False
            pending.reports = kept
            pending.done.set()
            return True
