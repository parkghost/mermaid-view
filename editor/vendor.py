"""The page's libraries (Mermaid and its add-ons, Monaco, the icon sets), kept on this machine.

/vendor/npm/<package>@<version>/<file> is the file of cdn.jsdelivr.net/npm/... the same path names,
kept in the data folder's vendor/: fetched from the CDN the first time it is asked for, served from
the folder after. A release's files never change, so each is fetched once, and the page then works
offline with what it has used. One the CDN cannot be fetched for is sent there instead (a
redirect): the browser may reach what this process cannot (a proxy only it knows).

Only the packages the page loads, each at an exact version, and only files of the kinds it loads
are fetched: no request makes this server fetch anything else.
"""

from __future__ import annotations

import os
import re
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple

CDN = "https://cdn.jsdelivr.net/"
# The packages the page loads (app.js, monaco-source.js, icons.js), each at an exact version.
PACKAGE = re.compile(
    r"^npm/(mermaid|@mermaid-js/(layout-tidy-tree|mermaid-zenuml)|monaco-editor|@iconify-json/[a-z0-9-]+)"
    r"@\d+\.\d+\.\d+/"
)
PART = re.compile(r"^[A-Za-z0-9@._-]+$")
TYPES = {
    ".mjs": "text/javascript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
}
MAX_FILE = 32_000_000  # Monaco's and ZenUML's largest are a few MB
TIMEOUT = 5  # a wait for the CDN's next bytes, not for the whole file
# After the CDN could not be reached, how long the browser is sent there without trying again:
# a page asks for dozens of files at once, and each would wait out the timeout.
RETRY_SECS = 60.0


class Served(NamedTuple):
    """What a /vendor/ request is answered with: 200 the file (body, kind), 302 the CDN's URL
    (location), 404 no such file, 400 not a file the page loads."""

    status: int
    body: bytes = b""
    kind: str = ""
    location: str = ""


def fetch_cdn(url: str) -> tuple[int, bytes]:
    """The CDN's status and body for url (a body longer than MAX_FILE is cut, and so refused);
    raises OSError when it cannot be reached."""
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as res:
            return res.status, res.read(MAX_FILE + 1)
    except urllib.error.HTTPError as err:
        return err.code, b""


def allowed(path: str) -> bool:
    """Whether path (after /vendor/) names a file the page loads: one of its packages at an exact
    version, plain names only (no .. or encoded characters), of a kind it loads."""
    parts = path.split("/")
    return (
        bool(PACKAGE.match(path))
        and all(PART.match(p) and p not in (".", "..") for p in parts)
        and Path(parts[-1]).suffix in TYPES
    )


class Vendor:
    def __init__(self, root: Path, fetch: Callable[[str], tuple[int, bytes]] = fetch_cdn):
        self.root = root
        self.fetch = fetch
        self.unreachable_until = 0.0  # time.monotonic() before which the CDN is not tried

    def get(self, path: str) -> Served:
        """The file at path (after /vendor/): kept, else fetched and kept, else the CDN's URL."""
        if not allowed(path):
            return Served(400)
        kind = TYPES[Path(path).suffix]
        file = self.root / path
        if file.is_file():
            return Served(200, file.read_bytes(), kind)
        url = CDN + path
        if time.monotonic() < self.unreachable_until:
            return Served(302, location=url)
        try:
            status, body = self.fetch(url)
        except OSError:
            self.unreachable_until = time.monotonic() + RETRY_SECS
            return Served(302, location=url)
        if status == 404:
            return Served(404)
        if status != 200 or len(body) > MAX_FILE:
            return Served(302, location=url)
        self._keep(file, body)
        return Served(200, body, kind)

    def _keep(self, file: Path, body: bytes) -> None:
        """Writes the file whole or not at all: two requests for it may fetch it at once."""
        part = file.with_name(f".{file.name}.{uuid.uuid4().hex}.part")
        try:
            file.parent.mkdir(parents=True, exist_ok=True)
            part.write_bytes(body)
            os.replace(part, file)
        except OSError:
            part.unlink(missing_ok=True)  # a full disk: served this time, fetched again next
