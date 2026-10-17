"""The pages kept from conversations: each a folder under <root>/pages/<id>/ with meta.json,
original-<i>.mmd and, once the person edits diagram i, edited-<i>.mmd. "Send to Claude" leaves
a note in this server's outbox for its mod to take."""

import difflib
import json
import re
import shutil
import threading
import time
import uuid
from collections import deque
from collections.abc import Callable, Iterable
from datetime import datetime, timezone
from pathlib import Path

from history import History

# Where a page came from, as meta.json keeps it.
ORIGIN = ("project", "projectRoot", "branch", "session")
NOTE_TTL = 10 * 60.0  # seconds a note for Claude may wait for the prompt box before it is dropped
MAX_NOTES = 20  # notes waiting at most: a newer one pushes the oldest out, dropped
MAX_NOTE = 2000  # characters of a note kept
# A page's id, as create names it: the time in UTC, "-<n>" on for a later page of the same
# millisecond. Nothing else names a page: an id never reaches outside the pages folder.
PAGE_ID = re.compile(r"^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}(-\d{1,6})?\Z")  # \Z: no newline after it


def is_page_id(page_id: object) -> bool:
    return isinstance(page_id, str) and PAGE_ID.match(page_id) is not None


class Store:
    """The pages on disk. A page's meta.json holds its count of diagrams and, for pages made
    since pages were organized: title, project (root and name), branch, session, kinds, pinned
    and tags. Older pages lack them and list under no project."""

    def __init__(self, root: Path, history: "History | None" = None):
        self.root = root
        self.pages = root / "pages"
        self.pages.mkdir(parents=True, exist_ok=True)
        self.history = history
        # The notes for the mod that runs this server, oldest first. In memory, not in the data
        # folder: each Claude Code session runs a server of its own on that folder, and a note sent
        # from a tab of this server is for this server's session.
        self.outbox: deque[dict] = deque()
        self._outbox_lock = threading.Lock()
        self.clock = time.time
        # Told each note's new state, by its id: "waiting" (refused for now), "delivered", "dropped".
        self.on_note: Callable[[str, str], None] = lambda note_id, state: None

    def _changed(self, message: str) -> None:
        if self.history:
            self.history.changed(message)

    def _title(self, page_id: str) -> str:
        return (self._meta(page_id) or {}).get("title") or page_id

    def page_ids(self) -> list[str]:
        return sorted(
            (p.name for p in self.pages.iterdir() if is_page_id(p.name) and (p / "meta.json").exists()), reverse=True
        )

    def _folder(self, page_id: str) -> Path | None:
        """A page's folder; None when page_id is not a page id. The one place an id becomes a path."""
        return self.pages / page_id if is_page_id(page_id) else None

    def _meta(self, page_id: str) -> dict | None:
        folder = self._folder(page_id)
        if folder is None:
            return None
        try:
            meta = json.loads((folder / "meta.json").read_text("utf-8"))
        except (OSError, ValueError):
            return None
        return meta if well_formed(meta) else None

    def unreadable(self) -> list[str]:
        """The pages whose meta.json cannot be read (written by hand, or by an archive from
        elsewhere): left out of every list, and left on disk as they are."""
        return [page_id for page_id in self.page_ids() if self._meta(page_id) is None]

    def _sources(self, page_id: str, meta: dict) -> list[tuple[str, str | None]]:
        folder = self._folder(page_id)
        if folder is None:
            return []
        out = []
        for i in range(int(meta.get("count", 0))):
            try:
                original = (folder / f"original-{i}.mmd").read_text("utf-8")
            except OSError:
                continue
            edited_file = folder / f"edited-{i}.mmd"
            out.append((original, edited_file.read_text("utf-8") if edited_file.exists() else None))
        return out

    def summary(self, page_id: str, meta: dict | None = None) -> dict | None:
        meta = meta or self._meta(page_id)
        folder = self._folder(page_id)
        if meta is None or folder is None:
            return None
        edits = list(folder.glob("edited-*.mmd"))
        return {
            "id": page_id,
            "created": meta.get("created", page_id),
            "title": meta.get("title") or "",
            "project": meta.get("project") or "",
            "projectRoot": meta.get("projectRoot") or "",
            "branch": meta.get("branch") or "",
            "session": meta.get("session") or "",
            "kinds": meta.get("kinds") or [],
            "count": int(meta.get("count", 0)),
            "pinned": bool(meta.get("pinned")),
            "tags": meta.get("tags") or [],
            "edited": bool(edits),
            "updated": max((f.stat().st_mtime for f in edits), default=0),
        }

    def _metas(self, project: str = "") -> list[tuple[str, dict]]:
        """Each readable page's id and meta.json, newest first; with a project, its pages only."""
        metas = ((page_id, self._meta(page_id)) for page_id in self.page_ids())
        return [(i, m) for i, m in metas if m is not None and (not project or (m.get("project") or "") == project)]

    def summaries(self, project: str = "") -> list[dict]:
        pages = [self.summary(page_id, meta) for page_id, meta in self._metas(project)]
        return [p for p in pages if p]

    def find(self, query: str, project: str = "") -> list[dict]:
        """The pages a query finds (search); without a word in it, every page's summary."""
        return self.search(query, project) if query.strip() else self.summaries(project)

    def search(self, query: str, project: str = "", limit: int = 50) -> list[dict]:
        """Pages whose title, tags, project or diagram sources hold every term of the query,
        each with up to three matching source lines."""
        terms = [t.lower() for t in query.split() if t]
        found = []
        for page_id, meta in self._metas(project):
            summary = self.summary(page_id, meta)
            if not summary:
                continue
            sources = self._sources(page_id, meta)
            haystack = " ".join(
                [summary["title"], summary["project"], summary["branch"], *summary["tags"]]
                + [edited or original for original, edited in sources]
            ).lower()
            if not all(t in haystack for t in terms):
                continue
            matches = matching_lines(
                ((d, 1, edited or original) for d, (original, edited) in enumerate(sources)), terms
            )
            found.append({**summary, "matches": matches})
            if len(found) >= limit:
                break
        return found

    def page(self, page_id: str) -> dict | None:
        meta = self._meta(page_id)
        if meta is None:
            return None
        diagrams = [
            {"index": i, "original": original, "edited": edited, "diff": diff(original, edited)}
            for i, (original, edited) in enumerate(self._sources(page_id, meta))
        ]
        return {**(self.summary(page_id, meta) or {}), "diagrams": diagrams}

    def create(self, diagrams: list[str], title: str = "", origin: dict | None = None) -> str:
        """A new page of diagrams (meta.json and original-<i>.mmd), committed as its first version:
        its history starts with the diagrams as they were written. Its id: the time in UTC
        ("2026-10-11T07-09-36-825"). origin: project, projectRoot, branch, session."""
        now = datetime.now(timezone.utc)
        stamp = now.strftime("%Y-%m-%dT%H-%M-%S-") + f"{now.microsecond // 1000:03d}"
        page_id, n = stamp, 1
        while True:
            try:
                (self.pages / page_id).mkdir()
                break
            except FileExistsError:  # another page in the same millisecond
                n += 1
                page_id = f"{stamp}-{n}"
        folder = self.pages / page_id
        for i, d in enumerate(diagrams):
            (folder / f"original-{i}.mmd").write_text(d.strip() + "\n", "utf-8")
        fields = {k: v for k, v in (origin or {}).items() if k in ORIGIN and isinstance(v, str)}
        meta = {
            "count": len(diagrams),
            "created": page_id,
            "title": title.strip()[:200],
            "kinds": list(dict.fromkeys(kind_of(d) for d in diagrams)),
            **fields,
        }
        (folder / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), "utf-8")
        if self.history:
            self.history.commit_now(f"New page: {self._title(page_id)}")
        return page_id

    def save(self, page_id: str, index: int, text: str) -> dict | None:
        folder = self._folder(page_id)
        if folder is None:
            return None
        original_file = folder / f"original-{index}.mmd"
        if not original_file.exists():
            return None
        original = original_file.read_text("utf-8")
        edited_file = folder / f"edited-{index}.mmd"
        if text.strip() == original.strip():
            edited_file.unlink(missing_ok=True)  # back to the original: no edit
            self._changed(f"Back to the original: {self._title(page_id)} #{index + 1}")
            return {"edited": None, "diff": ""}
        edited_file.write_text(text, "utf-8")
        self._changed(f"Edit {self._title(page_id)} #{index + 1}")
        return {"edited": text, "diff": diff(original, text)}

    def update(self, page_id: str, fields: dict) -> dict | None:
        meta = self._meta(page_id)
        folder = self._folder(page_id)
        if meta is None or folder is None:
            return None
        if isinstance(fields.get("title"), str):
            meta["title"] = fields["title"].strip()[:200]
        if isinstance(fields.get("pinned"), bool):
            meta["pinned"] = fields["pinned"]
        tags = fields.get("tags")
        if isinstance(tags, list) and all(isinstance(t, str) for t in tags):
            meta["tags"] = sorted({t.strip()[:40] for t in tags if t.strip()})[:20]
        (folder / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), "utf-8")
        self._changed(f"Update {meta.get('title') or page_id}")
        return self.summary(page_id, meta)

    def delete(self, page_id: str) -> bool:
        folder = self._folder(page_id)
        if folder is None or not (folder / "meta.json").exists():
            return False
        title = self._title(page_id)
        shutil.rmtree(folder)
        self._changed(f"Delete {title}")
        return True

    def cleanup(self, days: float) -> int:
        """Removes pages older than `days` the person neither edited nor pinned; 0 keeps all."""
        if days <= 0:
            return 0
        cutoff = time.time() - days * 86400
        removed = 0
        for page_id in self.page_ids():
            summary = self.summary(page_id)
            folder = self._folder(page_id)
            if (
                summary
                and folder
                and not summary["pinned"]
                and not summary["edited"]
                and (folder / "meta.json").stat().st_mtime < cutoff
            ):
                shutil.rmtree(folder)
                removed += 1
        if removed and self.history:
            self.history.commit_now(f"Remove {removed} page(s) older than {days:g} days")
        return removed

    def send(self, page_id: str, note: object) -> str:
        return self.leave({"page": page_id, "note": note})

    def leave(self, item: dict) -> str:
        """A note for the mod to take: a page's ({page, note}) or a project file's
        ({project, projectName, file, note}); its id. The note is cut to MAX_NOTE characters (not
        text: none). The oldest note is dropped when MAX_NOTES wait, and any too old with it."""
        note_id = uuid.uuid4().hex
        note = item.get("note")
        with self._outbox_lock:
            pushed_out = [self.outbox.popleft()["id"]] if len(self.outbox) >= MAX_NOTES else []
            self.outbox.append(
                {**item, "note": note[:MAX_NOTE] if isinstance(note, str) else "", "id": note_id, "at": self.clock()}
            )
            dropped = pushed_out + self._drop_aged()
        self._tell(dropped, "dropped")
        return note_id

    def take(self) -> dict | None:
        """The oldest note not delivered yet; None when there is none. It stays first until the mod
        acknowledges it delivered (ack): a note the prompt box refused is not lost."""
        with self._outbox_lock:
            return self.outbox[0] if self.outbox else None

    def ack(self, note_id: str, filled: bool) -> str | None:
        """The mod tried to put a note in the prompt box. Filled: the note is done, "delivered".
        Not filled (a dialog is up, no box): it stays first to be tried again, "waiting" the first
        time. None when there is nothing new to tell (still waiting, or no such note)."""
        with self._outbox_lock:
            item = next((i for i in self.outbox if i["id"] == note_id), None)
            if item is None:
                state = None
            elif filled:
                self.outbox.remove(item)
                state = "delivered"
            elif item.get("waiting"):
                state = None
            else:
                item["waiting"] = True
                state = "waiting"
        if state:
            self._tell([note_id], state)
        return state

    def expire(self) -> list[str]:
        """Drops the notes not delivered within NOTE_TTL; their ids."""
        with self._outbox_lock:
            dropped = self._drop_aged()
        self._tell(dropped, "dropped")
        return dropped

    def _drop_aged(self) -> list[str]:
        """Takes the notes older than NOTE_TTL out of the outbox (its lock held); their ids."""
        cutoff = self.clock() - NOTE_TTL
        old = [i for i in self.outbox if i["at"] < cutoff]
        for item in old:
            self.outbox.remove(item)
        return [i["id"] for i in old]

    def _tell(self, note_ids: list[str], state: str) -> None:
        for note_id in note_ids:
            self.on_note(note_id, state)


def well_formed(meta: object) -> bool:
    """Whether a page's meta.json holds what the store reads of it, each field of its type (an
    older page lacks the newer fields)."""
    if not isinstance(meta, dict):
        return False
    count = meta.get("count", 0)
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        return False
    texts = ("created", "title", *ORIGIN)
    lists = ("kinds", "tags")
    return all(isinstance(meta[k], str) for k in texts if meta.get(k) is not None) and all(
        isinstance(meta[k], list) and all(isinstance(x, str) for x in meta[k]) for k in lists if meta.get(k) is not None
    )


def kind_of(diagram: str) -> str:
    """A diagram's kind: the first word of its first line after front matter that is not a comment
    or a directive ("flowchart")."""
    lines = [line.strip() for line in diagram.splitlines()]
    if lines and lines[0] == "---" and "---" in lines[1:]:
        lines = lines[lines.index("---", 1) + 1 :]
    directive = False  # inside a %%{ ... }%% directive that spans lines
    for line in lines:
        if directive:
            directive = "}%%" not in line
        elif line.startswith("%%{") and "}%%" not in line:
            directive = True
        elif line and not line.startswith("%%"):
            return line.split()[0]
    return ""


def matching_lines(sources: Iterable[tuple[int, int, str]], terms: list[str], limit: int = 3) -> list[dict]:
    """The first `limit` lines that hold a term (lower case) of the sources, each given as
    (diagram index, the number of its first line, its text); none without terms."""
    found: list[dict] = []
    if not terms:
        return found
    for index, first, text in sources:
        for n, line in enumerate(text.splitlines(), first):
            if any(t in line.lower() for t in terms):
                found.append({"diagram": index, "line": n, "text": line.strip()[:120]})
                if len(found) >= limit:
                    return found
    return found


def diff(original: str, edited: str | None) -> str:
    if edited is None:
        return ""
    lines = difflib.unified_diff(original.splitlines(), edited.splitlines(), "original", "edited", lineterm="")
    return "\n".join(lines)
