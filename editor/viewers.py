"""The editor's pages open in a browser, each a viewer on its event stream (GET /api/events): a
diagram Claude shows next goes to one of them (POST /api/show) instead of a new tab, and a page
changed elsewhere (the MCP tools) is announced to all of them, and a diagram to check (checks.py)
is handed to one of them, busy or not: checking does not navigate.

A viewer reports whether it is busy (edits in progress: it must not be taken over), whether it is
visible, and when it was last used (focused or brought into view). A diagram goes to one viewer:
one that is not busy before one that is, a visible one before a hidden one, the most recently used
first. A busy one is not taken over: it offers the diagram instead of switching to it. A viewer
hidden and unused for STALE is passed over: a tab forgotten in the background would take the
diagram unseen, so a new tab is the better place. The other viewers hear of it only to list it.
An event counts as shown only once it is written to a stream still open; else the next viewer is
tried.
"""

from __future__ import annotations

import json
import queue
import threading
import time
from collections.abc import Callable

KEEPALIVE = 15.0  # seconds between comments on an idle stream (proxies and browsers keep it open)
DELIVERY_WAIT = 2.0  # seconds a viewer's stream has to write an event
STALE = 30 * 60.0  # seconds a hidden viewer may go unused and still take a diagram (arrival.js STALE)


class Delivery:
    """An event on its way to one viewer; `done` is set once it is written (ok) or cannot be."""

    def __init__(self, event: str, data: dict):
        self.frame = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()
        self.done = threading.Event()
        self.ok = False

    def settle(self, ok: bool) -> None:
        self.ok = ok
        self.done.set()


class Viewer:
    def __init__(self, viewer_id: str, now: float):
        self.id = viewer_id
        self.busy = False
        self.visible = True  # until the page says otherwise
        self.used = now  # the person's last use: a page just opened is the most recent
        self.active = self.used  # the order viewers are chosen in: last used, or last given a diagram
        self.outbox: queue.Queue[Delivery] = queue.Queue()


class Viewers:
    def __init__(self):
        self.keepalive = KEEPALIVE
        self.stale = STALE
        self.clock = time.monotonic
        self._lock = threading.Lock()
        self._all: dict[str, Viewer] = {}

    def connect(self, viewer_id: str) -> Viewer:
        """A page's stream opened (or reopened: the new stream replaces the old one)."""
        viewer = Viewer(viewer_id, self.clock())
        with self._lock:
            self._all[viewer_id] = viewer
        return viewer

    def report(self, viewer_id: str, busy: bool, visible: bool | None = None, idle: float | None = None) -> bool:
        """A page's state; visible: whether it is in view now (None: unchanged); idle: seconds since
        the person last used it, as the page counts them (0: it was just focused or brought into
        view; a stream reconnecting is no use: the page says how long it has been unused); None:
        unchanged. False: no such viewer."""
        with self._lock:
            viewer = self._all.get(viewer_id)
            if viewer is None:
                return False
            viewer.busy = busy
            if visible is not None:
                viewer.visible = visible
            if idle is not None:
                viewer.used = viewer.active = self.clock() - idle
            return True

    def serve(self, viewer: Viewer, write: Callable[[bytes], None], alive: Callable[[], bool]) -> None:
        """Runs a viewer's stream until it ends: its deliveries as events, a comment when idle.
        write raises OSError once the page is gone; alive tells whether the page still listens."""
        try:
            while True:
                try:
                    delivery = viewer.outbox.get(timeout=self.keepalive)
                except queue.Empty:
                    write(b": keepalive\n\n")
                    continue
                if not alive():
                    delivery.settle(False)
                    return
                write(delivery.frame)
                delivery.settle(True)
        except OSError:
            pass  # the page closed or went away
        finally:
            with self._lock:
                if self._all.get(viewer.id) is viewer:
                    del self._all[viewer.id]
            while not viewer.outbox.empty():  # what was still on its way cannot arrive
                viewer.outbox.get_nowait().settle(False)

    def broadcast(self, event: str, data: dict) -> None:
        """An event for every open page, not waited for: each page tells whether it concerns it
        (a page changed elsewhere reloads where it is shown)."""
        with self._lock:
            viewers = list(self._all.values())
        for viewer in viewers:
            viewer.outbox.put(Delivery(event, data))

    def recent(self) -> list[Viewer]:
        """The open viewers, the most recently used first."""
        with self._lock:
            return sorted(self._all.values(), key=lambda v: v.active, reverse=True)

    def deliver(self, viewer: Viewer, event: str, data: dict, wait: float = DELIVERY_WAIT) -> bool:
        """An event for one viewer; True once it is written to the viewer's open stream."""
        delivery = Delivery(event, data)
        viewer.outbox.put(delivery)
        return delivery.done.wait(wait) and delivery.ok

    def candidates(self) -> list[Viewer]:
        """The viewers a diagram may go to, the best first; those hidden and unused for `stale` are
        left out."""
        now = self.clock()
        with self._lock:
            fresh = [v for v in self._all.values() if v.visible or now - v.used < self.stale]
        return sorted(fresh, key=lambda v: (not v.busy, v.visible, v.active), reverse=True)

    def show(self, url: str) -> str | None:
        """Shows url in one viewer (candidates()): "switched" when it shows it, "offered" when it
        is busy and offers it instead; None when no viewer took it. The others hear `added`."""
        outcome, chosen = None, None
        for viewer in self.candidates():
            busy = viewer.busy
            if self.deliver(viewer, "show", {"url": url}):
                viewer.active = self.clock()  # it has the new diagram: the one to give the next to
                outcome, chosen = ("offered" if busy else "switched"), viewer
                break
        for viewer in self.recent():
            if viewer is not chosen:
                viewer.outbox.put(Delivery("added", {"url": url}))
        return outcome
