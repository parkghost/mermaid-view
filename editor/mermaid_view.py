"""mermaid-view: a browser editor for Mermaid diagrams. It works without Claude Code: the Claude
Code mod (hooks/) starts it for a session, and it also runs on its own for a project's files.

    python3 -I editor/mermaid_view.py [--project DIR ...] [--open] [--root DATA] [--port N]

--project registers a folder whose Markdown documents and .mmd files hold diagrams (repeatable);
--open opens the browser on the first one. --exit-with-parent stops it once the process that
started it ends (the mod starts it so; run on its own, it runs until stopped). Prints "PORT <n>"
once listening. Standard library only.
"""

import argparse
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

# Run as `python3 -I`, which leaves the script's folder off the import path: its modules are ours.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from archive import migrate  # noqa: E402
from history import History  # noqa: E402
from projects import Projects  # noqa: E402
from server import make_server  # noqa: E402
from store import Store  # noqa: E402

DEFAULT_ROOT = "~/.local/share/mermaid-view"
DEFAULT_PORT = 8771


def open_browser(url: str) -> None:
    for opener in ("wslview", "xdg-open", "open"):
        if shutil.which(opener):
            subprocess.Popen([opener, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
    print(f"Open {url}", flush=True)


def stop_with_parent(server, parent: int, every: float = 1.0) -> None:
    """Shuts the server down once the process that started it (`parent`, its id at start) ends:
    an orphan is adopted by another process, so its parent's id changes."""

    def watch() -> None:
        while os.getppid() == parent:
            time.sleep(every)
        server.shutdown()

    threading.Thread(target=watch, daemon=True).start()


def main() -> None:
    parent = os.getppid()  # before the start's slower steps: a parent gone by then is still seen
    ap = argparse.ArgumentParser(description="mermaid-view: a browser editor for Mermaid diagrams.")
    ap.add_argument("--root", default=DEFAULT_ROOT, help=f"the data folder (default {DEFAULT_ROOT})")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument(
        "--keep-days", type=float, default=90, help="remove unedited, unpinned pages older than this; 0 keeps all"
    )
    ap.add_argument("--migrate-from", help="a former data folder whose pages move here once")
    ap.add_argument("--project", action="append", default=[], help="a project folder to register (repeatable)")
    ap.add_argument("--open", action="store_true", help="open the browser on the first project")
    ap.add_argument("--exit-with-parent", action="store_true", help="stop once the process that started this one ends")
    args = ap.parse_args()
    root = Path(args.root).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    if args.migrate_from:
        migrate(Path(args.migrate_from).expanduser(), root)
    history = History(root)
    store = Store(root, history)
    for page_id in store.unreadable():  # skipped, not removed: the person may mend it
        print(f"warning: page {page_id} skipped: its meta.json cannot be read", file=sys.stderr)
    store.cleanup(args.keep_days)
    projects = Projects(root)
    registered = []
    for folder in args.project:
        project = projects.register(folder)
        if project:
            registered.append(project)
        else:
            print(f"not a project folder: {folder}", file=sys.stderr)
    server = make_server(store, projects, args.port)
    port = server.server_address[1]
    print(f"PORT {port}", flush=True)
    if args.open:
        open_browser(f"http://127.0.0.1:{port}/" + (f"f/{registered[0].id}" if registered else "d"))
    if args.exit_with_parent:
        stop_with_parent(server, parent)
    # Stopped as processes are (SIGTERM), it still ends below: the waiting edits are committed.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        history.flush()  # the edits still waiting for a quiet moment


if __name__ == "__main__":
    sys.exit(main())
