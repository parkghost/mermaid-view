"""The editor's MCP tools (served by mcp.py): what an agent outside Claude Code's mod can do with
the two kinds of documents, through the same code the editor's own API uses. Pages: find, read
with their diffs, create (shown in the open tab when one takes it), edit. Project files: read and
replace one diagram, refused when the file changed since the version the edit was made on.
Syntax: each diagram type's reference for Mermaid 12.1.0, and a check of a source by Mermaid's
parser and the editor's lint, run in an open editor tab (checks.py); every write reports its check.

A diagram's index counts from 0 (diagram 1 is index 0); the reports name both.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from checks import Checks
from fences import fenced
from mcp import Result, Tool, ToolError
from projects import Conflict, Project, Projects, compared
from reference import SyntaxReference
from store import Store, is_page_id
from viewers import Viewers

MAX_LISTED = 30  # pages, and files per project, in a search

READ_ONLY = {"readOnlyHint": True, "openWorldHint": False}
ADDS = {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}
REPLACES = {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True, "openWorldHint": False}

INDEX = {"type": "integer", "minimum": 0, "description": "The diagram's index, from 0 (diagram 1 is index 0)."}
SOURCE = {"type": "string", "description": "The diagram's whole Mermaid source, without the ``` fence."}
PROJECT = {"type": "string", "description": "A registered project: its id, its root folder, or its folder name."}
PATH = {"type": "string", "description": "The file's path relative to the project root, e.g. docs/architecture.md."}
TYPE = {
    "type": "string",
    "description": "A diagram type: its id (from get_syntax_reference without type) or its header keyword, e.g. flowchart, graph, sequenceDiagram, stateDiagram-v2, architecture-beta.",
}
VERSION_NOTE = (
    "The editor renders with Mermaid 12.1.0: syntax of other Mermaid versions may not parse; call "
    "get_syntax_reference before writing a diagram type you are unsure about."
)


def check_report(report: dict, what: str = "") -> str:
    """A check's report as text: valid or not, by what, and each finding on its line."""
    lead = f"{what}: " if what else ""
    if not report["checked"]:
        return f"{lead}Not checked: {report['reason']}."
    errors, warnings = report["errors"], report["warnings"]
    verdict = "valid" if report["ok"] else "NOT valid"
    lines = [
        f"{lead}{verdict} ({report['typeName'] or 'no known diagram type'}; {len(errors)} error(s), "
        f"{len(warnings)} warning(s); checked by {report['checker']})."
    ]
    lines += [f"- line {f['line']} {f['severity']} [{f['rule']}]: {f['message']}" for f in errors + warnings]
    return "\n".join(lines)


@dataclass(frozen=True)
class Names:
    """The tools a report points to, as its caller has them: page reads a page by its id, file
    reads a project file's diagrams (file_arg: its argument for the file's path), update_file
    writes one ("" where the caller has none)."""

    page: str
    file: str
    file_arg: str
    update_file: str = ""


MCP_NAMES = Names("get_page", "get_file_diagrams", "path", "update_file_diagram")
# The Claude Code mod's tools (hooks/register.ts), which relay the reports of the HTTP API.
MOD_NAMES = Names("mcp__mermaid-view__diagram_edits", "mcp__mermaid-view__diagram_edits", "file")


def search_report(query: str, pages: list[dict], names: Names) -> str:
    if not pages:
        return f'No mermaid-view page matches "{query}".' if query else "No mermaid-view page exists yet."
    lines = [f"{len(pages)} page(s); read one with {names.page} and its id."]
    for p in pages:
        where = "@".join(x for x in (p["project"] or "(no project)", p["branch"]) if x)
        flags = " ".join(
            [*(["edited"] if p["edited"] else []), *(["pinned"] if p["pinned"] else []), *(f"#{t}" for t in p["tags"])]
        )
        lines.append(
            f"- {p['id']} · {where} · {p['title'] or '(untitled)'} · {p['count']} × {'/'.join(p['kinds']) or 'diagram'}"
            + (f" · {flags}" if flags else "")
        )
        lines += [f"    diagram {m['diagram'] + 1} line {m['line']}: {m['text']}" for m in p.get("matches", [])]
    return "\n".join(lines)


def files_report(project: Project, files: list[dict], names: Names) -> str:
    lines = [
        f"{len(files)} file(s) of the project {project.name} (id {project.id}) hold matching diagrams; "
        f"read one with {names.file} and its {names.file_arg}."
    ]
    for f in files:
        lines.append(f"- {f['path']} · {f['count']} × {'/'.join(f['kinds']) or 'diagram'}")
        lines += [f"    line {m['line']}: {m['text']}" for m in f["matches"]]
    return "\n".join(lines)


def page_report(page: dict) -> str:
    diagrams = page["diagrams"]
    edited = sum(d["edited"] is not None for d in diagrams)
    state = (
        f"{edited} of {len(diagrams)} diagram(s) edited by the person"
        if edited
        else f"the person has not edited any of its {len(diagrams)} diagram(s)"
    )
    parts = [f"Page {page['id']} · {page['title'] or '(untitled)'}: {state}."]
    for d in diagrams:
        where = f"Diagram {d['index'] + 1} (index {d['index']})"
        if d["edited"] is None:
            parts.append(f"{where}, as first written:\n{fenced('mermaid', d['original'])}")
        else:
            parts.append(
                f"{where}, edited by the person. Diff (original is the diagram as first written):\n"
                f"{fenced('diff', d['diff'])}\nSource now:\n{fenced('mermaid', d['edited'])}"
            )
    return "\n\n".join(parts)


def file_report(doc: dict, names: Names) -> str:
    """A file as compared (projects.compared): per diagram what changed since an agent last wrote
    the file (while the editor runs), else since the last commit, and its source now."""
    diagrams = doc["diagrams"]
    name = f"{doc['project']['name']} / {doc['path']}"
    if not diagrams:
        return f"{name} holds no Mermaid diagram."
    base = f", version {doc['version']} (pass it as base to {names.update_file})" if names.update_file else ""
    head = [f"{name}: {len(diagrams)} diagram(s){base}."]
    if not doc["tracked"]:
        head.append("The file is not in the project's git yet.")
    parts = [" ".join(head)]
    for d in diagrams:
        where = f"Diagram {d['index'] + 1} (index {d['index']}, line {d['line']})"
        diff, since = (
            (d["seenDiff"], "an agent last wrote it") if d["seen"] is not None else (d["headDiff"], "the last commit")
        )
        if d["seen"] is None and d["head"] is None:
            state = ", new (not in the last commit):\n"
        elif diff:
            state = f", changed since {since}:\n{fenced('diff', diff)}\nSource now:\n"
        else:
            state = f", unchanged since {since}:\n"
        parts.append(f"{where}{state}{fenced('mermaid', d['text'])}")
    return "\n\n".join(parts)


class DiagramTools:
    """The tools over the editor's store, projects and open pages. seen: what Claude (or an agent
    through these tools) last wrote to each project file, by (project id, path); url: an editor
    path ("/d/<id>") as a full URL; checks: what checks a written diagram (after it is written)."""

    def __init__(
        self,
        store: Store,
        projects: Projects,
        viewers: Viewers,
        seen: dict[tuple[str, str], str],
        url: Callable[[str], str],
        checks: Checks,
    ):
        self.store, self.projects, self.viewers, self.seen, self.url = store, projects, viewers, seen, url
        self.checks = checks

    def tools(self) -> list[Tool]:
        return [
            Tool(
                "search_diagrams",
                "Search diagrams",
                "Finds Mermaid diagrams kept by mermaid-view: pages (diagrams of earlier answers, across sessions "
                "and projects) by words in their title, tags, project or source, and the Markdown documents and "
                ".mmd files of registered projects by path or source. Every word must match; an empty query lists "
                "the newest. Lists page ids and file paths with their matching lines, newest first.",
                {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Words to find; empty lists the newest pages."},
                        "project": {
                            "type": "string",
                            "description": 'Only this project, by its folder name, e.g. "realtime-voice-agent".',
                        },
                    },
                    "additionalProperties": False,
                },
                self.search,
                READ_ONLY,
            ),
            Tool(
                "get_page",
                "Read a page",
                "Reads a mermaid-view page: each diagram as first written and as it is now, with a unified diff "
                "where the person edited it in the browser editor. Find the page id with search_diagrams. In "
                "Claude Code with the mermaid-view mod, its diagram_edits tool reads the session's newest page "
                "without an id.",
                {
                    "type": "object",
                    "properties": {
                        # Not in "required": without it, the error names where an id comes from.
                        "page": {
                            "type": "string",
                            "description": "The page id (from search_diagrams or create_page); required.",
                        },
                    },
                    "additionalProperties": False,
                },
                self.get_page,
                READ_ONLY,
            ),
            Tool(
                "create_page",
                "Show diagrams",
                "Keeps Mermaid diagrams as a new mermaid-view page and shows it in the editor tab already open "
                "(the most recently used one without unsaved edits). Returns the page id, its URL, whether "
                "an open tab showed it (if not, give the person the URL), and each diagram's check (Mermaid's "
                "parser and the editor's lint; fix what is not valid with update_diagram). " + VERSION_NOTE,
                {
                    "type": "object",
                    "properties": {
                        "diagrams": {
                            "type": "array",
                            "items": {"type": "string"},
                            "minItems": 1,
                            "description": "Each diagram's Mermaid source, without the ``` fence.",
                        },
                        "title": {"type": "string", "description": "The page's title, shown in the library."},
                        "project": {
                            "type": "string",
                            "description": "The project the page belongs to: a registered project's id, root or folder name, or any name to group it under.",
                        },
                    },
                    "required": ["diagrams"],
                    "additionalProperties": False,
                },
                self.create_page,
                ADDS,
            ),
            Tool(
                "update_diagram",
                "Edit a page's diagram",
                "Replaces one diagram of a mermaid-view page, saved as an edit is in the editor (its history "
                "keeps the version before). A tab showing the page reloads it, unless it has unsaved edits. "
                "Returns the diff and the new source's check (Mermaid's parser and the editor's lint). " + VERSION_NOTE,
                {
                    "type": "object",
                    "properties": {
                        "page": {"type": "string", "description": "The page id."},
                        "index": INDEX,
                        "source": SOURCE,
                    },
                    "required": ["page", "index", "source"],
                    "additionalProperties": False,
                },
                self.update_diagram,
                REPLACES,
            ),
            Tool(
                "get_file_diagrams",
                "Read a project file's diagrams",
                "Reads the Mermaid diagrams of a project's Markdown document (each ```mermaid block) or .mmd "
                "file: each one's source and line, what changed since an agent last wrote it (else since the "
                "last commit), and the file's version to pass as base to update_file_diagram.",
                {
                    "type": "object",
                    "properties": {"project": PROJECT, "path": PATH},
                    "required": ["project", "path"],
                    "additionalProperties": False,
                },
                self.get_file_diagrams,
                READ_ONLY,
            ),
            Tool(
                "update_file_diagram",
                "Edit a project file's diagram",
                "Replaces one Mermaid diagram of a project's Markdown document or .mmd file in place; the rest "
                "of the file stays as it was. With base (the version get_file_diagrams gave), nothing is written "
                "if the file changed since: the result is an error with the file's version and that diagram now. "
                "An editor tab showing the file follows it. Returns the new source's check (Mermaid's parser and "
                "the editor's lint). " + VERSION_NOTE,
                {
                    "type": "object",
                    "properties": {
                        "project": PROJECT,
                        "path": PATH,
                        "index": INDEX,
                        "source": SOURCE,
                        "base": {
                            "type": "string",
                            "description": "The file's version the edit was made on (from get_file_diagrams); omitted, the file is written whatever it holds now.",
                        },
                    },
                    "required": ["project", "path", "index", "source"],
                    "additionalProperties": False,
                },
                self.update_file_diagram,
                REPLACES,
            ),
        ]

    # ---- pages

    def search(self, args: dict) -> Result:
        query, name = args.get("query", "").strip(), args.get("project", "").strip()
        pages = self.store.find(query, name)[:MAX_LISTED]
        texts = [search_report(query, pages, MCP_NAMES)]
        files = []
        for project in self.projects.all():
            if name and name not in (project.name, project.id):
                continue
            found = project.files(query)[:MAX_LISTED]
            if found:
                texts.append(files_report(project, found, MCP_NAMES))
                files += [{"projectId": project.id, "project": project.name, **f} for f in found]
        return Result("\n\n".join(texts), {"pages": pages, "files": files})

    def _page(self, page_id: str) -> dict:
        if not is_page_id(page_id):
            raise ToolError(
                f'"{page_id}" is not a page id (one reads like 2026-10-11T07-09-36-825); find one with search_diagrams.'
            )
        page = self.store.page(page_id)
        if page is None:
            raise ToolError(f'No page "{page_id}"; find one with search_diagrams.')
        return page

    def get_page(self, args: dict) -> Result:
        # No "newest page" here: the session that started this server is not the one asking after
        # a /clear (same server, new session), nor for another client.
        if not args.get("page"):
            raise ToolError(
                "Give a page id: find one with search_diagrams. In Claude Code with the mermaid-view mod, "
                "its diagram_edits tool reads the current session's newest page without an id."
            )
        page = self._page(args["page"])
        diagrams = [
            {
                "index": d["index"],
                "original": d["original"],
                "current": d["edited"] if d["edited"] is not None else d["original"],
                "edited": d["edited"] is not None,
                "diff": d["diff"],
            }
            for d in page["diagrams"]
        ]
        return Result(
            page_report(page),
            {
                "id": page["id"],
                "title": page["title"],
                "project": page["project"],
                "url": self.url(f"/d/{page['id']}"),
                "diagrams": diagrams,
            },
        )

    def create_page(self, args: dict) -> Result:
        diagrams = [d for d in args["diagrams"] if d.strip()]
        if not diagrams:
            raise ToolError("Every diagram is empty: give each one's Mermaid source.")
        key = args.get("project", "").strip()
        project = self.projects.find(key) if key else None
        origin = {"project": project.name, "projectRoot": str(project.root)} if project else {"project": key}
        page_id = self.store.create(diagrams, args.get("title", ""), origin)
        path = f"/d/{page_id}"
        outcome = self.viewers.show(path)
        shown = outcome is not None
        where = {
            "switched": "shown in the open editor tab",
            "offered": "offered in the open editor tab (it has edits in progress, so it did not switch)",
            None: "no editor tab took it: give the person the URL",
        }[outcome]
        checks = self.checks.check(diagrams)
        report = "\n".join(check_report(c, f"Diagram {i + 1} (index {i})") for i, c in enumerate(checks))
        return Result(
            f"Created page {page_id} with {len(diagrams)} diagram(s) at {self.url(path)}; {where}.\n{report}",
            {"id": page_id, "url": self.url(path), "shown": shown, "checks": checks},
        )

    def update_diagram(self, args: dict) -> Result:
        page = self._page(args["page"])
        index = args["index"]
        if index >= len(page["diagrams"]):
            raise ToolError(f"Page {page['id']} has {len(page['diagrams'])} diagram(s); index {index} is not one.")
        saved = self.store.save(page["id"], index, args["source"])
        if saved is None:
            raise ToolError(f"Diagram index {index} of page {page['id']} cannot be saved.")
        self.viewers.broadcast("changed", {"url": f"/d/{page['id']}"})
        what = (
            f"Diff from the first version:\n{fenced('diff', saved['diff'])}"
            if saved["edited"] is not None
            else "It is the first version again."
        )
        check = self.checks.check([args["source"]])[0]
        return Result(
            f"Saved diagram {index + 1} (index {index}) of page {page['id']}. {what}\n{check_report(check, 'Check')}",
            {
                "id": page["id"],
                "index": index,
                "edited": saved["edited"] is not None,
                "diff": saved["diff"],
                "check": check,
            },
        )

    # ---- project files

    def _project(self, key: str) -> Project:
        project = self.projects.find(key.strip())
        if project is None:
            names = ", ".join(f"{p.name} ({p.id})" for p in self.projects.all()) or "none"
            raise ToolError(f'No registered project "{key}". Registered: {names}.')
        return project

    @staticmethod
    def _no_file(project: Project, path: str) -> str:
        return f"No Markdown document or diagram file {path} in the project {project.name}."

    def _read(self, project: Project, path: str) -> dict:
        doc = project.read(path)
        if doc is None:
            raise ToolError(self._no_file(project, path))
        return compared(doc, self.seen.get((project.id, doc["path"])))

    def get_file_diagrams(self, args: dict) -> Result:
        doc = self._read(self._project(args["project"]), args["path"])
        return Result(file_report(doc, MCP_NAMES), doc)

    def update_file_diagram(self, args: dict) -> Result:
        project = self._project(args["project"])
        doc = project.current(args["path"])  # no git: its diagrams are only counted
        if doc is None:
            raise ToolError(self._no_file(project, args["path"]))
        index = args["index"]
        if index >= len(doc["diagrams"]):
            raise ToolError(f"{doc['path']} has {len(doc['diagrams'])} diagram(s); index {index} is not one.")
        try:
            saved = project.save(doc["path"], index, args["source"], args.get("base") or doc["version"])
        except Conflict as c:
            fresh = project.read(doc["path"])
            now = fresh["diagrams"][index]["text"] if fresh and index < len(fresh["diagrams"]) else None
            raise ToolError(
                f"{doc['path']} changed since version {args.get('base')}; nothing was written. It is version "
                f"{c.current} now, its diagram {index + 1} (index {index}) reads:\n{fenced('mermaid', now or '')}",
                {"conflict": True, "version": c.current, "index": index, "text": now},
            ) from None
        if saved is None:
            raise ToolError(f"Diagram index {index} of {doc['path']} cannot be saved.")
        self.seen[(project.id, doc["path"])] = saved["text"]  # the base the person's later edits compare with
        check = self.checks.check([args["source"]])[0]
        return Result(
            f"Saved diagram {index + 1} (index {index}) of {doc['path']}; the file is version {saved['version']} now.\n"
            f"{check_report(check, 'Check')}",
            {"path": doc["path"], "index": index, "version": saved["version"], "check": check},
        )


class SyntaxTools:
    """The tools that help write a diagram right: each type's syntax for Mermaid 12.1.0, and a
    check of a source without saving it."""

    def __init__(self, reference: SyntaxReference, checks: Checks):
        self.reference, self.checks = reference, checks

    def tools(self) -> list[Tool]:
        return [
            Tool(
                "get_syntax_reference",
                "Mermaid syntax reference",
                "The syntax of a Mermaid diagram type as Mermaid 12.1.0 (the version this editor renders with) "
                "takes it: header keywords and variants, statements, arrows, blocks, version differences and "
                "common mistakes, an example. Call it before writing a diagram type you are unsure about, since "
                "syntax from other Mermaid versions may not parse. Without type: every type with its header and purpose.",
                {"type": "object", "properties": {"type": TYPE}, "additionalProperties": False},
                self.get_syntax_reference,
                READ_ONLY,
            ),
            Tool(
                "check_diagram",
                "Check a diagram",
                "Checks a Mermaid source without saving it: Mermaid 12.1.0's parser (with the editor's config) and "
                "the editor's lint for its type, run in an open editor tab. Returns whether it is valid, the detected "
                "type, errors and warnings with line numbers, and what checked it. Not checked (an error) when no "
                "editor tab is open.",
                {
                    "type": "object",
                    "properties": {
                        "source": SOURCE,
                        "type": {
                            **TYPE,
                            "description": TYPE["description"]
                            + " Optional: the type you meant; a source of another type is reported.",
                        },
                    },
                    "required": ["source"],
                    "additionalProperties": False,
                },
                self.check_diagram,
                READ_ONLY,
            ),
        ]

    def _type(self, key: str) -> dict:
        entry = self.reference.find(key)
        if entry is None:
            raise ToolError(self.reference.unknown(key), {"types": self.reference.ids()})
        return entry

    def get_syntax_reference(self, args: dict) -> Result:
        key = args.get("type", "").strip()
        if not key:
            return Result(
                self.reference.list_report(), {"mermaid": self.reference.mermaid, "types": self.reference.summaries()}
            )
        entry = self._type(key)
        return Result(
            self.reference.type_report(entry),
            {"mermaid": self.reference.mermaid, "common": self.reference.common, **entry},
        )

    def check_diagram(self, args: dict) -> Result:
        key = args.get("type", "").strip()
        type_id = self._type(key)["id"] if key else ""
        report = self.checks.check([args["source"]], type_id)[0]
        if not report["checked"]:
            raise ToolError(check_report(report), report)
        return Result(check_report(report), report)
