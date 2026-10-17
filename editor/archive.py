"""Pages in and out of the data folder: a page as Markdown, every page as a zip and back, and
the one-time move from the folder pages were kept in before the data folder became an option."""

import io
import json
import re
import shutil
import zipfile
from pathlib import Path

from fences import fenced
from store import is_page_id, well_formed

# The files a page folder holds; nothing else is read from an archive.
PAGE_FILE = re.compile(r"^(meta\.json|labels\.json|(original|edited)-\d{1,3}\.mmd)$")
MAX_ARCHIVE = 50_000_000


# A diagram's heading in a page's Markdown, by the language of the page that asks for it.
DIAGRAM_HEADING = {"en": "Diagram {n}", "zh-Hant": "圖 {n}"}


def page_markdown(page: dict, lang: str = "en") -> str:
    """A page as Markdown: its title, where it came from, and each diagram as it stands now; the
    diagrams' headings in lang (English when it is none of DIAGRAM_HEADING's)."""
    heading = DIAGRAM_HEADING.get(lang, DIAGRAM_HEADING["en"])
    title = page.get("title") or page["id"]
    origin = " · ".join(x for x in (page.get("project"), page.get("branch"), page.get("created")) if x)
    parts = [f"# {title}", ""]
    if origin:
        parts += [f"_{origin}_", ""]
    for d in page["diagrams"]:
        source = d["edited"] if d["edited"] is not None else d["original"]
        if len(page["diagrams"]) > 1:
            parts += ["## " + heading.format(n=d["index"] + 1), ""]
        parts += [fenced("mermaid", source), ""]
    return "\n".join(parts)


def export_zip(root: Path) -> bytes:
    """Every page folder, as pages/<id>/<file> entries."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        for folder in sorted((root / "pages").iterdir()):
            if not folder.is_dir() or not is_page_id(folder.name):
                continue
            for file in sorted(folder.iterdir()):
                if PAGE_FILE.match(file.name):
                    z.write(file, f"pages/{folder.name}/{file.name}")
    return buffer.getvalue()


def import_zip(root: Path, data: bytes) -> dict:
    """Adds the archive's pages that are not here yet; a page already here is left as it is
    (skipped), and one whose meta.json the store could not read is not written (malformed).
    Only page files under pages/<id>/ are read, whatever else the archive holds."""
    added, skipped, malformed = [], [], []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        pages: dict[str, list[zipfile.ZipInfo]] = {}
        for info in z.infolist():
            parts = info.filename.split("/")
            if len(parts) == 3 and parts[0] == "pages" and is_page_id(parts[1]) and PAGE_FILE.match(parts[2]):
                pages.setdefault(parts[1], []).append(info)
        for page_id, files in sorted(pages.items()):
            folder = root / "pages" / page_id
            names = {f.filename.split("/")[2] for f in files}
            if folder.exists():
                skipped.append(page_id)
                continue
            try:
                meta = json.loads(z.read(f"pages/{page_id}/meta.json")) if "meta.json" in names else None
            except ValueError:
                meta = None
            if not well_formed(meta):
                malformed.append(page_id)
                continue
            folder.mkdir(parents=True)
            for info in files:
                (folder / info.filename.split("/")[2]).write_bytes(z.read(info))
            added.append(page_id)
    return {"added": added, "skipped": skipped, "malformed": malformed}


def migrate(old_root: Path, root: Path) -> int:
    """Moves the pages of the former folder here, once: only while this folder has none."""
    old_pages = old_root / "pages"
    pages = root / "pages"
    if not old_pages.is_dir() or old_root.resolve() == root.resolve():
        return 0
    if pages.is_dir() and any(pages.iterdir()):
        return 0
    pages.mkdir(parents=True, exist_ok=True)
    moved = 0
    for folder in old_pages.iterdir():
        if folder.is_dir() and is_page_id(folder.name):
            shutil.move(str(folder), str(pages / folder.name))
            moved += 1
    (old_root / "MOVED.txt").write_text(f"mermaid-view keeps its pages in {root} now.\n", "utf-8")
    return moved
