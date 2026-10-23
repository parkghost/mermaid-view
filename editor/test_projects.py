"""python3 -I -m unittest discover -s editor  (from the repository root)"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from projects import Conflict, Project, Projects, blocks, diagrams_of, replace_diagram  # noqa: E402

DOC = """# 架構

說明文字。

```mermaid
flowchart TD
  A --> B
```

中間的段落。

~~~~ mermaid
sequenceDiagram
  A->>B: hi
~~~~

```python
print("not a diagram")
```
"""


def git(root: Path, *args: str) -> None:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@t",
    }
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, env=env)


class MarkdownTest(unittest.TestCase):
    def test_blocks_are_the_mermaid_fences_only(self):
        diagrams = diagrams_of(DOC, "markdown")
        self.assertEqual([d["text"] for d in diagrams], ["flowchart TD\n  A --> B\n", "sequenceDiagram\n  A->>B: hi\n"])
        self.assertEqual([d["line"] for d in diagrams], [6, 13])

    def test_an_unclosed_block_is_not_a_diagram(self):
        self.assertEqual(blocks("```mermaid\nflowchart TD\n".split("\n")), [])

    def test_replacing_a_diagram_leaves_the_rest_as_it_was(self):
        new = replace_diagram(DOC, "markdown", 1, "sequenceDiagram\n  A->>B: bye\n")
        self.assertEqual(new, DOC.replace("A->>B: hi", "A->>B: bye"))
        self.assertIsNone(replace_diagram(DOC, "markdown", 2, "x"))

    def test_windows_line_ends_stay(self):
        crlf = DOC.replace("\n", "\r\n")
        new = replace_diagram(crlf, "markdown", 0, "flowchart LR\n  A --> C\n")
        self.assertEqual(new, crlf.replace("flowchart TD\r\n  A --> B", "flowchart LR\r\n  A --> C"))

    def test_a_block_in_a_list_item_reads_without_its_indentation_and_keeps_it_when_saved(self):
        doc = "1. The request path:\n\n   ```mermaid\n   flowchart LR\n       A --> B\n   ```\n2. The reply.\n"
        self.assertEqual(diagrams_of(doc, "markdown")[0]["text"], "flowchart LR\n    A --> B\n")
        new = replace_diagram(doc, "markdown", 0, "flowchart LR\n    A --> C\n")
        self.assertEqual(new, doc.replace("A --> B", "A --> C"))

    def test_a_diagram_with_a_line_like_its_fence_reads_back_the_same(self):
        # A line of the fence's character, as long as the fence or longer, would end the block there.
        for index, source in (
            (0, 'flowchart TD\n  A["\n```\n"] --> B\n'),
            (0, "flowchart TD\n   `````  \n"),
            (1, "sequenceDiagram\n  A->>B: hi\n~~~~~~\n"),
        ):
            new = replace_diagram(DOC, "markdown", index, source)
            diagrams = diagrams_of(new, "markdown")
            self.assertEqual(diagrams[index]["text"], source)
            self.assertEqual(len(diagrams), 2)  # the other block is still one, and nothing became one
            self.assertTrue(new.endswith('```python\nprint("not a diagram")\n```\n'))
            self.assertIn("\n中間的段落。\n", new)

    def test_a_diagram_with_a_line_like_its_fence_in_a_list_item_reads_back_the_same(self):
        doc = "1. The request path:\n\n   ```mermaid\n   flowchart LR\n       A --> B\n   ```\n2. The reply.\n"
        source = 'flowchart LR\n  A["\n```\n"]\n'
        new = replace_diagram(doc, "markdown", 0, source)
        self.assertEqual(diagrams_of(new, "markdown")[0]["text"], source)
        self.assertTrue(new.endswith("\n2. The reply.\n"))

    def test_a_diagram_file_is_one_diagram(self):
        self.assertEqual(diagrams_of("flowchart TD\n  A\n", "diagram")[0]["text"], "flowchart TD\n  A\n")
        self.assertEqual(replace_diagram("old\n", "diagram", 0, "new"), "new\n")


class ProjectTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name) / "data"
        self.root = Path(self.tmp.name) / "repo"
        (self.root / "docs" / "diagrams").mkdir(parents=True)
        (self.root / "node_modules" / "x").mkdir(parents=True)
        (self.root / "docs" / "arch.md").write_text(DOC, "utf-8")
        (self.root / "docs" / "plain.md").write_text("# no diagrams\n", "utf-8")
        (self.root / "docs" / "diagrams" / "flow.mmd").write_text("flowchart LR\n  Router --> LLM\n", "utf-8")
        (self.root / "node_modules" / "x" / "readme.md").write_text("```mermaid\nflowchart TD\n```\n", "utf-8")
        project = Projects(self.data).register(str(self.root))
        assert project
        self.project: Project = project

    def tearDown(self):
        self.tmp.cleanup()

    def test_files_lists_documents_and_diagram_files_with_diagrams(self):
        files = {f["path"]: f for f in self.project.files()}
        self.assertEqual(set(files), {"docs/arch.md", "docs/diagrams/flow.mmd"})  # no plain.md, no node_modules
        self.assertEqual(files["docs/arch.md"]["count"], 2)
        self.assertEqual(files["docs/arch.md"]["kinds"], ["flowchart", "sequenceDiagram"])

    def test_a_diagram_with_front_matter_is_listed_by_the_kind_after_it(self):
        (self.root / "docs" / "diagrams" / "styled.mmd").write_text(
            '---\nconfig:\n  look: neo\n---\npie\n  "a": 1\n', "utf-8"
        )
        files = {f["path"]: f for f in self.project.files()}
        self.assertEqual(files["docs/diagrams/styled.mmd"]["kinds"], ["pie"])

    def test_files_are_searched_by_path_and_source(self):
        found = self.project.files("router")
        self.assertEqual([f["path"] for f in found], ["docs/diagrams/flow.mmd"])
        self.assertEqual(found[0]["matches"][0]["text"], "Router --> LLM")

    def test_a_file_changed_since_the_last_listing_is_listed_as_it_is_now(self):
        self.assertEqual(self.project.files("zebra"), [])
        flow = self.root / "docs" / "diagrams" / "flow.mmd"
        flow.write_text("flowchart LR\n  Zebras --> LLM\n", "utf-8")  # the same size: only its time tells
        later = flow.stat().st_mtime + 10
        os.utime(flow, (later, later))
        self.assertEqual([f["path"] for f in self.project.files("zebra")], ["docs/diagrams/flow.mmd"])
        flow.unlink()
        self.assertNotIn("docs/diagrams/flow.mmd", [f["path"] for f in self.project.files()])

    def test_the_config_names_the_files(self):
        (self.root / ".mermaid-view.json").write_text(
            json.dumps({"include": ["docs/diagrams/**/*.mmd"], "diagramsDir": "design"}), "utf-8"
        )
        self.assertEqual([f["path"] for f in self.project.files()], ["docs/diagrams/flow.mmd"])
        self.assertEqual(self.project.info()["diagramsDir"], "design")

    def test_paths_outside_the_project_are_refused(self):
        outside = Path(self.tmp.name) / "secret.md"
        outside.write_text("```mermaid\nflowchart TD\n```\n", "utf-8")
        (self.root / "link.md").symlink_to(outside)
        for rel in ["../secret.md", "/etc/passwd", "link.md", "docs/../../secret.md", "docs/arch.py", "~/x.md", ""]:
            self.assertIsNone(self.project.resolve(rel), rel)
        self.assertIsNotNone(self.project.resolve("docs/arch.md"))

    def test_save_replaces_one_block_and_checks_the_version(self):
        doc = self.project.read("docs/arch.md")
        assert doc
        saved = self.project.save("docs/arch.md", 0, "flowchart TD\n  A --> C\n", doc["version"])
        assert saved
        self.assertIn("A --> C", (self.root / "docs" / "arch.md").read_text("utf-8"))
        self.assertIn("A->>B: hi", (self.root / "docs" / "arch.md").read_text("utf-8"))
        with self.assertRaises(Conflict):  # made on the version before
            self.project.save("docs/arch.md", 0, "flowchart TD\n", doc["version"])
        self.assertIsNotNone(self.project.save("docs/arch.md", 0, "flowchart TD\n  A --> D\n", saved["version"]))

    def test_add_makes_a_new_diagram_file_never_over_one(self):
        added = self.project.add("docs/diagrams/new.mmd", "flowchart TD\n  X\n")
        self.assertEqual(added, {"path": "docs/diagrams/new.mmd", "index": 0})
        with self.assertRaises(Conflict):
            self.project.add("docs/diagrams/new.mmd", "flowchart TD\n")

    def test_add_appends_a_block_to_a_document(self):
        added = self.project.add("docs/arch.md", 'pie\n  "a": 1\n', heading="比例")
        self.assertEqual(added, {"path": "docs/arch.md", "index": 2})
        doc = self.project.read("docs/arch.md")
        assert doc
        self.assertEqual(doc["diagrams"][2]["text"], 'pie\n  "a": 1\n')
        self.assertIn("## 比例", (self.root / "docs" / "arch.md").read_text("utf-8"))
        self.assertEqual(self.project.add("docs/new.md", "flowchart TD\n")["index"], 0)

    def test_an_added_diagram_with_a_line_like_a_fence_reads_back_the_same(self):
        source = 'flowchart TD\n  A["\n````\n"]\n'
        added = self.project.add("docs/arch.md", source)
        doc = self.project.read("docs/arch.md")
        assert added and doc
        self.assertEqual(doc["diagrams"][added["index"]]["text"], source)
        self.project.add("docs/arch.md", "pie\n")  # a block after it is a block of its own
        doc = self.project.read("docs/arch.md")
        assert doc
        self.assertEqual([d["text"] for d in doc["diagrams"][added["index"] :]], [source, "pie\n"])

    def test_add_keeps_a_documents_windows_line_ends(self):
        crlf = self.root / "docs" / "crlf.md"
        crlf.write_bytes(DOC.replace("\n", "\r\n").encode("utf-8"))
        self.project.add("docs/crlf.md", 'pie\n  "a": 1\n')
        self.assertNotIn(b"\n", crlf.read_bytes().replace(b"\r\n", b""))

    def test_history_and_versions_come_from_the_projects_git(self):
        git(self.root, "init", "-q")
        git(self.root, "add", ".")
        git(self.root, "commit", "-q", "-m", "first")
        doc = self.project.read("docs/arch.md")
        assert doc
        self.assertTrue(doc["tracked"])
        self.assertEqual(doc["diagrams"][0]["head"], "flowchart TD\n  A --> B\n")
        self.project.save("docs/arch.md", 0, "flowchart TD\n  A --> C\n", doc["version"])
        git(self.root, "commit", "-q", "-am", "second")
        commits = self.project.history("docs/arch.md")
        self.assertEqual([c["message"] for c in commits], ["second", "first"])
        self.assertEqual(self.project.diagram_at("docs/arch.md", 0, commits[1]["commit"]), "flowchart TD\n  A --> B\n")
        self.assertIsNone(self.project.diagram_at("docs/arch.md", 0, "not-a-commit"))

    def test_without_git_there_is_no_history(self):
        doc = self.project.read("docs/arch.md")
        assert doc
        self.assertFalse(doc["tracked"])
        self.assertIsNone(doc["diagrams"][0]["head"])
        self.assertEqual(self.project.history("docs/arch.md"), [])


class ProjectsTest(unittest.TestCase):
    def test_registered_projects_last_and_keep_their_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, folder = Path(tmp) / "data", Path(tmp) / "p"
            folder.mkdir()
            first = Projects(data).register(str(folder))
            assert first
            again = Projects(data)
            self.assertEqual([p.id for p in again.all()], [first.id])
            self.assertEqual(again.get(first.id).root, folder.resolve())  # type: ignore[union-attr]
            self.assertIsNone(Projects(data).register(str(Path(tmp) / "missing")))
            self.assertIsNone(Projects(data).register(str(Path.home())))

    def test_a_project_follows_its_git_and_the_registered_roots_while_the_server_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, folder, other = Path(tmp) / "data", Path(tmp) / "p", Path(tmp) / "q"
            folder.mkdir()
            other.mkdir()
            projects = Projects(data)
            project = projects.register(str(folder))
            projects.register(str(other))
            assert project
            self.assertFalse(projects.get(project.id).info()["git"])  # type: ignore[union-attr]
            git(folder, "init", "-q")  # made a repository later: seen as one
            self.assertTrue(projects.get(project.id).info()["git"])  # type: ignore[union-attr]
            (data / "projects.json").write_text(json.dumps({"roots": [str(other.resolve())]}), "utf-8")
            self.assertEqual([p.root for p in projects.all()], [other.resolve()])  # no longer registered: gone


if __name__ == "__main__":
    unittest.main()
