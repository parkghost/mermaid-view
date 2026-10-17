"""python3 -I -m unittest discover -s editor  (from the repository root)"""

import queue
import re
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from projects import Projects  # noqa: E402
from reference import FILE, SyntaxReference  # noqa: E402
from store import Store  # noqa: E402
from test_server import Page, ServerTest, post, request  # noqa: E402
from test_store import A1, Z9, make_page  # noqa: E402

MODERN = "2026-07-28"
DOC = "# 架構\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\n文字。\n"


def fake_report(source: str, expected: str) -> dict:
    """What a page's check (check.js) reports: a source with BROKEN in it does not parse."""
    errors = (
        [{"line": 2, "severity": "error", "rule": "parse", "message": "Parse error on line 2"}]
        if "BROKEN" in source
        else []
    )
    warnings = (
        [{"line": 1, "severity": "warning", "rule": "type-mismatch", "message": "not it"}]
        if expected not in ("", "flowchart")
        else []
    )
    return {
        "checked": True,
        "ok": not errors,
        "type": "flowchart",
        "typeName": "Flowchart",
        "checker": "Mermaid 12.1.0 parser (fake)",
        "errors": errors,
        "warnings": warnings,
    }


class CheckingPage:
    """A page open in the browser that answers the checks it is handed (as app.js does), and
    keeps every other event; answer=False: it receives them and never answers."""

    def __init__(self, port: int, viewer_id: str, answer: bool = True):
        self.port, self.viewer_id, self.answer = port, viewer_id, answer
        self.page = Page(port, viewer_id)
        self.checks: queue.Queue[dict] = queue.Queue()
        self.events: queue.Queue[tuple[str, dict]] = queue.Queue()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while True:
            event, data = self.page.events.get()
            if event != "check":
                self.events.put((event, data))
                continue
            self.checks.put(data)
            if self.answer:
                reports = [fake_report(s, data["type"]) for s in data["sources"]]
                post(self.port, f"/api/checks/{data['id']}", {"viewer": self.viewer_id, "reports": reports})

    def close(self):
        self.page.close()


class McpTest(ServerTest):
    def setUp(self):
        super().setUp()
        root = Path(self.tmp.name)
        data, self.project_root = root / "data", root / "gateway"
        (self.project_root / "docs").mkdir(parents=True)
        (self.project_root / "docs" / "a.md").write_text(DOC, "utf-8")
        make_page(
            data,
            A1,
            ['flowchart TD\n  Wake["喚醒詞"] --> Session\n', "sequenceDiagram\n  A->>B: hi\n"],
            title="裝置流程",
            project="agent",
        )
        projects = Projects(data)
        self.project = projects.register(str(self.project_root))
        self.store = Store(data)
        self.serve(self.store, projects)
        checks = self.server.RequestHandlerClass.checks  # a tab that does not answer is given up on soon
        checks.answer_wait, checks.total_wait = 1.0, 2.0

    # ---- a client

    def http(self, method: str, body=None, headers: dict | None = None) -> tuple[int, dict | list | None]:
        reply = request(
            self.port, method, "/mcp", body, {"Accept": "application/json, text/event-stream", **(headers or {})}
        )
        return reply.status, reply.json

    def legacy(self, method: str, params: dict | None = None, version: str = "2025-11-25", msg_id=1):
        return self.http(
            "POST",
            {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}},
            {"MCP-Protocol-Version": version},
        )

    def modern(self, method: str, params: dict | None = None, headers: dict | None = None, version: str = MODERN):
        meta = {"io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientCapabilities": {}}
        params = {**(params or {}), "_meta": meta}
        mirrored = {"MCP-Protocol-Version": version, "Mcp-Method": method}
        if method == "tools/call":
            mirrored["Mcp-Name"] = params["name"]
        return self.http(
            "POST", {"jsonrpc": "2.0", "id": 7, "method": method, "params": params}, {**mirrored, **(headers or {})}
        )

    def call(self, name: str, arguments: dict) -> dict:
        status, body = self.modern("tools/call", {"name": name, "arguments": arguments})
        self.assertEqual(status, 200, body)
        return body["result"]

    # ---- the protocol

    def test_initialize_takes_a_legacy_version_it_knows_else_offers_its_newest(self):
        status, body = self.http(
            "POST",
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "t", "version": "1"},
                },
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["result"]["protocolVersion"], "2025-06-18")
        self.assertIs(body["result"]["capabilities"]["tools"]["listChanged"], False)  # it never tells of new tools
        self.assertEqual(body["result"]["serverInfo"]["name"], "mermaid-view")
        _, body = self.http(
            "POST", {"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "2024-01-01"}}
        )
        self.assertEqual(body["result"]["protocolVersion"], "2025-11-25")
        status, body = self.http(
            "POST", {"jsonrpc": "2.0", "method": "notifications/initialized"}, {"MCP-Protocol-Version": "2025-06-18"}
        )
        self.assertEqual((status, body), (202, None))
        self.assertEqual(self.legacy("ping"), (200, {"jsonrpc": "2.0", "id": 1, "result": {}}))

    def test_a_legacy_request_names_a_version_the_server_knows(self):
        status, body = self.legacy("tools/list", version="2099-01-01")
        self.assertEqual((status, body["error"]["code"]), (400, -32022))
        # Without the header: 2025-03-26, which had no such header.
        status, body = self.http("POST", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(status, 200)
        self.assertNotIn("resultType", body["result"])

    def test_modern_requests_are_stateless_and_discover_tells_the_versions(self):
        status, body = self.modern("server/discover")
        self.assertEqual(status, 200)
        result = body["result"]
        self.assertEqual(result["resultType"], "complete")
        self.assertEqual(result["supportedVersions"][0], MODERN)
        self.assertIn("2025-11-25", result["supportedVersions"])
        self.assertEqual(result["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "mermaid-view")
        status, body = self.modern("tools/list")
        self.assertEqual((status, body["result"]["cacheScope"]), (200, "private"))

    def test_modern_errors_carry_their_codes_and_statuses(self):
        status, body = self.modern(
            "server/discover", version="2030-01-01", headers={"MCP-Protocol-Version": "2030-01-01"}
        )
        self.assertEqual((status, body["error"]["code"]), (400, -32022))
        self.assertEqual(body["error"]["data"]["requested"], "2030-01-01")
        status, body = self.modern("tools/list", headers={"Mcp-Method": "tools/call"})
        self.assertEqual((status, body["error"]["code"]), (400, -32020))
        status, body = self.modern(
            "tools/call", {"name": "get_page", "arguments": {}}, headers={"Mcp-Name": "search_diagrams"}
        )
        self.assertEqual((status, body["error"]["code"]), (400, -32020))
        # Mcp-Name in its Base64 form is decoded before comparing.
        status, body = self.modern(
            "tools/call", {"name": "get_page", "arguments": {}}, headers={"Mcp-Name": "=?base64?Z2V0X3BhZ2U=?="}
        )
        self.assertEqual(status, 200)
        status, body = self.modern("ping")  # removed in 2026-07-28
        self.assertEqual((status, body["error"]["code"]), (404, -32601))
        status, body = self.http(
            "POST",
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/list",
                "params": {"_meta": {"io.modelcontextprotocol/protocolVersion": MODERN}},
            },
            {"MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/list"},
        )
        self.assertEqual((status, body["error"]["code"]), (400, -32602))  # no clientCapabilities
        status, body = self.legacy("tools/list", version=MODERN)  # the header says modern, the body has no _meta
        self.assertEqual((status, body["error"]["code"]), (400, -32602))

    def test_malformed_messages(self):
        status, body = self.http("POST", b"{not json")
        self.assertEqual((status, body["error"]["code"]), (400, -32700))
        self.assertNotIn("id", body)
        status, body = self.http("POST", {"jsonrpc": "1.0", "id": 1, "method": "ping"})
        self.assertEqual((status, body["error"]["code"]), (400, -32600))
        status, body = self.http("POST", {"jsonrpc": "2.0", "id": None, "method": "ping"})
        self.assertEqual((status, body["error"]["code"]), (400, -32600))
        status, body = self.legacy("tools/call", {"name": "no_such_tool", "arguments": {}})
        self.assertEqual(body["error"]["code"], -32602)
        status, _ = self.http("POST", b"{}", {"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        status, _ = self.http("POST", b"{}", {"Accept": "text/html"})
        self.assertEqual(status, 406)

    def test_batches_only_in_2025_03_26(self):
        batch = [
            {"jsonrpc": "2.0", "id": 1, "method": "ping"},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        ]
        status, body = self.http("POST", batch, {"MCP-Protocol-Version": "2025-03-26"})
        self.assertEqual(status, 200)
        self.assertEqual([r["id"] for r in body], [1, 2])
        status, body = self.http("POST", batch, {"MCP-Protocol-Version": "2025-11-25"})
        self.assertEqual((status, body["error"]["code"]), (400, -32600))
        self.assertEqual(self.http("POST", [], {"MCP-Protocol-Version": "2025-03-26"})[0], 400)

    def test_get_and_delete_are_not_allowed(self):
        self.assertEqual(self.http("GET")[0], 405)
        self.assertEqual(self.http("DELETE", headers={"Mcp-Session-Id": "x"})[0], 405)

    def test_a_page_elsewhere_is_refused(self):
        status, body = self.http(
            "POST", {"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"Origin": "https://attacker.example"}
        )
        self.assertEqual(status, 403)
        self.assertNotIn("id", body)
        self.assertEqual(
            self.http("POST", {"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"Origin": "http://localhost:6274"})[0],
            200,
        )
        self.assertEqual(self.http("POST", {"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"Origin": "null"})[0], 403)

    def test_tools_list_names_every_tool_with_its_schema(self):
        _, body = self.legacy("tools/list")
        tools = {t["name"]: t for t in body["result"]["tools"]}
        used = {
            "get_syntax_reference",
            "check_diagram",
            "search_diagrams",
            "get_page",
            "create_page",
            "update_diagram",
            "get_file_diagrams",
            "update_file_diagram",
        }  # the tools these tests call
        self.assertLessEqual(used, set(tools))
        self.assertTrue(all(t["inputSchema"]["type"] == "object" for t in tools.values()))
        self.assertTrue(tools["get_page"]["annotations"]["readOnlyHint"])
        self.assertTrue(tools["get_syntax_reference"]["annotations"]["readOnlyHint"])
        self.assertTrue(tools["check_diagram"]["annotations"]["readOnlyHint"])
        self.assertIn(SyntaxReference().mermaid, tools["get_syntax_reference"]["description"])
        self.assertIn("get_syntax_reference", tools["update_diagram"]["description"])
        self.assertEqual(tools["create_page"]["inputSchema"]["required"], ["diagrams"])

    # ---- the tools

    def test_search_finds_pages_and_project_files(self):
        result = self.call("search_diagrams", {"query": "Wake"})
        self.assertEqual([p["id"] for p in result["structuredContent"]["pages"]], [A1])
        self.assertIn("diagram 1 line 2", result["content"][0]["text"])
        result = self.call("search_diagrams", {"query": "A --> B"})
        self.assertEqual([f["path"] for f in result["structuredContent"]["files"]], ["docs/a.md"])
        self.assertIn("get_file_diagrams", result["content"][0]["text"])
        self.assertIn(
            'page matches "nothing-here"', self.call("search_diagrams", {"query": "nothing-here"})["content"][0]["text"]
        )

    def test_get_page_gives_each_diagram_with_its_diff(self):
        self.store.save(A1, 1, "sequenceDiagram\n  A->>B: bye\n")
        result = self.call("get_page", {"page": A1})
        page = result["structuredContent"]
        self.assertEqual(page["id"], A1)
        self.assertEqual([d["edited"] for d in page["diagrams"]], [False, True])
        self.assertEqual(page["diagrams"][1]["current"], "sequenceDiagram\n  A->>B: bye\n")
        self.assertIn("+  A->>B: bye", page["diagrams"][1]["diff"])
        self.assertIn("Diagram 2 (index 1), edited", result["content"][0]["text"])
        missing = self.call("get_page", {"page": "nope"})
        self.assertTrue(missing["isError"])

    def test_a_page_report_keeps_each_block_whole_when_a_source_holds_a_fence_line(self):
        from fences import closing_run
        from projects import diagrams_of

        original, edited = "flowchart TD\n  A --> B\n```\n", "flowchart TD\n  A --> C\n```\n  ````\n"
        make_page(self.store.root, Z9, [original, original])
        self.store.save(Z9, 1, edited)
        text = self.call("get_page", {"page": Z9})["content"][0]["text"]
        self.assertEqual([d["text"] for d in diagrams_of(text, "markdown")], [original, edited])
        # The diff's context line " ```" does not end its block: what closes it comes right before "Source now".
        lines = text.split("\n")
        start = lines.index(next(line for line in lines if line.startswith("``") and line.endswith("diff")))
        fence = lines[start].removesuffix("diff")
        end = next(i for i in range(start + 1, len(lines)) if closing_run(lines[i], "`") >= len(fence))
        self.assertEqual(lines[end + 1], "Source now:")

    def test_get_page_without_an_id_points_to_where_an_id_comes_from_rather_than_guessing_a_page(self):
        for args in ({}, {"page": ""}):
            result = self.call("get_page", args)
            self.assertTrue(result["isError"])
            self.assertIn("search_diagrams", result["content"][0]["text"])
            self.assertIn("diagram_edits", result["content"][0]["text"])

    def test_create_page_keeps_the_diagrams_and_shows_them_in_an_open_tab(self):
        tab = self.open_page("v1")
        result = self.call(
            "create_page", {"diagrams": ["flowchart LR\n  X --> Y", "  "], "title": "新圖", "project": "gateway"}
        )
        made = result["structuredContent"]
        self.assertTrue(made["shown"])
        self.assertEqual(
            made["checks"],
            [
                {
                    "checked": False,
                    "reason": "no open editor tab answered in time "
                    f"(open http://localhost:{self.port}/ to enable checking)",
                }
            ],
        )
        self.assertEqual(made["url"], f"http://localhost:{self.port}/d/{made['id']}")
        self.assertEqual(tab.events.get(timeout=5), ("show", {"url": f"/d/{made['id']}"}))
        summary = self.store.summary(made["id"])
        self.assertEqual((summary["title"], summary["count"], summary["kinds"]), ("新圖", 1, ["flowchart"]))
        self.assertEqual((summary["project"], summary["projectRoot"]), ("gateway", str(self.project.root)))
        self.assertTrue(self.call("create_page", {"diagrams": []})["isError"])  # minItems

    def test_update_diagram_saves_and_tells_the_open_tabs(self):
        tab = self.open_page("v1")
        result = self.call("update_diagram", {"page": A1, "index": 0, "source": "flowchart TD\n  Wake --> Router\n"})
        self.assertTrue(result["structuredContent"]["edited"])
        self.assertEqual(self.store.page(A1)["diagrams"][0]["edited"], "flowchart TD\n  Wake --> Router\n")
        self.assertEqual(tab.events.get(timeout=5), ("changed", {"url": f"/d/{A1}"}))
        self.assertTrue(self.call("update_diagram", {"page": A1, "index": 5, "source": "x"})["isError"])
        self.assertTrue(self.call("update_diagram", {"page": "nope", "index": 0, "source": "x"})["isError"])
        self.assertTrue(
            self.call("update_diagram", {"page": A1, "index": "0", "source": "x"})["isError"]
        )  # a string index

    def test_a_page_id_that_leaves_the_pages_folder_reads_and_writes_nothing(self):
        make_page(Path(self.tmp.name), "outside", ["secret\n"])  # shaped like a page, outside the data folder
        outside = Path(self.tmp.name) / "pages" / "outside"
        for page_id in ("../../pages/outside", "../../pages/outside/."):
            read = self.call("get_page", {"page": page_id})
            self.assertTrue(read["isError"])
            self.assertNotIn("secret", read["content"][0]["text"])
            self.assertIn("not a page id", read["content"][0]["text"])
            self.assertTrue(
                self.call("update_diagram", {"page": page_id, "index": 0, "source": "flowchart TD\n  X\n"})["isError"]
            )
        self.assertFalse((outside / "edited-0.mmd").exists())

    def test_a_project_file_reads_and_takes_an_edit_made_on_its_version(self):
        result = self.call("get_file_diagrams", {"project": "gateway", "path": "docs/a.md"})
        doc = result["structuredContent"]
        self.assertEqual([d["line"] for d in doc["diagrams"]], [4])
        self.assertIn(f"version {doc['version']}", result["content"][0]["text"])
        saved = self.call(
            "update_file_diagram",
            {
                "project": self.project.id,
                "path": "docs/a.md",
                "index": 0,
                "source": "flowchart TD\n  A --> C\n",
                "base": doc["version"],
            },
        )
        self.assertFalse(saved["isError"], saved)
        self.assertEqual((self.project_root / "docs" / "a.md").read_text("utf-8"), DOC.replace("A --> B", "A --> C"))
        # What the agent wrote is the base the person's later edits compare with.
        after = self.call("get_file_diagrams", {"project": "gateway", "path": "docs/a.md"})["structuredContent"]
        self.assertEqual(after["diagrams"][0]["seen"], "flowchart TD\n  A --> C\n")

    def test_an_edit_on_an_old_version_is_refused_with_the_file_now(self):
        old = self.call("get_file_diagrams", {"project": "gateway", "path": "docs/a.md"})["structuredContent"][
            "version"
        ]
        (self.project_root / "docs" / "a.md").write_text(DOC.replace("A --> B", "A --> D"), "utf-8")
        result = self.call(
            "update_file_diagram",
            {"project": "gateway", "path": "docs/a.md", "index": 0, "source": "flowchart TD\n  A --> C\n", "base": old},
        )
        self.assertTrue(result["isError"])
        self.assertEqual(result["structuredContent"]["text"], "flowchart TD\n  A --> D\n")
        self.assertNotEqual(result["structuredContent"]["version"], old)
        self.assertIn("A --> D", (self.project_root / "docs" / "a.md").read_text("utf-8"))

    def test_project_files_outside_the_project_or_unknown_are_refused(self):
        self.assertTrue(self.call("get_file_diagrams", {"project": "nope", "path": "docs/a.md"})["isError"])
        self.assertTrue(
            self.call("get_file_diagrams", {"project": "gateway", "path": "../data/projects.json"})["isError"]
        )
        self.assertTrue(
            self.call("update_file_diagram", {"project": "gateway", "path": "docs/a.md", "index": 3, "source": "x"})[
                "isError"
            ]
        )

    # ---- syntax and checks

    def open_tab(self, viewer_id: str, answer: bool = True) -> CheckingPage:
        tab = CheckingPage(self.port, viewer_id, answer)
        self.addCleanup(tab.close)
        return tab

    def test_get_syntax_reference_lists_the_types_without_one(self):
        result = self.call("get_syntax_reference", {})
        listed = result["structuredContent"]
        self.assertEqual(listed["mermaid"], SyntaxReference().mermaid)
        self.assertEqual([t["id"] for t in listed["types"]], SyntaxReference().ids())
        self.assertIn("- flowchart (`flowchart`):", result["content"][0]["text"])

    def test_get_syntax_reference_takes_an_id_a_header_keyword_or_an_alias(self):
        for key, want in (
            ("flowchart", "flowchart"),
            ("graph", "flowchart"),
            ("GRAPH", "flowchart"),
            ("stateDiagram-v2", "state"),
            ("sequenceDiagram", "sequence"),
            ("erDiagram", "er"),
            ("architecture-beta", "architecture"),
            ("railroad-ebnf-beta", "railroadEbnf"),
        ):
            with self.subTest(key=key):
                result = self.call("get_syntax_reference", {"type": key})
                self.assertFalse(result["isError"], result)
                self.assertEqual(result["structuredContent"]["id"], want)
        flow = self.call("get_syntax_reference", {"type": "flowchart"})
        self.assertIn("This editor's house style", flow["content"][0]["text"])
        self.assertIn("```mermaid\n", flow["content"][0]["text"])
        self.assertIn("Docs: https://mermaid.js.org/syntax/flowchart.html", flow["content"][0]["text"])
        self.assertNotIn("houseStyle", self.call("get_syntax_reference", {"type": "sequence"})["structuredContent"])

    def test_get_syntax_reference_of_an_unknown_type_lists_the_valid_ones(self):
        result = self.call("get_syntax_reference", {"type": "plantuml"})
        self.assertTrue(result["isError"])
        self.assertIn('No diagram type "plantuml"', result["content"][0]["text"])
        self.assertIn("sequence: sequenceDiagram", result["content"][0]["text"])
        self.assertIn("flowchart", result["structuredContent"]["types"])

    def test_check_diagram_is_run_by_an_open_tab(self):
        tab = self.open_tab("v1")
        result = self.call("check_diagram", {"source": "flowchart TD\n  A --> B"})
        self.assertFalse(result["isError"], result)
        report = result["structuredContent"]
        self.assertEqual((report["checked"], report["ok"], report["type"]), (True, True, "flowchart"))
        self.assertIn(
            "valid (Flowchart; 0 error(s), 0 warning(s); checked by Mermaid 12.1.0 parser (fake))",
            result["content"][0]["text"],
        )
        asked = tab.checks.get(timeout=5)
        self.assertEqual((asked["sources"], asked["type"]), (["flowchart TD\n  A --> B"], ""))
        self.assertGreaterEqual(len(asked["id"]), 32)  # unguessable

        result = self.call("check_diagram", {"source": "flowchart TD\n  BROKEN", "type": "sequenceDiagram"})
        report = result["structuredContent"]
        self.assertFalse(report["ok"])
        self.assertEqual(tab.checks.get(timeout=5)["type"], "sequence")  # the hint, resolved to its id
        self.assertEqual(report["errors"][0]["line"], 2)
        self.assertIn("NOT valid", result["content"][0]["text"])
        self.assertIn("- line 2 error [parse]: Parse error on line 2", result["content"][0]["text"])
        self.assertTrue(self.call("check_diagram", {"source": "x", "type": "nope"})["isError"])

    def test_check_diagram_with_no_tab_says_it_was_not_checked(self):
        result = self.call("check_diagram", {"source": "flowchart TD\n  A --> B"})
        self.assertTrue(result["isError"])
        self.assertEqual(result["structuredContent"]["checked"], False)
        self.assertIn(
            f"Not checked: no editor tab is open (open http://localhost:{self.port}/ to enable checking)",
            result["content"][0]["text"],
        )

    def test_a_tab_that_does_not_answer_is_given_up_on_and_the_next_one_asked(self):
        mute = self.open_tab("v1", answer=False)
        result = self.call("check_diagram", {"source": "flowchart TD\n  A --> B"})
        self.assertTrue(result["isError"])
        self.assertIn("no open editor tab answered in time", result["content"][0]["text"])
        late = mute.checks.get(timeout=5)
        # Its answer once the check is over is refused: it is not pending any more.
        self.assertEqual(
            post(self.port, f"/api/checks/{late['id']}", {"viewer": "v1", "reports": [fake_report("", "")]})[0], 404
        )
        self.open_tab("v2")  # opened last: asked first
        self.post_viewer("v1")  # v1 used last: asked first, does not answer, v2 does
        result = self.call("check_diagram", {"source": "flowchart TD\n  A --> B"})
        self.assertFalse(result["isError"], result)
        self.assertTrue(result["structuredContent"]["ok"])

    def post_viewer(self, viewer_id: str):
        self.assertEqual(post(self.port, f"/api/viewers/{viewer_id}", {"busy": False, "idle": 0})[0], 200)

    def test_a_check_answer_is_taken_only_for_a_pending_check_of_that_tab(self):
        self.assertEqual(
            post(self.port, "/api/checks/" + "x" * 32, {"viewer": "v1", "reports": []}),
            (404, {"error": "no such check"}),
        )
        self.assertEqual(post(self.port, "/api/checks/bad.id", {"viewer": "v1", "reports": []})[0], 404)
        checks = self.server.RequestHandlerClass.checks
        mute = self.open_tab("v1", answer=False)
        answers = []

        def answer_wrongly():
            data = mute.checks.get(timeout=5)
            report = fake_report("", "")
            answers.append(
                post(self.port, f"/api/checks/{data['id']}", {"viewer": "v2", "reports": [report]})[0]
            )  # not its tab
            answers.append(
                post(self.port, f"/api/checks/{data['id']}", {"viewer": "v1", "reports": []})[0]
            )  # not one per source
            answers.append(
                post(self.port, f"/api/checks/{data['id']}", {"viewer": "v1", "reports": [{"ok": "yes"}]})[0]
            )
            answers.append(
                post(
                    self.port,
                    f"/api/checks/{data['id']}",
                    {"viewer": "v1", "reports": [report]},
                    {"Origin": "https://attacker.example"},
                )[0]
            )
            answers.append(post(self.port, f"/api/checks/{data['id']}", {"viewer": "v1", "reports": [report]})[0])
            answers.append(
                post(self.port, f"/api/checks/{data['id']}", {"viewer": "v1", "reports": [report]})[0]
            )  # once only

        helper = threading.Thread(target=answer_wrongly)
        helper.start()
        self.assertEqual(checks.check(["flowchart TD\n  A --> B"])[0]["ok"], True)
        helper.join()
        self.assertEqual(answers, [404, 404, 404, 403, 200, 404])

    def test_writes_report_their_check(self):
        self.open_tab("v1")
        result = self.call("update_diagram", {"page": A1, "index": 0, "source": "flowchart TD\n  BROKEN\n"})
        self.assertFalse(result["isError"])
        self.assertEqual(
            self.store.page(A1)["diagrams"][0]["edited"], "flowchart TD\n  BROKEN\n"
        )  # written all the same
        self.assertFalse(result["structuredContent"]["check"]["ok"])
        self.assertIn("Check: NOT valid", result["content"][0]["text"])
        made = self.call("create_page", {"diagrams": ["flowchart LR\n  X --> Y", "flowchart LR\n  BROKEN"]})[
            "structuredContent"
        ]
        self.assertEqual([c["ok"] for c in made["checks"]], [True, False])
        saved = self.call(
            "update_file_diagram",
            {"project": "gateway", "path": "docs/a.md", "index": 0, "source": "flowchart TD\n  A --> C\n"},
        )
        self.assertTrue(saved["structuredContent"]["check"]["ok"])
        self.assertIn("Check: valid", saved["content"][0]["text"])

    def test_writes_without_a_tab_are_saved_and_say_they_were_not_checked(self):
        result = self.call("update_diagram", {"page": A1, "index": 0, "source": "flowchart TD\n  A --> B\n"})
        self.assertFalse(result["isError"])
        self.assertFalse(result["structuredContent"]["check"]["checked"])
        self.assertIn("Check: Not checked: no editor tab is open", result["content"][0]["text"])


class SyntaxReferenceTest(unittest.TestCase):
    def test_every_entry_is_complete_and_named_once(self):
        ref = SyntaxReference()
        renders = re.search(r"/mermaid@([\w.-]+)/", (FILE.parent / "app.js").read_text("utf-8"))
        self.assertEqual(ref.mermaid, renders and renders.group(1))  # the version the page renders with
        self.assertEqual(len(set(ref.ids())), len(ref.ids()))
        keys = [k for t in ref.types for k in {k.lower() for k in (t["id"], t["name"], *t["headers"])}]
        self.assertEqual(len(set(keys)), len(keys), "a key names two types")
        for t in ref.types:
            with self.subTest(type=t["id"]):
                for key in ("id", "name", "purpose", "headers", "syntax", "notes", "example"):
                    self.assertTrue(t.get(key), key)
                self.assertTrue(all(isinstance(line, str) and "\n" not in line for line in t["syntax"] + t["notes"]))
                self.assertIn(t["example"].split("\n")[0].split()[0], [h for h in t["headers"]] + ["---", "%%{init:"])


if __name__ == "__main__":
    unittest.main()
