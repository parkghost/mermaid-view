"""Markdown code fences as CommonMark reads them: what closes a block, and a fence long enough that
no line of a source closes its block early (a diagram may hold a line of ``` in a label or a note)."""

from __future__ import annotations

import re
from collections.abc import Sequence


def closing_run(line: str, char: str) -> int:
    """The length of the run of `char` a line is, as CommonMark reads a closing fence: up to three
    spaces, the run, then only spaces or tabs; 0 when the line is not one."""
    m = re.match(rf"^ {{0,3}}({re.escape(char)}+)[ \t]*$", line)
    return len(m.group(1)) if m else 0


def fence_for(lines: Sequence[str], fence: str = "```") -> str:
    """The fence a block of these lines needs: `fence`, or one longer than every line of them
    that would close it, so that the block ends where it should and reads back the same."""
    longest = max((closing_run(line, fence[0]) for line in lines), default=0)
    return fence if longest < len(fence) else fence[0] * (longest + 1)


def fenced(info: str, text: str, nl: str = "\n") -> str:
    """`text` as a fenced block with this info string ("mermaid", "diff"), without its trailing
    newlines; its lines end with nl (a Windows document's line end in one written so)."""
    lines = text.rstrip("\n").split("\n")
    fence = fence_for(lines)
    return nl.join([fence + info, *lines, fence])
