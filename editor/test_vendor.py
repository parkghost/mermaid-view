"""python3 -I -m unittest discover -s editor  (from the repository root)"""

from __future__ import annotations

import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from projects import Projects  # noqa: E402
from server import Handler  # noqa: E402
from store import Store  # noqa: E402
from test_server import ServerTest, request  # noqa: E402
from vendor import Vendor, allowed  # noqa: E402

STATIC = Path(__file__).resolve().parent / "static"
MERMAID = "npm/mermaid@12.1.0/dist/mermaid.esm.min.mjs"


class Cdn:
    """The CDN as a test sees it: the files it has, each request it was asked, and whether it is
    reachable at all."""

    def __init__(self, files: dict[str, bytes]):
        self.files = files
        self.asked: list[str] = []
        self.down = False

    def __call__(self, url: str) -> tuple[int, bytes]:
        self.asked.append(url)
        if self.down:
            raise OSError("unreachable")
        path = url.removeprefix("https://cdn.jsdelivr.net/")
        return (200, self.files[path]) if path in self.files else (404, b"")


class VendorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cdn = Cdn({MERMAID: b"export default {}"})
        self.vendor = Vendor(Path(self.tmp.name), self.cdn)

    def test_a_file_is_fetched_once_then_served_offline(self):
        first = self.vendor.get(MERMAID)
        self.cdn.down = True
        again = Vendor(Path(self.tmp.name), self.cdn).get(MERMAID)  # a later start of the server too
        self.assertEqual([first.status, first.body, again.status, again.body], [200, b"export default {}"] * 2)
        self.assertEqual(len(self.cdn.asked), 1)
        self.assertTrue(again.kind.startswith("text/javascript"))  # else the browser refuses the module

    def test_a_file_the_cdn_cannot_be_reached_for_sends_the_browser_there_and_is_not_kept(self):
        self.cdn.down = True
        served = self.vendor.get(MERMAID)
        self.assertEqual((served.status, served.location), (302, f"https://cdn.jsdelivr.net/{MERMAID}"))
        other = "npm/mermaid@12.1.0/dist/other.mjs"
        self.assertEqual(self.vendor.get(other).status, 302)  # the next files are not tried again
        self.assertEqual(len(self.cdn.asked), 1)
        self.cdn.down = False
        self.vendor.unreachable_until = 0  # a while later
        self.assertEqual(self.vendor.get(MERMAID).status, 200)  # asked again once it is back

    def test_a_file_the_cdn_has_not_is_not_found_and_not_kept(self):
        missing = "npm/mermaid@12.1.0/dist/none.mjs"
        self.assertEqual(self.vendor.get(missing).status, 404)
        self.assertFalse(any(Path(self.tmp.name).rglob("none.mjs")))

    def test_nothing_but_the_pages_libraries_is_fetched(self):
        for path in (
            "npm/mermaid@12.1.0/../../../etc/passwd.js",  # out of the package
            "npm/mermaid@12.1.0/dist/%2e%2e/x.mjs",  # the same, encoded
            "npm/left-pad@1.3.0/index.js",  # a package the page does not load
            "npm/mermaid@12/dist/mermaid.esm.min.mjs",  # a range, whose files change
            "npm/mermaid@latest/dist/mermaid.esm.min.mjs",
            "npm/mermaid@12.1.0/dist/run.sh",  # a kind of file the page does not load
            "gh/someone/repo@1.0.0/x.js",  # another of the CDN's sources
        ):
            self.assertEqual(self.vendor.get(path).status, 400, path)
        self.assertEqual(self.cdn.asked, [])

    def test_every_library_the_page_loads_comes_through_the_editor(self):
        sources = "\n".join(f.read_text("utf-8") for f in STATIC.glob("*.js"))
        self.assertNotIn("https://cdn.jsdelivr.net/", sources)  # one loaded around it breaks offline
        paths = re.findall(r"['`]/vendor/(npm/[^'`$]+)['`]", sources)
        self.assertTrue(paths)
        for path in paths:
            if path == "npm/@iconify-json":
                continue  # the icon sets' folder: each set is checked below
            # Monaco's is its folder: the loader in it stands for the files it loads.
            self.assertTrue(allowed(path if Path(path).suffix else f"{path}/vs/loader.js"), path)
        icons = (STATIC / "icons.js").read_text("utf-8")
        for icon_set in re.findall(r"'([a-z0-9-]+@\d+\.\d+\.\d+)'", icons):
            self.assertTrue(allowed(f"npm/@iconify-json/{icon_set}/icons.json"), icon_set)


class VendorRouteTest(ServerTest):
    def setUp(self):
        super().setUp()
        root = Path(self.tmp.name)
        self.serve(Store(root), Projects(root))
        self.cdn = Cdn({MERMAID: b"export default {}"})
        Handler.vendor.fetch = self.cdn  # the server's, made by make_server

    def test_the_page_gets_a_library_to_keep_for_good(self):
        reply = request(self.port, "GET", f"/vendor/{MERMAID}")
        self.assertEqual((reply.status, reply.raw), (200, b"export default {}"))
        self.assertTrue(reply.headers["Content-Type"].startswith("text/javascript"))
        self.assertIn("immutable", reply.headers["Cache-Control"])

    def test_the_browser_is_sent_to_the_cdn_when_the_editor_cannot_reach_it(self):
        self.cdn.down = True
        reply = request(self.port, "GET", f"/vendor/{MERMAID}")
        self.assertEqual((reply.status, reply.headers["Location"]), (302, f"https://cdn.jsdelivr.net/{MERMAID}"))

    def test_another_site_cannot_make_the_editor_fetch(self):
        reply = request(self.port, "GET", f"/vendor/{MERMAID}", headers={"Host": "evil.example"})
        self.assertEqual(reply.status, 403)
        self.assertEqual(self.cdn.asked, [])


if __name__ == "__main__":
    unittest.main()
