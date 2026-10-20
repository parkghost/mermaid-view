"""python3 -I -m unittest discover -s editor  (from the repository root)"""

from __future__ import annotations

import http.client
import json
import queue
import socket
import sys
import tempfile
import threading
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from projects import Projects  # noqa: E402
from server import make_server  # noqa: E402
from store import MAX_NOTES, NOTE_TTL, Store  # noqa: E402


@dataclass
class Reply:
    status: int
    headers: http.client.HTTPMessage
    raw: bytes

    @property
    def json(self) -> Any:
        """The reply as JSON; None when it is none (a 202, a plain "forbidden")."""
        return json.loads(self.raw) if self.raw.startswith((b"{", b"[")) else None


def request(port: int, method: str, path: str, body: Any = None, headers: dict | None = None) -> Reply:
    """One request to the editor at port: body as JSON (bytes as they are; None, no body), as a
    client on this machine sends it (Content-Type JSON unless headers say otherwise)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    conn.request(method, path, data, {"Content-Type": "application/json", **(headers or {})})
    res = conn.getresponse()
    reply = Reply(res.status, res.headers, res.read())
    conn.close()
    return reply


def post(port: int, path: str, body: Any, headers: dict | None = None) -> tuple[int, Any]:
    reply = request(port, "POST", path, body, headers)
    return reply.status, reply.json


class Page:
    """A page open in the browser: its event stream read on a thread, each event into a queue;
    headers: more request headers, as a browser sends them."""

    def __init__(self, port: int, viewer_id: str, headers: dict | None = None):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        more = "".join(f"{k}: {v}\r\n" for k, v in (headers or {}).items())
        self.sock.sendall(
            f"GET /api/events?viewer={viewer_id} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{more}\r\n".encode()
        )
        self.stream = self.sock.makefile("rb")
        while self.stream.readline() not in (b"\r\n", b""):  # the response's head
            pass
        self.stream.readline()  # ": connected": the server knows this viewer from here on
        self.stream.readline()
        self.events: queue.Queue[tuple[str, dict]] = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        event = ""
        try:
            for raw in self.stream:
                line = raw.decode("utf-8").rstrip("\n")
                if line.startswith("event: "):
                    event = line[7:]
                elif line.startswith("data: "):
                    self.events.put((event, json.loads(line[6:])))
        except (OSError, ValueError):
            pass  # closed by the test

    def close(self):
        """The tab closes: its end of the connection goes away at once."""
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()


class ServerTest(unittest.TestCase):
    """A test with a fresh folder (self.tmp) and an editor server to start on it (serve); the pages
    it opens close, and the server stops, when it ends."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def serve(self, store: Store, projects: Projects) -> None:
        self.server = make_server(store, projects, 0)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def post(self, path: str, body: Any, headers: dict | None = None) -> tuple[int, Any]:
        return post(self.port, path, body, headers)

    def open_page(self, viewer_id: str, headers: dict | None = None) -> Page:
        page = Page(self.port, viewer_id, headers)
        self.addCleanup(page.close)  # before the server stops
        return page


class ShowTest(ServerTest):
    def setUp(self):
        super().setUp()
        root = Path(self.tmp.name)
        self.serve(Store(root), Projects(root))

    def test_with_no_page_open_nothing_is_shown(self):
        self.assertFalse(self.shown("/d/p1")["shown"])

    def test_an_idle_page_receives_the_diagram(self):
        page = self.open_page("v1")
        self.assertEqual(self.shown("/d/p1"), {"shown": True, "offered": False})
        self.assertEqual(page.events.get(timeout=5), ("show", {"url": "/d/p1"}))

    def shown(self, url: str) -> dict:
        status, out = self.post("/api/show", {"url": url})
        self.assertEqual(status, 200)
        return out

    def test_an_only_page_with_edits_in_progress_offers_the_diagram_instead_of_a_new_tab(self):
        page = self.open_page("v1")
        self.assertEqual(self.post("/api/viewers/v1", {"busy": True}), (200, {"ok": True}))
        self.assertEqual(self.shown("/d/p1"), {"shown": True, "offered": True})
        self.assertEqual(page.events.get(timeout=5), ("show", {"url": "/d/p1"}))
        self.post("/api/viewers/v1", {"busy": False})
        self.assertEqual(self.shown("/d/p2"), {"shown": True, "offered": False})

    def test_a_page_without_edits_is_taken_before_a_busy_one(self):
        idle, busy = self.open_page("v1"), self.open_page("v2")
        self.post("/api/viewers/v2", {"busy": True, "idle": 0})
        self.assertEqual(self.shown("/d/p1"), {"shown": True, "offered": False})
        self.assertEqual(idle.events.get(timeout=5), ("show", {"url": "/d/p1"}))
        self.assertEqual(busy.events.get(timeout=5), ("added", {"url": "/d/p1"}))  # it lists it only

    def test_the_most_recently_used_page_is_chosen(self):
        first, second = self.open_page("v1"), self.open_page("v2")
        self.post("/api/viewers/v1", {"busy": False, "idle": 0})  # focused after v2 opened
        self.assertTrue(self.shown("/d/p1")["shown"])
        self.assertEqual(first.events.get(timeout=5), ("show", {"url": "/d/p1"}))
        self.assertEqual(second.events.get(timeout=5), ("added", {"url": "/d/p1"}))

    def test_a_visible_page_is_chosen_before_a_hidden_one_used_later(self):
        shown = self.open_page("v1")
        self.open_page("v2")
        self.post("/api/viewers/v1", {"busy": False, "visible": True})
        self.post("/api/viewers/v2", {"busy": False, "idle": 0, "visible": False})
        self.assertTrue(self.shown("/d/p1")["shown"])
        self.assertEqual(shown.events.get(timeout=5), ("show", {"url": "/d/p1"}))

    def test_a_page_hidden_and_unused_for_long_is_passed_over(self):
        viewers = self.server.RequestHandlerClass.viewers
        page = self.open_page("v1")
        self.post("/api/viewers/v1", {"busy": False, "visible": False})
        later = viewers.clock() + viewers.stale + 1
        viewers.clock = lambda: later
        self.assertEqual(self.shown("/d/p1"), {"shown": False, "offered": False})  # a new tab instead
        self.post("/api/viewers/v1", {"busy": False, "idle": 0, "visible": True})  # looked at again
        self.assertTrue(self.shown("/d/p2")["shown"])
        self.assertEqual(page.events.get(timeout=5), ("added", {"url": "/d/p1"}))
        self.assertEqual(page.events.get(timeout=5), ("show", {"url": "/d/p2"}))

    def test_a_page_hidden_and_unused_for_long_stays_passed_over_when_its_stream_reconnects(self):
        viewers = self.server.RequestHandlerClass.viewers
        first = self.open_page("v1")
        self.post("/api/viewers/v1", {"busy": False, "visible": False})
        later = viewers.clock() + viewers.stale + 1
        viewers.clock = lambda: later
        first.close()  # the stream drops (the server restarted, the machine slept)
        self.open_page("v1")  # and the browser reconnects it: the same tab, still unused
        idle = viewers.stale + 1
        self.assertEqual(
            self.post("/api/viewers/v1", {"busy": False, "visible": False, "idle": idle}), (200, {"ok": True})
        )
        self.assertEqual(self.shown("/d/p1"), {"shown": False, "offered": False})  # a new tab instead

    def test_a_closed_page_is_passed_over(self):
        self.open_page("v1").close()
        self.assertFalse(self.shown("/d/p1")["shown"])
        live = self.open_page("v2")
        dead = self.open_page("v3")  # the most recent, but closed before the diagram comes
        dead.close()
        self.assertTrue(self.shown("/d/p2")["shown"])
        self.assertEqual(live.events.get(timeout=5), ("show", {"url": "/d/p2"}))

    def test_a_tab_hears_whether_its_note_reached_the_prompt_box(self):
        page = self.open_page("v1")
        status, sent = self.post("/api/pages/a1/send", {"note": "改成 C"})
        self.assertEqual(status, 200)
        item = self.post("/api/outbox/take", {})[1]["item"]
        self.assertEqual((item["id"], item["note"]), (sent["id"], "改成 C"))
        self.post("/api/outbox/ack", {"id": item["id"], "filled": False})  # a dialog is up
        self.assertEqual(page.events.get(timeout=5), ("note", {"id": sent["id"], "state": "waiting"}))
        self.assertEqual(self.post("/api/outbox/take", {})[1]["item"]["id"], sent["id"])  # tried again
        self.post("/api/outbox/ack", {"id": item["id"], "filled": True})
        self.assertEqual(page.events.get(timeout=5), ("note", {"id": sent["id"], "state": "delivered"}))
        self.assertIsNone(self.post("/api/outbox/take", {})[1]["item"])

    def test_a_tab_hears_that_its_note_was_dropped_undelivered(self):
        store = self.server.RequestHandlerClass.store
        page = self.open_page("v1")
        sent = self.post("/api/pages/a1/send", {"note": ""})[1]
        later = store.clock() + NOTE_TTL + 1
        store.clock = lambda: later
        self.assertIsNone(self.post("/api/outbox/take", {})[1]["item"])
        self.assertEqual(page.events.get(timeout=5), ("note", {"id": sent["id"], "state": "dropped"}))

    def test_a_tab_hears_that_its_note_was_pushed_out_by_newer_ones(self):
        page = self.open_page("v1")
        sent = [self.post("/api/pages/a1/send", {"note": f"note {n}"})[1]["id"] for n in range(MAX_NOTES + 1)]
        self.assertEqual(page.events.get(timeout=5), ("note", {"id": sent[0], "state": "dropped"}))
        self.assertEqual(self.post("/api/outbox/take", {})[1]["item"]["id"], sent[1])  # the rest still wait, in order

    def status(self, method: str, path: str, headers: dict, body: dict | None = None) -> int:
        return request(self.port, method, path, body, headers).status

    def test_a_page_of_another_site_is_no_viewer(self):
        # An editor URL framed or loaded by another site: the browser sends no Origin, but says so.
        for site in ("cross-site", "same-site", "none"):
            self.assertEqual(self.status("GET", "/api/events?viewer=v9", {"Sec-Fetch-Site": site}), 403)
        self.assertFalse(self.shown("/d/p1")["shown"])  # no viewer took it: the mod opens a tab
        own = self.open_page("v1", {"Sec-Fetch-Site": "same-origin"})  # the editor's own page is one
        self.assertEqual(self.status("POST", "/api/viewers/v1", {"Sec-Fetch-Site": "cross-site"}, {"busy": True}), 403)
        self.assertEqual(self.shown("/d/p2"), {"shown": True, "offered": False})  # not made busy from elsewhere
        self.assertEqual(own.events.get(timeout=5), ("show", {"url": "/d/p2"}))

    def test_no_other_site_may_frame_the_editor_page(self):
        for path in ("/", "/d/a1", "/f/p1"):
            headers = request(self.port, "GET", path).headers
            self.assertTrue(headers.get("Content-Type", "").startswith("text/html"))
            self.assertIn("frame-ancestors 'self'", headers.get("Content-Security-Policy", ""))

    def test_the_pages_modules_are_sent_again_only_when_they_changed(self):
        first = request(self.port, "GET", "/static/app.js")
        tag = first.headers["ETag"]
        self.assertTrue(tag and first.raw)
        self.assertEqual(first.headers["Cache-Control"], "no-cache")  # kept, but asked for each time
        again = request(self.port, "GET", "/static/app.js", headers={"If-None-Match": tag})
        self.assertEqual((again.status, again.raw), (304, b""))
        other = request(self.port, "GET", "/static/app.js", headers={"If-None-Match": '"another-version"'})
        self.assertEqual((other.status, other.raw), (200, first.raw))
        self.assertEqual(
            request(self.port, "GET", "/d").headers["Cache-Control"], "no-store"
        )  # the page itself: never kept

    def test_bad_requests(self):
        self.assertEqual(self.post("/api/show", {"url": "https://example.com/"})[0], 400)
        self.assertEqual(self.post("/api/viewers/nobody", {"busy": False})[0], 404)
        self.open_page("v1")
        self.assertEqual(self.post("/api/viewers/v1", {"busy": "yes"})[0], 400)
        self.assertEqual(self.post("/api/viewers/v1", {"busy": False, "visible": "no"})[0], 400)
        self.assertEqual(self.post("/api/viewers/v1", {"busy": False, "idle": -5})[0], 400)  # used in the future
        self.assertEqual(self.post("/api/viewers/v1", {"busy": False, "idle": "long"})[0], 400)
        self.assertEqual(self.post("/api/outbox/ack", {"id": "x"})[0], 400)

    def test_a_new_page_is_written_and_its_id_returned(self):
        status, out = self.post(
            "/api/pages",
            {
                "diagrams": ["flowchart TD\n  A-->B", "sequenceDiagram\n  A->>B: hi"],
                "title": "Two",
                "project": "proj",
                "ignored": "x",
            },
        )
        self.assertEqual(status, 200)
        folder = Path(self.tmp.name) / "pages" / out["id"]
        meta = json.loads((folder / "meta.json").read_text("utf-8"))
        self.assertEqual((meta["count"], meta["title"], meta["project"]), (2, "Two", "proj"))
        self.assertNotIn("ignored", meta)
        self.assertEqual((folder / "original-1.mmd").read_text("utf-8"), "sequenceDiagram\n  A->>B: hi\n")
        for bad in ({}, {"diagrams": []}, {"diagrams": ["  "]}, {"diagrams": ["A"], "title": 3}):
            self.assertEqual(self.post("/api/pages", bad)[0], 400)


class ProjectFileTest(ServerTest):
    def setUp(self):
        super().setUp()
        root = Path(self.tmp.name)
        (root / "repo" / "docs").mkdir(parents=True)
        self.file = root / "repo" / "docs" / "a.md"
        self.file.write_text("```mermaid\nflowchart TD\n  A --> B\n```\n", "utf-8")
        projects = Projects(root / "data")
        project = projects.register(str(root / "repo"))
        assert project
        self.serve(Store(root / "data"), projects)
        self.url = f"/api/projects/{project.id}/file?path=docs/a.md"

    def test_a_tab_polling_a_file_is_told_only_what_changed_since_its_version(self):
        doc = request(self.port, "GET", self.url).json
        have = f"{self.url}&version={doc['version']}&head={doc['head']}"
        self.assertEqual(request(self.port, "GET", have).json, {"unchanged": True})
        self.file.write_text("```mermaid\nflowchart TD\n  A --> C\n```\n", "utf-8")  # an editor, Claude, a checkout
        changed = request(self.port, "GET", have).json
        self.assertNotEqual(changed["version"], doc["version"])
        self.assertEqual(changed["diagrams"][0]["text"], "flowchart TD\n  A --> C\n")
        self.assertIn("version", request(self.port, "GET", f"{self.url}&version={doc['version']}&head=elsewhere").json)

    # ---- the reports the mod relays (?report=1)

    def test_a_files_report_compares_with_what_claude_last_wrote(self):
        self.post(self.url.replace("/file?", "/seen?"), {"text": "```mermaid\nflowchart TD\n  A --> B\n```\n"})
        self.file.write_text("```mermaid\nflowchart TD\n  A --> PERSON\n```\n", "utf-8")  # the person's edit
        report = request(self.port, "GET", f"{self.url}&report=1").json["report"]
        self.assertIn("-  A --> B\n+  A --> PERSON", report)
        self.assertIn("since an agent last wrote it", report)

    def test_the_reports_name_the_mods_tools_not_the_mcp_servers(self):
        from mcp_tools import MCP_NAMES

        _, made = self.post("/api/pages", {"diagrams": ["flowchart TD\n  A --> B"]})
        reports = [
            request(self.port, "GET", path).json["report"]
            for path in (
                "/api/pages?q=flowchart&report=1",
                f"{self.url.replace('/file?path=docs/a.md', '/files?q=A')}&report=1",
                f"{self.url}&report=1",
                f"/api/pages/{made['id']}?report=1",
            )
        ]
        self.assertIn("mcp__mermaid-view__diagram_edits", reports[0])
        self.assertIn("mcp__mermaid-view__diagram_edits", reports[1])
        for report in reports:
            for name in (MCP_NAMES.page, MCP_NAMES.file, MCP_NAMES.update_file):
                self.assertNotIn(name, report)

    def test_a_reported_source_holding_a_fence_line_comes_back_whole(self):
        from projects import diagrams_of

        original, edited = "flowchart TD\n  A --> B\n```\n", "flowchart TD\n  A --> C\n```\n  ````\n"
        _, made = self.post("/api/pages", {"diagrams": [original]})
        request(self.port, "PUT", f"/api/pages/{made['id']}/0", {"text": edited})
        report = request(self.port, "GET", f"/api/pages/{made['id']}?report=1").json["report"]
        self.assertEqual([d["text"] for d in diagrams_of(report, "markdown")][-1], edited)
        mmd = self.file.with_name("b.mmd")
        mmd.write_text(edited, "utf-8")
        report = request(self.port, "GET", f"{self.url.replace('a.md', 'b.mmd')}&report=1").json["report"]
        self.assertEqual([d["text"] for d in diagrams_of(report, "markdown")], [edited])


if __name__ == "__main__":
    unittest.main()
