"""The editor as a program: with --exit-with-parent it ends with the process that started it."""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_server import request  # noqa: E402
from test_store import make_page  # noqa: E402

SCRIPT = Path(__file__).resolve().parent / "mermaid_view.py"

# A parent that starts the editor, prints its pid and port, and lives until its stdin closes.
PARENT = """
import subprocess, sys
child = subprocess.Popen([sys.executable, "-I", *sys.argv[1:]], stdout=subprocess.PIPE, text=True)
print(child.pid, child.stdout.readline().split()[1], flush=True)
sys.stdin.read()
"""


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    stat = Path(f"/proc/{pid}/stat")
    return not (stat.exists() and stat.read_text().split(") ")[-1].startswith("Z"))  # a zombie has ended


@unittest.skipIf(os.name == "nt", "a parent's end is seen by the orphan's new parent id")
class ExitWithParentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def start(self, *flags: str) -> tuple[subprocess.Popen, int, int]:
        argv = [str(SCRIPT), "--root", str(self.root), "--port", "0", *flags]
        parent = subprocess.Popen(
            [sys.executable, "-I", "-c", PARENT, *argv], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
        )
        assert parent.stdin and parent.stdout
        pid, port = map(int, parent.stdout.readline().split())
        self.addCleanup(lambda: alive(pid) and os.kill(pid, 9))
        return parent, pid, port

    def end(self, parent: subprocess.Popen) -> None:
        assert parent.stdin and parent.stdout
        parent.stdin.close()
        parent.wait(timeout=10)
        parent.stdout.close()

    def test_it_stops_once_its_parent_ends_and_commits_the_edits_waiting(self):
        parent, pid, port = self.start("--exit-with-parent")
        page = request(port, "POST", "/api/pages", {"diagrams": ["flowchart TD\n  A-->B"], "title": "T"}).json["id"]
        request(port, "PUT", f"/api/pages/{page}/0", {"text": "flowchart TD\n  A-->C\n"})  # commits after a quiet while
        self.end(parent)
        deadline = time.monotonic() + 10
        while alive(pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertFalse(alive(pid))
        status = subprocess.run(["git", "-C", str(self.root), "status", "--porcelain"], capture_output=True, text=True)
        self.assertEqual(status.stdout, "")

    def test_without_the_option_it_runs_on(self):
        parent, pid, _ = self.start()
        self.end(parent)
        time.sleep(2.5)  # past the watch's interval, had there been one
        self.assertTrue(alive(pid))


class StartTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def page(self, page_id: str, meta: str) -> Path:
        """A page whose meta.json reads `meta`, as written."""
        make_page(self.root, page_id, ["flowchart TD\n  A --> B\n"])
        file = self.root / "pages" / page_id / "meta.json"
        file.write_text(meta, "utf-8")
        return file

    def test_a_page_with_a_malformed_meta_is_skipped_and_kept(self):
        good = "2026-10-01T09-00-00-001"
        self.page(good, json.dumps({"count": 1, "title": "good"}))
        bad = {
            "2026-10-02T09-00-00-002": "[]",
            "2026-10-03T09-00-00-003": '{"count": "many"}',
            "2026-10-04T09-00-00-004": '{"count": 1, "tags": 7}',
            "2026-10-05T09-00-00-005": '{"count": 1, "title": 5}',
        }
        files = {page_id: self.page(page_id, meta) for page_id, meta in bad.items()}
        server = subprocess.Popen(
            [sys.executable, "-I", str(SCRIPT), "--root", str(self.root), "--port", "0"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert server.stdout and server.stderr
        self.addCleanup(server.stderr.close)
        self.addCleanup(server.stdout.close)
        self.addCleanup(server.wait)
        self.addCleanup(server.kill)
        line = server.stdout.readline()
        self.assertTrue(line.startswith("PORT "), line or server.stderr.read())
        for query in ("", "?q=flowchart"):
            listed = request(int(line.split()[1]), "GET", f"/api/pages{query}").json["pages"]
            self.assertEqual([p["id"] for p in listed], [good])
        server.kill()
        warnings = server.stderr.read()
        for page_id, meta in bad.items():
            self.assertIn(page_id, warnings)
            self.assertEqual(files[page_id].read_text("utf-8"), meta)  # left for the person to mend


if __name__ == "__main__":
    unittest.main()
