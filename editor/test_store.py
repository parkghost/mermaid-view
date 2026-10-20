"""python3 -I -m unittest discover -s editor  (from the repository root)"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from store import MAX_NOTE, NOTE_TTL, Store  # noqa: E402

# Page ids as the store names them (the time in UTC), the later the newer.
OLD, OLD_PINNED, OLD_EDITED = "2026-01-01T09-00-00-001", "2026-01-01T09-00-00-002", "2026-01-01T09-00-00-003"
A1, B2, Z9 = "2026-10-01T09-00-00-001", "2026-10-02T09-00-00-002", "2026-10-09T09-00-00-009"


def make_page(root: Path, page_id: str, sources: list[str], **meta) -> None:
    folder = root / "pages" / page_id
    folder.mkdir(parents=True)
    for i, s in enumerate(sources):
        (folder / f"original-{i}.mmd").write_text(s, "utf-8")
    (folder / "meta.json").write_text(json.dumps({"count": len(sources), "created": page_id, **meta}), "utf-8")


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        make_page(
            self.root,
            A1,
            ['flowchart TD\n  Wake["喚醒詞"] --> Session\n'],
            title="裝置流程",
            project="agent",
            session="s1",
        )
        make_page(self.root, B2, ["sequenceDiagram\n  A->>B: hi\n"], title="握手", project="gateway", session="s2")
        self.store = Store(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_an_edit_saves_with_its_diff_and_a_return_to_the_original_drops_it(self):
        saved = self.store.save(A1, 0, 'flowchart TD\n  Wake["喚醒詞"] --> Router\n')
        self.assertIn("+  Wake", saved["diff"])
        self.assertTrue(self.store.summary(A1)["edited"])
        self.assertEqual(self.store.page(A1)["diagrams"][0]["edited"], 'flowchart TD\n  Wake["喚醒詞"] --> Router\n')
        back = self.store.save(A1, 0, 'flowchart TD\n  Wake["喚醒詞"] --> Session\n')
        self.assertEqual(back, {"edited": None, "diff": ""})
        self.assertFalse(self.store.summary(A1)["edited"])
        self.assertIsNone(self.store.save(A1, 5, "x"))  # no such diagram

    def test_pages_list_newest_first_and_filter_by_project(self):
        self.assertEqual([p["id"] for p in self.store.summaries()], [B2, A1])
        self.assertEqual([p["id"] for p in self.store.summaries("agent")], [A1])

    def test_search_needs_every_word_and_shows_matching_lines(self):
        found = self.store.search("喚醒 session")
        self.assertEqual([p["id"] for p in found], [A1])
        self.assertEqual(found[0]["matches"][0]["line"], 2)
        self.assertEqual(self.store.search("喚醒 握手"), [])

    def test_title_pin_and_tags_update(self):
        updated = self.store.update(A1, {"title": " 新標題 ", "pinned": True, "tags": ["架構", " x ", ""]})
        self.assertEqual((updated["title"], updated["pinned"], updated["tags"]), ("新標題", True, ["x", "架構"]))
        self.assertEqual([p["id"] for p in self.store.search("架構")], [A1])

    def test_only_an_id_the_store_gives_names_a_page(self):
        make_page(self.root, "../outside", ["secret\n"])  # shaped like a page, beside the pages folder
        for page_id in ("../outside", "x", f"{A1}/.", f"{A1}\n", ""):
            self.assertIsNone(self.store.page(page_id))
            self.assertIsNone(self.store.save(page_id, 0, "flowchart TD\n  X\n"))
            self.assertIsNone(self.store.update(page_id, {"title": "t"}))
            self.assertFalse(self.store.delete(page_id))
        self.assertTrue((self.root / "outside" / "meta.json").exists())
        self.assertFalse((self.root / "outside" / "edited-0.mmd").exists())

    def test_delete_removes_the_page(self):
        self.assertTrue(self.store.delete(B2))
        self.assertFalse(self.store.delete(B2))
        self.assertEqual([p["id"] for p in self.store.summaries()], [A1])

    def test_cleanup_keeps_edited_pinned_and_recent_pages(self):
        make_page(self.root, OLD, ["flowchart TD\n  X --> Y\n"])
        make_page(self.root, OLD_PINNED, ["flowchart TD\n  X --> Y\n"], pinned=True)
        make_page(self.root, OLD_EDITED, ["flowchart TD\n  X --> Y\n"])
        self.store.save(OLD_EDITED, 0, "flowchart TD\n  X --> Z\n")
        long_ago = time.time() - 200 * 86400
        for page_id in (OLD, OLD_PINNED, OLD_EDITED):
            os.utime(self.root / "pages" / page_id / "meta.json", (long_ago, long_ago))
        self.assertEqual(self.store.cleanup(90), 1)
        self.assertEqual(sorted(self.store.page_ids()), sorted([A1, B2, OLD_EDITED, OLD_PINNED]))
        self.assertEqual(self.store.cleanup(0), 0)  # 0 keeps everything

    def deliver(self) -> str:
        """The mod takes the next note and the prompt box takes it; its text."""
        item = self.store.take()
        self.assertEqual(self.store.ack(item["id"], True), "delivered")
        return item["note"]

    def test_send_leaves_one_note_delivered_once(self):
        note_id = self.store.send(A1, "改成 C")
        self.assertEqual(self.store.take()["id"], note_id)
        self.assertEqual(self.deliver(), "改成 C")
        self.assertIsNone(self.store.take())

    def test_notes_wait_in_order_for_the_server_they_were_sent_to(self):
        other_session = Store(self.root)  # another Claude Code session's server on the same data folder
        self.store.send(A1, "first")
        self.store.send(B2, "second")
        self.assertIsNone(other_session.take())
        self.assertEqual([self.deliver(), self.deliver()], ["first", "second"])

    def test_a_note_the_prompt_box_refused_is_taken_again_before_later_ones(self):
        self.store.send(A1, "first")
        self.store.send(B2, "second")
        item = self.store.take()
        self.assertEqual(self.store.ack(item["id"], False), "waiting")  # a dialog is up: not delivered
        self.assertEqual(self.store.take()["note"], "first")
        self.assertIsNone(self.store.ack(item["id"], False))  # still waiting: nothing new to tell
        self.assertEqual([self.deliver(), self.deliver()], ["first", "second"])

    def test_a_note_not_delivered_in_time_is_dropped(self):
        start = time.time()
        self.store.clock = lambda: start
        old = self.store.send(A1, "old")
        self.store.clock = lambda: start + NOTE_TTL - 60
        recent = self.store.send(B2, "recent")
        self.store.clock = lambda: start + NOTE_TTL + 1
        self.assertEqual(self.store.expire(), [old])
        self.assertEqual(self.store.take()["id"], recent)

    def test_a_note_too_old_is_told_dropped_as_soon_as_a_new_one_comes(self):
        told = []
        self.store.on_note = lambda note_id, state: told.append((note_id, state))
        start = time.time()
        self.store.clock = lambda: start
        old = self.store.send(A1, "old")
        self.store.clock = lambda: start + NOTE_TTL + 1
        self.store.send(B2, "new")  # no take() in between: the mod may not be asking
        self.assertEqual(told, [(old, "dropped")])

    def test_a_note_is_kept_as_text_of_bounded_length(self):
        self.store.send(A1, "x" * (MAX_NOTE + 5))
        self.store.leave({"page": B2, "note": {"not": "text"}})
        self.assertEqual([len(self.deliver()), self.deliver()], [MAX_NOTE, ""])


class HistoryTest(unittest.TestCase):
    def setUp(self):
        from history import History

        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        make_page(self.root, A1, ["flowchart TD\n  A --> B\n"], title="流程")
        self.history = History(self.root, quiet_secs=60)  # flushed by hand below
        self.store = Store(self.root, self.history)

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_pages_present_at_start_are_committed(self):
        self.assertEqual(len(self.history.log(A1, 0)), 1)

    def test_edits_in_one_pause_make_one_commit_with_each_version_readable(self):
        self.store.save(A1, 0, "flowchart TD\n  A --> C\n")
        self.store.save(A1, 0, "flowchart TD\n  A --> D\n")
        self.history.flush()
        log = self.history.log(A1, 0)
        self.assertEqual(len(log), 2)
        self.assertEqual(log[0]["message"], "Edit 流程 #1")
        self.assertEqual(self.history.text_at(A1, 0, log[0]["commit"]), "flowchart TD\n  A --> D\n")
        self.assertEqual(self.history.text_at(A1, 0, log[1]["commit"]), "flowchart TD\n  A --> B\n")
        self.assertIsNone(self.history.text_at(A1, 0, "not-a-commit"))

    def test_edits_are_committed_on_their_own_once_the_folder_is_quiet(self):
        from history import History

        history = History(self.root, quiet_secs=0.3)
        store = Store(self.root, history)
        for text in ("flowchart TD\n  A --> C\n", "flowchart TD\n  A --> D\n"):
            store.save(A1, 0, text)
            time.sleep(0.1)  # typing: each edit puts the commit off
        self.assertEqual(len(history.log(A1, 0)), 1)  # not yet
        deadline = time.monotonic() + 5
        while len(history.log(A1, 0)) < 2 and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual([c["message"] for c in history.log(A1, 0)][:1], ["Edit 流程 #1"])
        store.save(A1, 0, "flowchart TD\n  A --> E\n")  # and the next pause commits again
        deadline = time.monotonic() + 5
        while len(history.log(A1, 0)) < 3 and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(history.text_at(A1, 0, history.log(A1, 0)[0]["commit"]), "flowchart TD\n  A --> E\n")

    def test_the_libraries_kept_from_the_cdn_are_never_committed_even_in_an_older_folder(self):
        import subprocess

        from history import History

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".gitignore").write_text("outbox.json\n", "utf-8")  # as an older release left it
            make_page(root, A1, ["flowchart TD\n  A --> B\n"])
            kept = root / "vendor" / "npm" / "mermaid@12.1.0" / "dist" / "mermaid.esm.min.mjs"
            kept.parent.mkdir(parents=True)
            kept.write_text("export default {}", "utf-8")
            History(root, quiet_secs=60).commit_now("After the libraries")
            tracked = subprocess.run(["git", "-C", tmp, "ls-files"], capture_output=True, text=True).stdout
        self.assertIn(f"pages/{A1}/meta.json", tracked)
        self.assertNotIn("vendor/", tracked)

    def test_a_version_takes_a_name(self):
        commit = self.history.log(A1, 0)[0]["commit"]
        self.history.label(A1, commit, "第一版")
        self.assertEqual(self.history.log(A1, 0)[-1]["label"], "第一版")

    def test_a_diagram_with_front_matter_is_of_the_kind_after_it(self):
        page = self.store.create(["---\ntitle: T\nconfig:\n  look: neo\n---\n%% c\nflowchart LR\n  A --> B"])
        self.assertEqual(self.store.summary(page)["kinds"], ["flowchart"])

    def test_a_diagram_after_a_directive_over_several_lines_is_of_the_kind_after_it(self):
        page = self.store.create(['%%{\n  init: { "theme": "dark" }\n}%%\nsequenceDiagram\n  A->>B: hi'])
        self.assertEqual(self.store.summary(page)["kinds"], ["sequenceDiagram"])

    def test_a_lock_left_by_a_killed_git_does_not_stop_the_editor(self):
        from history import History

        (self.root / ".git" / "index.lock").write_text("", "utf-8")
        store = Store(self.root, History(self.root, quiet_secs=60))  # starting again does not raise
        page = store.create(["flowchart TD\n  X --> Y"], "while locked")  # nor does a new page
        self.assertEqual(store.summary(page)["title"], "while locked")
        (self.root / ".git" / "index.lock").unlink()
        self.assertTrue(store.history.commit_now("After the lock"))  # what waited is committed then

    def test_a_created_page_is_written_and_committed(self):
        first = self.store.create(
            ["%% from an agent\nflowchart LR\n  X --> Y", "sequenceDiagram\n  A->>B: hi"],
            "新圖",
            {"project": "gateway", "other": "x"},
        )
        second = self.store.create(['pie\n  "a": 1'])  # within the same millisecond, maybe: an id of its own
        self.assertNotEqual(first, second)
        self.assertRegex(first, r"^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}(-\d+)?$")
        summary = self.store.summary(first)
        self.assertEqual(
            (summary["title"], summary["count"], summary["kinds"], summary["project"]),
            ("新圖", 2, ["flowchart", "sequenceDiagram"], "gateway"),
        )
        self.assertNotIn("other", json.loads((self.root / "pages" / first / "meta.json").read_text("utf-8")))
        self.assertEqual(
            self.store.page(first)["diagrams"][0]["original"], "%% from an agent\nflowchart LR\n  X --> Y\n"
        )
        self.assertEqual(self.history.log(first, 0)[0]["message"], "New page: 新圖")

    def test_commits_keep_to_the_repository_identity(self):
        out = subprocess.run(
            ["git", "-C", str(self.root), "log", "-1", "--format=%an <%ae>"], capture_output=True, text=True, check=True
        ).stdout.strip()
        self.assertEqual(out, "mermaid-view <mermaid-view@localhost>")


class ArchiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        make_page(
            self.root,
            A1,
            ["flowchart TD\n  A --> B\n", "sequenceDiagram\n  A->>B: hi\n"],
            title="兩張圖",
            project="agent",
        )
        self.store = Store(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_page_reads_as_markdown_with_its_current_diagrams(self):
        from archive import page_markdown

        self.store.save(A1, 0, "flowchart TD\n  A --> C\n")
        md = page_markdown(self.store.page(A1))
        self.assertTrue(md.startswith("# 兩張圖\n"))
        self.assertIn("## Diagram 2", md)
        self.assertIn("```mermaid\nflowchart TD\n  A --> C\n```", md)
        # The diagrams' headings follow the language of the page asking; an unknown one reads English.
        self.assertIn("## 圖 2", page_markdown(self.store.page(A1), "zh-Hant"))
        self.assertIn("## Diagram 2", page_markdown(self.store.page(A1), "fr"))

    def test_a_diagram_holding_a_fence_line_reads_back_from_its_markdown_whole(self):
        from archive import page_markdown
        from projects import diagrams_of

        source = 'flowchart TD\n  A["x"] --> B\n```\n  ~~~~\n   ````  \n  B --> C\n'  # a label's lines, as Markdown would take them
        self.store.save(A1, 0, source)
        read = diagrams_of(page_markdown(self.store.page(A1)), "markdown")
        self.assertEqual(read[0]["text"], source)
        self.assertEqual(read[1]["text"], "sequenceDiagram\n  A->>B: hi\n")  # the next block still a block of its own

    def test_an_archive_brings_new_pages_and_leaves_present_ones(self):
        import io
        import zipfile

        from archive import export_zip, import_zip

        data = export_zip(self.root)
        other = tempfile.TemporaryDirectory()
        try:
            target = Path(other.name)
            make_page(target, A1, ["flowchart TD\n  X --> Y\n"])  # already there: kept
            buffer = io.BytesIO(data)
            with zipfile.ZipFile(buffer, "a") as z:
                z.writestr(f"pages/{B2}/meta.json", json.dumps({"count": 1}))
                z.writestr(f"pages/{B2}/original-0.mmd", "flowchart TD\n  P --> Q\n")
                z.writestr(f"pages/{B2}/evil.sh", "rm -rf /")  # not a page file: never written
                z.writestr("../escape/meta.json", "{}")
            result = import_zip(target, buffer.getvalue())
            self.assertEqual((result["added"], result["skipped"]), ([B2], [A1]))
            self.assertFalse((target / "pages" / B2 / "evil.sh").exists())
            self.assertEqual((target / "pages" / A1 / "original-0.mmd").read_text(), "flowchart TD\n  X --> Y\n")
        finally:
            other.cleanup()

    def test_an_archive_page_the_store_could_not_read_is_not_written_and_is_reported(self):
        import io
        import zipfile

        from archive import import_zip

        bad = ["2026-10-03T09-00-00-003", "2026-10-04T09-00-00-004", "2026-10-05T09-00-00-005"]
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as z:
            z.writestr(f"pages/{Z9}/meta.json", json.dumps({"count": 1}))
            z.writestr(f"pages/{Z9}/original-0.mmd", "flowchart TD\n  P --> Q\n")
            for page_id, meta in zip(bad, ({"count": "1"}, {"count": 1, "tags": "x"}, [1])):
                z.writestr(f"pages/{page_id}/meta.json", json.dumps(meta))
                z.writestr(f"pages/{page_id}/original-0.mmd", "flowchart TD\n  A --> B\n")
        target = Path(self.tmp.name) / "other"
        result = import_zip(target, buffer.getvalue())
        for page_id in bad:
            self.assertFalse((target / "pages" / page_id).exists())
        self.assertEqual(result["added"], [Z9])
        self.assertEqual(sorted(result["malformed"]), bad)
        self.assertEqual([p["id"] for p in Store(target).find("")], [Z9])

    def test_former_pages_move_once_into_an_empty_folder(self):
        from archive import migrate

        new = tempfile.TemporaryDirectory()
        try:
            target = Path(new.name) / "data"
            self.assertEqual(migrate(self.root, target), 1)
            self.assertTrue((target / "pages" / A1 / "meta.json").exists())
            self.assertTrue((self.root / "MOVED.txt").exists())
            make_page(self.root, Z9, ["flowchart TD\n  A --> B\n"])
            self.assertEqual(migrate(self.root, target), 0)  # the folder has pages now: no second move
        finally:
            new.cleanup()


if __name__ == "__main__":
    unittest.main()
