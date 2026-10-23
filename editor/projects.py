"""Projects whose own files hold Mermaid diagrams: Markdown documents with ```mermaid blocks and
diagram files (.mmd). Their files are the diagrams: an edit replaces one block in place and
leaves the rest of the document as it was, and the project's own git keeps their versions
(nothing here commits to it).

A project may say which files to look at in .mermaid-view.json at its root:

    {"include": ["docs/**/*.md", "docs/diagrams/**/*.mmd"], "exclude": ["docs/old/**"],
     "diagramsDir": "docs/diagrams"}

Only files under a registered project's root are read or written: a path that leaves the root
(.., an absolute path, a symlink out of it) or names another kind of file is refused.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import threading
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from fences import closing_run, fence_for, fenced
from project_git import ProjectGit
from store import diff, matching_lines
from store import kind_of as diagram_kind

CONFIG = ".mermaid-view.json"
DIAGRAM_SUFFIXES = {".mmd", ".mermaid"}
MARKDOWN_SUFFIXES = {".md", ".markdown", ".mdx"}
SUFFIXES = tuple(DIAGRAM_SUFFIXES | MARKDOWN_SUFFIXES)
DEFAULT_INCLUDE = ["**/*.md", "**/*.markdown", "**/*.mdx", "**/*.mmd", "**/*.mermaid"]
DEFAULT_DIAGRAMS_DIR = "docs/diagrams"
# Folders never looked into: dependencies, builds and tool state, not the project's documents.
SKIP_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    "build",
    "dist",
    "target",
    ".cache",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    "managed_components",
    ".claude",
}
MAX_FILE = 2_000_000
MAX_FILES = 3000
# A Markdown fence that opens a Mermaid block: up to three spaces, three or more ` or ~.
OPEN = re.compile(r"^ {0,3}(`{3,}|~{3,})[ \t]*mermaid\b")
# One read, check and write of a project file at a time in this server: two saves made on the same
# version (two diagrams of one file, or an agent's and the page's) cannot both pass the check and
# the later write drop the earlier one's diagram.
WRITING = threading.Lock()


class Conflict(Exception):
    """The file changed since the version the edit was made on."""

    def __init__(self, current: str):
        super().__init__("the file changed")
        self.current = current


def version(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


@dataclass(frozen=True)
class Block:
    start: int  # line index of the opening fence
    end: int  # line index of the closing fence
    indent: int  # the spaces before the opening fence (a block in a list item): its lines carry them too


def blocks(lines: Sequence[str]) -> list[Block]:
    """The Mermaid blocks of a Markdown document's lines; a block left open is not one."""
    found = []
    i = 0
    while i < len(lines):
        m = OPEN.match(lines[i])
        if m:
            fence = m.group(1)
            j = next((k for k in range(i + 1, len(lines)) if _closes(lines[k], fence)), None)
            if j is None:
                break
            found.append(Block(i, j, len(lines[i]) - len(lines[i].lstrip(" "))))
            i = j
        i += 1
    return found


def _closes(line: str, fence: str) -> bool:
    """Whether a line closes a block opened by `fence`: the same character, at least as many."""
    return closing_run(line, fence[0]) >= len(fence)


def _newline(text: str) -> str:
    return "\r\n" if "\r\n" in text else "\n"


def _dedent(line: str, indent: int) -> str:
    """A block's line as the diagram reads it: CommonMark takes up to the fence's indentation off
    each line of its block."""
    return line[min(indent, len(line) - len(line.lstrip(" "))) :]


def diagrams_of(text: str, kind: str) -> list[dict]:
    """A file's diagrams: a diagram file is one; a document has one per Mermaid block. Each
    carries its text and the line (1-based) it starts on."""
    if kind == "diagram":
        return [{"index": 0, "text": text.replace("\r\n", "\n"), "line": 1}]
    lines = text.split(_newline(text))
    return [
        {
            "index": n,
            "text": "\n".join(_dedent(line, b.indent) for line in lines[b.start + 1 : b.end]) + "\n",
            "line": b.start + 2,
        }
        for n, b in enumerate(blocks(lines))
    ]


def replace_diagram(text: str, kind: str, index: int, new: str) -> str | None:
    """The file's text with diagram `index` replaced by `new`, everything else as it was; None
    when there is no such diagram."""
    nl = _newline(text)
    body = new.replace("\r\n", "\n").rstrip("\n").split("\n")
    if kind == "diagram":
        return nl.join(body) + nl if index == 0 else None
    lines = text.split(nl)
    found = blocks(lines)
    if not 0 <= index < len(found):
        return None
    b = found[index]
    indented = [" " * b.indent + line if line else line for line in body]  # back inside its list item
    opening, closing = lines[b.start], lines[b.end]
    m = OPEN.match(opening)
    assert m is not None  # blocks() found it
    fence = fence_for(indented, m.group(1))
    if fence != m.group(1):  # a line of the diagram would close the block: a longer fence round it
        opening = opening[: m.start(1)] + fence + opening[m.end(1) :]
        closing = closing.replace(closing.strip(), fence, 1)
    return nl.join(lines[: b.start] + [opening] + indented + [closing] + lines[b.end + 1 :])


def kind_of(path: Path) -> str | None:
    suffix = path.suffix.lower()
    return "diagram" if suffix in DIAGRAM_SUFFIXES else "markdown" if suffix in MARKDOWN_SUFFIXES else None


def kind(path: Path) -> str:
    """The kind of a path already known to be a document or diagram file."""
    return kind_of(path) or "markdown"


def _variants(pattern: str) -> set[str]:
    """A glob with each "**/" also taken as no folder at all: fnmatch's * crosses "/" anyway, but
    "**/" alone would ask for at least one folder ("docs/**/*.md" must take "docs/a.md")."""
    out = {pattern}
    while True:
        more = {v.replace("**/", "", 1) for v in out if "**/" in v} - out
        if not more:
            return out
        out |= more


def _globs(patterns: list[str]) -> list[str]:
    """Every variant of the patterns (_variants), to match paths with (_matches)."""
    return [v for p in patterns for v in _variants(p)]


def _matches(rel: str, globs: list[str]) -> bool:
    return any(fnmatch.fnmatch(rel, g) for g in globs)


class Project:
    def __init__(self, project_id: str, root: Path):
        self.id = project_id
        self.root = root.resolve()
        self.name = self.root.name
        self.git = ProjectGit(self.root)
        # Each listed file's diagrams by its path, with the time and size they were read at: a
        # listing reads again only the files changed since the one before it.
        self._scanned: dict[str, tuple[tuple[int, int], list[dict]]] = {}

    def info(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "root": str(self.root),
            "git": self.git.enabled,
            "diagramsDir": self.config()["diagramsDir"],
        }

    def config(self) -> dict:
        try:
            raw = json.loads((self.root / CONFIG).read_text("utf-8"))
        except (OSError, ValueError):
            raw = {}
        strings = lambda v: [s for s in v if isinstance(s, str)] if isinstance(v, list) else None  # noqa: E731
        diagrams_dir = raw.get("diagramsDir")
        return {
            "include": strings(raw.get("include")) or DEFAULT_INCLUDE,
            "exclude": strings(raw.get("exclude")) or [],
            "diagramsDir": diagrams_dir.strip("/")
            if isinstance(diagrams_dir, str) and diagrams_dir.strip("/")
            else DEFAULT_DIAGRAMS_DIR,
        }

    def resolve(self, rel: str) -> Path | None:
        """The file a project-relative path names, or None when it would leave the project or is
        not a document or diagram file."""
        if not isinstance(rel, str) or not rel or rel.startswith(("/", "~")) or "\\" in rel or "\0" in rel:
            return None
        path = (self.root / rel).resolve()
        if not path.is_relative_to(self.root) or path == self.root or kind_of(path) is None:
            return None
        return path

    def rel(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()

    def _walk(self):
        config = self.config()
        include, exclude = _globs(config["include"]), _globs(config["exclude"])
        count = 0
        top = str(self.root)
        for folder, dirs, names in os.walk(top):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith(".") or d == ".github")
            under = folder[len(top) + 1 :].replace(os.sep, "/")  # the folder's path in the project ("" at its root)
            for name in sorted(names):
                # The name first: most files end with no suffix of ours, and need no Path or stat.
                if not name.lower().endswith(SUFFIXES):
                    continue
                path = Path(folder) / name
                if kind_of(path) is None or path.is_symlink():
                    continue
                rel = f"{under}/{name}" if under else name
                if not _matches(rel, include) or _matches(rel, exclude):
                    continue
                count += 1
                if count > MAX_FILES:
                    return
                yield path, rel

    def _text(self, path: Path) -> str | None:
        try:
            if path.stat().st_size > MAX_FILE:
                return None
            return path.read_text("utf-8")
        except (OSError, UnicodeDecodeError):
            return None

    def _diagrams_in(self, path: Path, rel: str, file_kind: str, scanned: dict) -> tuple[list[dict], float]:
        """The file's diagrams and its time, read from disk only when its time or size changed
        since the last listing (else as that one found them); recorded in `scanned`."""
        try:
            st = path.stat()
        except OSError:
            return [], 0.0
        stamp = (st.st_mtime_ns, st.st_size)
        known = self._scanned.get(rel)
        if known and known[0] == stamp:
            diagrams = known[1]
        else:
            text = self._text(path)
            # Cheap test first: most documents have no diagram.
            diagrams = (
                []
                if text is None or (file_kind == "markdown" and "mermaid" not in text)
                else diagrams_of(text, file_kind)
            )
        scanned[rel] = (stamp, diagrams)
        return diagrams, st.st_mtime

    def files(self, query: str = "") -> list[dict]:
        """The project's files that hold diagrams, newest first; with a query, those whose path or
        diagrams hold every term, each with up to three matching lines."""
        terms = [t.lower() for t in query.split() if t]
        found = []
        scanned: dict[str, tuple[tuple[int, int], list[dict]]] = {}
        for path, rel in self._walk():
            file_kind = kind(path)
            diagrams, mtime = self._diagrams_in(path, rel, file_kind, scanned)
            if not diagrams:
                continue
            if terms and not all(t in (rel + " " + " ".join(d["text"] for d in diagrams)).lower() for t in terms):
                continue
            matches = matching_lines(((d["index"], d["line"], d["text"]) for d in diagrams), terms)
            found.append(
                {
                    "path": rel,
                    "kind": file_kind,
                    "count": len(diagrams),
                    "kinds": [diagram_kind(d["text"]) for d in diagrams],
                    "mtime": mtime,
                    "matches": matches,
                }
            )
        self._scanned = scanned  # the files gone since are forgotten
        found.sort(key=lambda f: f["mtime"], reverse=True)
        return found

    def current(self, rel: str) -> dict | None:
        """The file as it is on disk, without asking git: its path, kind, version and diagrams;
        None when there is no such document or diagram file (or it is too big)."""
        path = self.resolve(rel)
        if path is None or not path.is_file():
            return None
        data = path.read_bytes()
        if len(data) > MAX_FILE:
            return None
        file_kind = kind(path)
        return {
            "path": self.rel(path),
            "kind": file_kind,
            "version": version(data),
            "diagrams": diagrams_of(data.decode("utf-8", errors="replace"), file_kind),
        }

    def unchanged(self, rel: str, known: str, head: str) -> bool:
        """Whether the file is still at version `known` and the commit checked out still `head`:
        a page that read it then has nothing new to take (asked without git show or diffs)."""
        path = self.resolve(rel)
        if path is None or not path.is_file():
            return False
        data = path.read_bytes()
        return len(data) <= MAX_FILE and version(data) == known and self.git.head() == head

    def read(self, rel: str) -> dict | None:
        """The file as current() reads it, each diagram with its text at the last commit (head)."""
        doc = self.current(rel)
        if doc is None:
            return None
        head = self.git.show(doc["path"])
        head_diagrams = diagrams_of(head, doc["kind"]) if head is not None else []
        for d in doc["diagrams"]:
            # The committed version of the same diagram, by its place in the file.
            d["head"] = head_diagrams[d["index"]]["text"] if d["index"] < len(head_diagrams) else None
        return {
            "project": self.info(),
            "path": doc["path"],
            "kind": doc["kind"],
            "version": doc["version"],
            "head": self.git.head(),
            "tracked": head is not None,
            "diagrams": doc["diagrams"],
        }

    def save(self, rel: str, index: int, text: str, base: str) -> dict | None:
        """Replaces one diagram of the file, made on version `base`: the file's new version and
        text. Conflict when the file has changed since; None when there is no such file or diagram."""
        path = self.resolve(rel)
        if path is None or not path.is_file():
            return None
        with WRITING:
            data = path.read_bytes()
            if version(data) != base:
                raise Conflict(version(data))
            new = replace_diagram(data.decode("utf-8"), kind(path), index, text)
            if new is None:
                return None
            encoded = new.encode("utf-8")
            if encoded != data:
                path.write_bytes(encoded)
        return {"version": version(encoded), "text": new}

    def add(self, rel: str, text: str, heading: str = "") -> dict | None:
        """A diagram into the project: a new diagram file (never over an existing one), or a block
        at the end of a document (a new one if missing), under a heading when given."""
        path = self.resolve(rel)
        if path is None:
            return None
        body = text.replace("\r\n", "\n").rstrip("\n") + "\n"
        with WRITING:
            if kind_of(path) == "diagram":
                if path.exists():
                    raise Conflict(version(path.read_bytes()))
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(body, "utf-8")
                return {"path": self.rel(path), "index": 0}
            # As bytes: a text-mode read would turn \r\n into \n, and the document's lines with it.
            old = path.read_bytes().decode("utf-8") if path.exists() else ""
            nl = _newline(old) if old else "\n"
            before = len(diagrams_of(old, "markdown")) if old else 0
            part = (f"## {heading.strip()}{nl}{nl}" if heading.strip() else "") + fenced("mermaid", body, nl) + nl
            joined = (old.rstrip("\r\n") + nl + nl if old.strip() else "") + part
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(joined.encode("utf-8"))  # as bytes too: its line ends stay as joined
        return {"path": self.rel(path), "index": before}

    def diagram_at(self, rel: str, index: int, commit: str) -> str | None:
        path = self.resolve(rel)
        if path is None:
            return None
        text = self.git.show(self.rel(path), commit)
        if text is None:
            return None
        found = diagrams_of(text, kind(path))
        return found[index]["text"] if 0 <= index < len(found) else None

    def history(self, rel: str) -> list[dict]:
        path = self.resolve(rel)
        return self.git.log(self.rel(path)) if path is not None else []


class Projects:
    """The projects the editor knows, kept in <data>/projects.json; a project's id is fixed by
    its root, so its pages' links last."""

    def __init__(self, data_root: Path):
        self.file = data_root / "projects.json"
        # One Project a root, kept while projects.json names it: what it found out (its git) stays.
        self._known: dict[str, Project] = {}

    def _roots(self) -> list[str]:
        try:
            roots = json.loads(self.file.read_text("utf-8")).get("roots", [])
        except (OSError, ValueError, AttributeError):
            return []
        return [r for r in roots if isinstance(r, str)]

    @staticmethod
    def id_of(root: Path) -> str:
        return hashlib.sha1(str(root).encode("utf-8")).hexdigest()[:10]

    def register(self, root: str) -> Project | None:
        path = Path(root).expanduser().resolve()
        if not path.is_dir() or path == Path(path.anchor) or path == Path.home():
            return None  # a project, not the whole disk or home
        roots = self._roots()
        if str(path) not in roots:
            roots.append(str(path))
            self.file.parent.mkdir(parents=True, exist_ok=True)
            self.file.write_text(json.dumps({"roots": roots}, ensure_ascii=False, indent=1), "utf-8")
        return self._known.get(str(path)) or Project(self.id_of(path), path)

    def all(self) -> list[Project]:
        roots = [r for r in self._roots() if Path(r).is_dir()]
        known = self._known
        self._known = {r: known.get(r) or Project(self.id_of(Path(r)), Path(r)) for r in roots}
        return [self._known[r] for r in roots]

    def get(self, project_id: str) -> Project | None:
        return next((p for p in self.all() if p.id == project_id), None)

    def find(self, key: str) -> Project | None:
        """A project by its id, its root, or the name of its folder (the first of that name)."""
        found = self.all()
        root = str(Path(key).expanduser().resolve()) if key.startswith(("/", "~")) else None
        return (
            next((p for p in found if p.id == key), None)
            or next((p for p in found if str(p.root) == root), None)
            or next((p for p in found if p.name == key), None)
        )


def compared(doc: dict, seen: str | None) -> dict:
    """A file as read (Project.read), each diagram given what Claude last wrote of it (seen: the
    whole file's text, None when Claude has not written it) and what changed since then and
    since the last commit, as unified diffs."""
    seen_diagrams = diagrams_of(seen, doc["kind"]) if seen is not None else []
    for d in doc["diagrams"]:
        d["seen"] = seen_diagrams[d["index"]]["text"] if d["index"] < len(seen_diagrams) else None
        d["seenDiff"] = diff(d["seen"], d["text"]) if d["seen"] is not None else ""
        d["headDiff"] = diff(d["head"], d["text"]) if d["head"] is not None else ""
    return doc
