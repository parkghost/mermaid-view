"""The editor's HTTP side: the page, its modules, and the JSON API over two kinds of documents,
the pages kept from conversations (store.py) and the files of registered projects (projects.py);
the pages open in a browser, which a new diagram can be shown in (viewers.py); and the same
documents for an agent, as an MCP server at /mcp (mcp.py, its tools mcp_tools.py), whose diagrams
an open page checks with Mermaid's parser (checks.py).

Listens on 127.0.0.1 only, and refuses a request whose Host or Origin names another site (a
page elsewhere cannot reach it through DNS rebinding or a cross-site POST); no other site may
frame its page (Content-Security-Policy frame-ancestors).
"""

from __future__ import annotations

import json
import re
import select
import socket
import zipfile
from collections.abc import Callable
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

import mcp
from archive import MAX_ARCHIVE, export_zip, import_zip, page_markdown
from checks import Checks
from mcp_tools import (
    MAX_LISTED,
    MOD_NAMES,
    DiagramTools,
    SyntaxTools,
    file_report,
    files_report,
    page_report,
    search_report,
)
from projects import Conflict, Project, Projects, compared, diagrams_of, kind
from reference import SyntaxReference
from store import Store
from viewers import Viewers

ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
NOTE_LANGS = {"en", "zh-Hant"}  # the languages the mod asks Claude in (hooks/register.ts promptFor)
STATIC = re.compile(r"^[a-z0-9-]+\.(js|css|json)$")  # the page's own modules and data (not their .mjs tests)
STATIC_TYPES = {".js": "text/javascript", ".css": "text/css", ".json": "application/json"}
MAX_BODY = 1_000_000
HERE = Path(__file__).resolve().parent
MCP_INSTRUCTIONS = (
    "mermaid-view keeps Mermaid diagrams: pages (diagrams of answers, edited by the person in a browser editor) "
    "and the ```mermaid blocks and .mmd files of registered projects. Find them with search_diagrams; read a "
    "page's edits with get_page; show new diagrams with create_page; edit with update_diagram or, for a project "
    "file, get_file_diagrams then update_file_diagram with its version as base. The editor renders with Mermaid "
    "12.1.0: before writing a diagram type you are unsure about, read get_syntax_reference; check a source with "
    "check_diagram (writes report their check too; checking needs an editor tab open)."
)


def page_only(parts: list[str]) -> bool:
    """A route only the editor's own page calls: its event stream and its reports as a viewer."""
    return parts == ["api", "events"] or (len(parts) == 3 and parts[:2] == ["api", "viewers"])


def plugin_version() -> str:
    try:
        return json.loads((HERE.parent / ".claude-plugin" / "plugin.json").read_text("utf-8")).get("version", "0")
    except (OSError, ValueError):
        return "0"


class Handler(BaseHTTPRequestHandler):
    store: Store
    projects: Projects
    viewers: Viewers
    checks: Checks
    mcp: mcp.Endpoint
    port: int
    # What Claude last wrote to a project file, by (project id, path): the base its edits are
    # compared with. Kept while the server runs.
    seen: dict[tuple[str, str], str] = {}

    def log_message(self, format, *args):  # quiet: the mod reads stdout for the port only
        pass

    # ---- plumbing

    def _hosts(self) -> set[str]:
        return {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}

    def _local(self) -> bool:
        if self.headers.get("Host") not in self._hosts():
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in {f"http://{h}" for h in self._hosts()}

    def _own_page(self) -> bool:
        """Whether a request may be the editor's own page (or a client that is no browser): a
        browser says Sec-Fetch-Site same-origin for it. A page of another site that frames or
        loads an editor URL sends cross-site and no Origin, which _local lets through."""
        return self.headers.get("Sec-Fetch-Site") in (None, "same-origin")

    def _send(self, status: int, body: bytes, kind: str, headers: dict[str, str] | None = None) -> None:
        """A response; headers: more of them, or other values for Cache-Control (no-store)."""
        self.send_response(status)
        self.send_header("Content-Type", kind)
        for name, value in {"Cache-Control": "no-store", **(headers or {})}.items():
            self.send_header(name, value)
        if kind.startswith("text/html"):  # no other site may frame a page of the editor (clickjacking)
            self.send_header("Content-Security-Policy", "frame-ancestors 'self'")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _download(self, body: bytes, kind: str, filename: str) -> None:
        self._send(200, body, kind, {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"})

    def _json(self, value, status: int = 200) -> None:
        self._send(status, json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _kind(self) -> str:
        """The request body's media type, without its parameters."""
        return self.headers.get("Content-Type", "").split(";")[0]

    def _read_body(self, limit: int) -> bytes | None:
        """The request's body; None, left unread, when it is longer than limit."""
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length <= limit else None

    def _body(self) -> dict | None:
        raw = self._read_body(MAX_BODY) if self._kind() == "application/json" else None
        if raw is None:
            return None
        try:
            value = json.loads(raw or b"{}")
        except ValueError:
            return None
        return value if isinstance(value, dict) else None

    def _parts(self) -> list[str]:
        return [p for p in urlsplit(self.path).path.split("/") if p]

    def _query(self, name: str) -> str:
        return (parse_qs(urlsplit(self.path).query).get(name) or [""])[0]

    def _reported(self, value: dict, report: Callable[[], str]) -> None:
        """value as JSON; with ?report=1, its report as text too ("report"): what the mod's tools
        relay to Claude, naming the mod's tools (mcp_tools.MOD_NAMES)."""
        self._json({**value, "report": report()} if self._query("report") == "1" else value)

    def _mcp(self):
        """The MCP endpoint: POST only (no server-to-client stream, no session to end)."""
        if self.command != "POST":
            self.send_response(405)
            self.send_header("Allow", "POST")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        raw = self._read_body(MAX_BODY)
        if raw is None:
            return self._json(mcp.Failure(mcp.INVALID_REQUEST, "Request too large").body(), 413)
        reply = self.mcp.post(self.headers, raw)
        if reply.body is None:
            return self._send(reply.status, b"", "application/json")
        self._json(reply.body, reply.status)

    def _project(self, parts: list[str]) -> Project | None:
        """The project of /api/projects/<id>/..."""
        if len(parts) >= 3 and parts[:2] == ["api", "projects"]:
            return self.projects.get(parts[2])
        return None

    # ---- methods

    def _handle(self, handler: Callable[[list[str]], None]) -> None:
        """Every request: refused unless its route lets it through, else handled. /mcp takes a
        page on this machine (an MCP client in a browser), not one elsewhere; a page-only route,
        only the editor's own page (_own_page); everything else, only requests to this server
        from no other site (_local)."""
        parts = self._parts()
        if parts == ["mcp"]:
            if self.headers.get("Host") not in self._hosts() or not mcp.origin_allowed(self.headers.get("Origin")):
                return self._json(mcp.Failure(mcp.INVALID_REQUEST, "Forbidden: not a local origin").body(), 403)
            return self._mcp()
        if not self._local() or (page_only(parts) and not self._own_page()):
            return self._send(403, b"forbidden", "text/plain")
        handler(parts)

    def do_GET(self):
        self._handle(self._get)

    def do_PUT(self):
        self._handle(self._put)

    def do_PATCH(self):
        self._handle(self._patch)

    def do_DELETE(self):
        self._handle(self._delete)

    def do_POST(self):
        self._handle(self._post)

    def _get(self, parts: list[str]):
        if parts in ([], ["d"]) or (len(parts) == 2 and parts[0] in ("d", "f") and ID.match(parts[1])):
            return self._send(200, (HERE / "editor.html").read_bytes(), "text/html; charset=utf-8")
        if len(parts) == 2 and parts[0] == "static" and STATIC.match(parts[1]):
            file = HERE / "static" / parts[1]
            if file.is_file():
                return self._static(file)
        if parts[:2] == ["api", "projects"]:
            return self._get_project(parts)
        if parts == ["api", "events"]:
            return self._events()
        if parts == ["api", "export.zip"]:
            return self._download(export_zip(self.store.root), "application/zip", "mermaid-view-pages.zip")
        if parts[:2] == ["api", "pages"]:
            return self._get_page(parts)
        self._json({"error": "not found"}, 404)

    def _static(self, file: Path):
        """A module or data file of the page: the browser keeps it but asks each time (no-cache),
        and is sent it again only when it changed (its ETag: the file's mtime and size)."""
        stat = file.stat()
        tag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
        headers = {"Cache-Control": "no-cache", "ETag": tag, "Last-Modified": formatdate(stat.st_mtime, usegmt=True)}
        kind = f"{STATIC_TYPES[file.suffix]}; charset=utf-8"
        if tag in (t.strip() for t in self.headers.get("If-None-Match", "").split(",")):
            return self._send(304, b"", kind, headers)
        self._send(200, file.read_bytes(), kind, headers)

    def _events(self):
        """A page's event stream (Server-Sent Events), open while the page is: a page-only route
        (one framed by another site would take the diagrams shown)."""
        viewer_id = self._query("viewer")
        if not ID.match(viewer_id):
            return self._json({"error": "bad request"}, 400)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        viewer = self.viewers.connect(viewer_id)
        try:
            self.wfile.write(b": connected\n\n")
        except OSError:
            pass  # gone already: serve() finds out and lets it go
        self.viewers.serve(viewer, self.wfile.write, self._listening)
        self.close_connection = True

    def _listening(self) -> bool:
        """Whether the page at the other end still listens: it sends nothing on its stream, so
        anything readable is the end of the connection."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return not readable or self.connection.recv(1, socket.MSG_PEEK) != b""
        except OSError:
            return False

    def _get_page(self, parts: list[str]):
        if parts == ["api", "pages"]:
            query = self._query("q")
            pages = self.store.find(query, self._query("project"))
            return self._reported({"pages": pages}, lambda: search_report(query, pages[:MAX_LISTED], MOD_NAMES))
        if len(parts) < 3 or not ID.match(parts[2]):
            return self._json({"error": "bad request"}, 400)
        page_id = parts[2]
        if len(parts) == 3:
            page = self.store.page(page_id)
            return (
                self._reported(page, lambda: page_report(page)) if page else self._json({"error": "no such page"}, 404)
            )
        if len(parts) == 4 and parts[3] == "export.md":
            page = self.store.page(page_id)
            if not page:
                return self._json({"error": "no such page"}, 404)
            name = re.sub(r'[\\/:*?"<>|\s]+', "-", page.get("title") or page_id).strip("-") or page_id
            markdown = page_markdown(page, self._query("lang"))
            return self._download(markdown.encode("utf-8"), "text/markdown; charset=utf-8", f"{name}.md")
        history = self.store.history
        if len(parts) == 5 and parts[3].isdigit() and parts[4] == "history":
            commits = history.log(page_id, int(parts[3])) if history else []
            return self._json({"enabled": bool(history and history.enabled), "commits": commits})
        if len(parts) == 6 and parts[3].isdigit() and parts[4] == "version":
            text = history.text_at(page_id, int(parts[3]), parts[5]) if history else None
            return self._json({"text": text}) if text is not None else self._json({"error": "no such version"}, 404)
        self._json({"error": "not found"}, 404)

    def _get_project(self, parts: list[str]):
        if parts == ["api", "projects"]:
            return self._json({"projects": [p.info() for p in self.projects.all()]})
        project = self._project(parts)
        if project is None:
            return self._json({"error": "no such project"}, 404)
        action = parts[3] if len(parts) == 4 else ""
        path = self._query("path")
        if action == "files":
            files = project.files(self._query("q"))
            return self._reported(
                {"project": project.info(), "files": files},
                lambda: files_report(project, files[:MAX_LISTED], MOD_NAMES),
            )
        if action == "file":
            # A page that polls it says the version and commit it has: when both still hold, it is told so only.
            known = self._query("version")
            if known and project.unchanged(path, known, self._query("head")):
                return self._json({"unchanged": True})
            doc = project.read(path)
            if doc is None:
                return self._json({"error": "no such file"}, 404)
            # What changed since Claude wrote it, and since the last commit.
            doc = compared(doc, self.seen.get((project.id, doc["path"])))
            return self._reported(doc, lambda: file_report(doc, MOD_NAMES))
        if action == "history":
            return self._json({"enabled": project.git.enabled, "commits": project.history(path)})
        if action == "version":
            index = self._query("index")
            text = project.diagram_at(path, int(index), self._query("commit")) if index.isdigit() else None
            return self._json({"text": text}) if text is not None else self._json({"error": "no such version"}, 404)
        self._json({"error": "not found"}, 404)

    def _put(self, parts: list[str]):
        body = self._body()
        if body is None:
            return self._json({"error": "bad request"}, 400)
        if len(parts) == 4 and parts[:2] == ["api", "pages"] and ID.match(parts[2]) and parts[3].isdigit():
            if not isinstance(body.get("text"), str):
                return self._json({"error": "bad request"}, 400)
            saved = self.store.save(parts[2], int(parts[3]), body["text"])
            return self._json(saved) if saved is not None else self._json({"error": "no such diagram"}, 404)
        project = self._project(parts)
        if project is not None and parts[3:] == ["file"]:
            index, text, base = body.get("index"), body.get("text"), body.get("version")
            if not isinstance(index, int) or not isinstance(text, str) or not isinstance(base, str):
                return self._json({"error": "bad request"}, 400)
            try:
                saved = project.save(self._query("path"), index, text, base)
            except Conflict as c:
                return self._json({"error": "the file changed on disk", "version": c.current}, 409)
            return (
                self._json({"version": saved["version"]})
                if saved is not None
                else self._json({"error": "no such diagram"}, 404)
            )
        self._json({"error": "not found"}, 404)

    def _import(self):
        if self._kind() != "application/zip":
            return self._json({"error": "send a zip (application/zip)"}, 400)
        data = self._read_body(MAX_ARCHIVE)
        if not data:
            return self._json({"error": "archive empty or too large"}, 400)
        try:
            result = import_zip(self.store.root, data)
        except zipfile.BadZipFile:
            return self._json({"error": "not a zip archive"}, 400)
        if result["added"] and self.store.history:
            self.store.history.commit_now(f"Import {len(result['added'])} page(s)")
        return self._json(result)

    def _patch(self, parts: list[str]):
        body = self._body()
        if body is None or len(parts) != 3 or parts[:2] != ["api", "pages"] or not ID.match(parts[2]):
            return self._json({"error": "bad request"}, 400)
        updated = self.store.update(parts[2], body)
        return self._json(updated) if updated else self._json({"error": "no such page"}, 404)

    def _delete(self, parts: list[str]):
        if len(parts) != 3 or parts[:2] != ["api", "pages"] or not ID.match(parts[2]):
            return self._json({"error": "bad request"}, 400)
        return self._json({"ok": True}) if self.store.delete(parts[2]) else self._json({"error": "no such page"}, 404)

    def _post(self, parts: list[str]):
        if parts == ["api", "import"]:
            return self._import()
        body = self._body()
        if body is None:
            return self._json({"error": "bad request"}, 400)
        # The mod takes the next note for Claude and acks whether the prompt box took it; the tabs
        # hear each note's state (event `note`): waiting (refused for now), delivered, or dropped.
        if parts == ["api", "outbox", "take"]:
            self.store.expire()
            return self._json({"item": self.store.take()})
        if parts == ["api", "outbox", "ack"]:
            note_id, filled = body.get("id"), body.get("filled")
            if not isinstance(note_id, str) or not isinstance(filled, bool):
                return self._json({"error": "bad request"}, 400)
            self.store.ack(note_id, filled)
            return self._json({"ok": True})
        if parts == ["api", "show"]:  # a new diagram into a page already open: {"shown": false} when none takes it
            url = body.get("url")
            if not isinstance(url, str) or not re.match(r"^/[df]/[A-Za-z0-9_-]", url):
                return self._json({"error": "bad request"}, 400)
            outcome = self.viewers.show(url)  # offered: the page has edits in progress and offers it
            return self._json({"shown": outcome is not None, "offered": outcome == "offered"})
        if len(parts) == 3 and parts[:2] == ["api", "viewers"] and ID.match(parts[2]):
            busy, visible, idle = body.get("busy"), body.get("visible"), body.get("idle")
            if (
                not isinstance(busy, bool)
                or not isinstance(visible, (bool, type(None)))
                or not (idle is None or (isinstance(idle, (int, float)) and not isinstance(idle, bool) and idle >= 0))
            ):
                return self._json({"error": "bad request"}, 400)
            known = self.viewers.report(parts[2], busy, visible, idle)
            return self._json({"ok": True}) if known else self._json({"error": "no such viewer"}, 404)
        if len(parts) == 3 and parts[:2] == ["api", "checks"] and ID.match(parts[2]):  # a page's answer to a check
            viewer = body.get("viewer")
            taken = isinstance(viewer, str) and self.checks.answer(parts[2], viewer, body.get("reports"))
            return self._json({"ok": True}) if taken else self._json({"error": "no such check"}, 404)
        if parts == ["api", "projects"]:
            root = body.get("root")
            project = self.projects.register(root) if isinstance(root, str) else None
            return self._json(project.info()) if project else self._json({"error": "not a project folder"}, 400)
        if parts[:2] == ["api", "projects"]:
            return self._post_project(parts, body)
        if parts == ["api", "pages"]:  # a new page of an answer's diagrams (the mod's show)
            diagrams, title = body.get("diagrams"), body.get("title", "")
            if (
                not isinstance(diagrams, list)
                or not diagrams
                or not isinstance(title, str)
                or not all(isinstance(d, str) and d.strip() for d in diagrams)
            ):
                return self._json({"error": "bad request"}, 400)
            return self._json({"id": self.store.create(diagrams, title, body)})
        if len(parts) == 4 and parts[:2] == ["api", "pages"] and ID.match(parts[2]):
            return self._post_page(parts[2], parts[3], body)
        self._json({"error": "not found"}, 404)

    def _post_page(self, page_id: str, action: str, body: dict):
        if action == "label":
            commit, name = body.get("commit"), body.get("name", "")
            if not self.store.history or not isinstance(commit, str) or not isinstance(name, str):
                return self._json({"error": "bad request"}, 400)
            return self._json({"labels": self.store.history.label(page_id, commit, name)})
        if action == "send":
            return self._leave_note({"page": page_id, "note": body.get("note")}, body)
        self._json({"error": "not found"}, 404)

    def _leave_note(self, item: dict, body: dict):
        """A note for Claude from a tab (Store.leave): its id; the tabs hear what becomes of it. The
        tab's language (body["lang"]) is the language the mod asks Claude in; English otherwise."""
        lang = body.get("lang")
        item["lang"] = lang if lang in NOTE_LANGS else "en"
        return self._json({"ok": True, "id": self.store.leave(item)})

    def _post_project(self, parts: list[str], body: dict):
        project = self._project(parts)
        if project is None:
            return self._json({"error": "no such project"}, 404)
        action = parts[3] if len(parts) == 4 else ""
        path = self._query("path")
        if action == "file":  # a diagram into the project: a new .mmd, or a block in a document
            text, heading = body.get("text"), body.get("heading", "")
            if not isinstance(text, str) or not isinstance(heading, str):
                return self._json({"error": "bad request"}, 400)
            try:
                added = project.add(path, text, heading)
            except Conflict:
                return self._json({"error": "that file exists already"}, 409)
            return (
                self._json(added)
                if added
                else self._json({"error": "not a document or diagram path in the project"}, 400)
            )
        if action == "seen":  # Claude wrote the file: the base its later edits compare with
            file = project.resolve(path)
            if file is None or not isinstance(body.get("text"), str):
                return self._json({"error": "bad request"}, 400)
            self.seen[(project.id, project.rel(file))] = body["text"]
            return self._json({"ok": True, "diagrams": len(diagrams_of(body["text"], kind(file)))})
        if action == "send":
            file = project.resolve(path)
            if file is None:
                return self._json({"error": "bad request"}, 400)
            return self._leave_note(
                {
                    "project": project.id,
                    "projectName": project.name,
                    "file": project.rel(file),
                    "note": body.get("note"),
                },
                body,
            )
        self._json({"error": "not found"}, 404)


def make_server(store: Store, projects: Projects, port: int) -> ThreadingHTTPServer:
    """A server on 127.0.0.1:port, or on any free port when that one is taken."""
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    Handler.store = store
    Handler.projects = projects
    Handler.viewers = Viewers()
    store.on_note = lambda note_id, state: Handler.viewers.broadcast("note", {"id": note_id, "state": state})
    Handler.seen = {}
    Handler.port = port

    def url(path: str) -> str:
        return f"http://localhost:{port}{path}"

    Handler.checks = Checks(Handler.viewers, url("/"))
    syntax = SyntaxTools(SyntaxReference(), Handler.checks)
    diagrams = DiagramTools(store, projects, Handler.viewers, Handler.seen, url, Handler.checks)
    Handler.mcp = mcp.Endpoint(syntax.tools() + diagrams.tools(), "mermaid-view", plugin_version(), MCP_INSTRUCTIONS)
    return server
