"""The syntax reference of each diagram type for Mermaid 12.1.0, the version the editor renders
with. Its one source is static/syntax-reference.json, which the page's WebMCP tools read too
(syntax-reference.js); a type is named by its descriptor id, a header keyword or its name, in
any case.
"""

import json
from pathlib import Path

from fences import fenced

FILE = Path(__file__).resolve().parent / "static" / "syntax-reference.json"


class SyntaxReference:
    def __init__(self, path: Path = FILE):
        data = json.loads(path.read_text("utf-8"))
        self.mermaid: str = data["mermaid"]
        self.common: list[str] = data["common"]
        self.types: list[dict] = data["types"]

    def find(self, key: str) -> dict | None:
        """The type a descriptor id, header keyword or name stands for; None when none."""
        want = key.strip().lower()
        for entry in self.types:
            if want in (entry["id"].lower(), entry["name"].lower(), *(h.lower() for h in entry["headers"])):
                return entry
        return None

    def ids(self) -> list[str]:
        return [t["id"] for t in self.types]

    def unknown(self, key: str) -> str:
        return (
            f'No diagram type "{key}". Valid types (id: header): '
            + ", ".join(f"{t['id']}: {t['headers'][0]}" for t in self.types)
            + "."
        )

    def summaries(self) -> list[dict]:
        return [
            {"id": t["id"], "name": t["name"], "header": t["headers"][0], "purpose": t["purpose"]} for t in self.types
        ]

    def list_report(self) -> str:
        lines = [
            f"Mermaid {self.mermaid} diagram types this editor knows ({len(self.types)}). "
            "Get one's syntax with get_syntax_reference and its id or header keyword."
        ]
        lines += [f"- {t['id']} (`{t['headers'][0]}`): {t['purpose']}" for t in self.types]
        return "\n".join(lines)

    def type_report(self, entry: dict) -> str:
        parts = [
            f"# {entry['name']} (Mermaid {self.mermaid}, id {entry['id']})",
            entry["purpose"],
            "Header: " + " | ".join(f"`{h}`" for h in entry["headers"]) + f" (prefer `{entry['headers'][0]}`)",
        ]
        if entry.get("docs"):
            parts.append(f"Docs: {entry['docs']}")
        for key, title in (
            ("syntax", "Syntax"),
            ("relations", "Arrows and relations"),
            ("blocks", "Blocks"),
            ("notes", "Notes (version differences, common mistakes)"),
            ("houseStyle", "This editor's house style (its lint, not Mermaid's rules)"),
        ):
            if entry.get(key):
                parts.append(f"## {title}\n" + "\n".join(f"- {line}" for line in entry[key]))
        parts.append("## Example\n" + fenced("mermaid", entry["example"]))
        parts.append("## Every type\n" + "\n".join(f"- {line}" for line in self.common))
        return "\n\n".join(parts)
