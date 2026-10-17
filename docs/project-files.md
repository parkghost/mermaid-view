# Project files

A project's diagrams live in the project: ` ```mermaid ` blocks in Markdown documents, and `.mmd` files
(for instance in a `docs/diagrams/` folder). The editor opens them in place.

## How editing works

- **Edits go into the file**: saving replaces only that block; the rest of the document stays as it
  was. If the file changed on disk meanwhile (Claude, your editor, a checkout), nothing is overwritten:
  the card offers to load the disk's version or keep yours.
- **The page follows the file**: what Claude or another editor writes shows within two seconds.
- **The project's git is the history**: a diagram's versions are the commits that changed its file
  (compare, restore); the badge compares with `HEAD`. The editor never commits: you do, as with any
  edit.
- **Library**: the project files tab lists a project's files that hold diagrams, by folder, searched by
  path and source.

## With Claude

- The session's project is registered by itself.
- When Claude writes a document or `.mmd` file with diagrams, it opens (once per file; option
  `openFiles`).
- `diagram_edits` with a `file` reports what changed since Claude last wrote it, else since the last
  commit.
- A diagram of an answer goes into the project from the export menu (a new `.mmd`, or a block at the
  end of a document).

## Configuration

Which files are looked at, and where new diagram files go, can be set in `.mermaid-view.json` at the
project's root (all optional):

```json
{
  "include": ["docs/**/*.md", "docs/diagrams/**/*.mmd"],
  "exclude": ["docs/archive/**"],
  "diagramsDir": "docs/diagrams"
}
```

By default every `.md`, `.markdown`, `.mdx`, `.mmd` and `.mermaid` file is looked at, outside
`node_modules`, `.git`, build folders and other hidden ones.
