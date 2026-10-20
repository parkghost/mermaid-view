# mermaid-view

> **Status: work in progress.** mermaid-view is unfinished and still changing: features may be
> incomplete or rough, and how it works, what it stores and how it is configured may change without
> notice. Try it, but do not rely on it yet.

A Claude Code mod with a browser editor for Mermaid diagrams: the diagrams of Claude's answers, and
those in your project's Markdown documents and `.mmd` files. View them zoomed and themed, edit their
source with a real code editor linked to the drawing, keep their history, and hand your edits back to
Claude.

It comes in two parts:

- **The editor** (`editor/`): a small local server (`127.0.0.1:8771`, Python standard library) and its
  page. It runs on its own, without Claude Code.
- **The Claude Code mod** (`.claude-plugin/`, `hooks/`): starts the editor for a session (it stops when
  that Claude Code ends), turns the ` ```mermaid ` blocks of Claude's answers into pages, opens the
  project documents Claude writes, and hands your edits back to Claude.

## Features

- **View**: zoom, pan, minimap, full screen; Mermaid 12 themes, looks (classic, neo, hand-drawn) and
  layouts (dagre, ELK, tidy tree); Iconify icon packs.
- **Edit** in Monaco: highlighting, rename, go to definition and references, completion and snippets,
  parser errors and lint with quick fixes, format, folding, front matter checked against Mermaid's
  config schema. Every diagram type of Mermaid 12.1.0, plus ZenUML.
- **Linked both ways**: click an element in the drawing to select its source; the caret's line lights
  its elements.
- **Library**: pages by project and session, and a project's files, searched, pinned and tagged.
- **One tab**: a new diagram shows in the tab already open, without pulling you away from work in
  progress; a red dot on its tab icon and an optional system notification show you where it is.
- **History**: every edit kept in git (the data folder's, or the project's own); compare, restore, name
  versions.
- **Export**: `.mmd`, SVG, PNG, Markdown, clipboard, Mermaid Live Editor, a zip of every page.
- **Back to Claude**: send a note, and Claude reads your edits with `diagram_edits`.
- **For other agents**: an MCP server at `/mcp`, and WebMCP tools in the page.

## Install

```
claude plugin marketplace add parkghost/mermaid-view
claude plugin install mermaid-view@parkghost-mermaid-view
```

The first command adds this GitHub repository as a plugin marketplace; the second installs the plugin
from it. `claude plugin marketplace update parkghost-mermaid-view` picks up new releases.

Runs on Linux, WSL and macOS. Needs `python3` 3.9 or newer (standard library only; the one macOS
ships will do), `git` for history (optional), and a way to open the browser: `wslview` (WSL),
`xdg-open` (Linux) or `open` (macOS). Monaco and Mermaid load from cdn.jsdelivr.net. When the editor
cannot start, a toast says why and diagrams open as a static page instead of the editor.

Once installed, a Claude answer with a ` ```mermaid ` block opens in the editor; `/mermaid` shows the
last page again, or before any diagram has been shown, opens the editor on the project's files.

## On its own

```
python3 -I editor/mermaid_view.py --project ~/code/my-project --open
```

| Flag | |
|---|---|
| `--project DIR` | Registers a folder whose documents and `.mmd` files hold diagrams (repeatable; registered projects are remembered) |
| `--open` | Opens the browser on it |
| `--root DATA` | The data folder |
| `--port N` | The port (default 8771) |
| `--exit-with-parent` | Stops once the process that started it ends (what the mod passes); otherwise it runs until stopped |

## Language

The editor's page is in English or Traditional Chinese: the browser's language by default, or the
choice in the header. A note sent to Claude asks in the page's language.

## Options

Set in `/config` (or `pluginConfigs["mermaid-view"].options` in `~/.claude/settings.json`):

| Option | Default | |
|---|---|---|
| `dataDir` | `~/.local/share/mermaid-view` | Pages, edits and their git history. Pages in the former `~/.cache/mermaid-view` move here once. |
| `keepDays` | `90` | Pages neither edited nor pinned are removed after this many days; `0` keeps them all. |
| `openFiles` | `true` | Open a project document or `.mmd` file Claude writes that holds diagrams (once per file per session). |
| `reuseTab` | `true` | Show a new answer's diagrams, or a project file Claude writes, in the editor tab already open instead of a new tab; `false` always opens a new tab. |

## Documentation

- [The editor](docs/editor.md): viewing, editing, linking, library, one tab, history, export, back to
  Claude
- [Diagram types](docs/diagram-types.md): what each type gets (folding, names, linking, lint)
- [Project files](docs/project-files.md): editing a project's diagrams in place, `.mermaid-view.json`
- [MCP and WebMCP](docs/mcp.md): the tools for other agents, protocol and security

## Develop

```
claude plugin test .                                   # the mod's tests
python3 -I -m unittest discover -s editor              # the editor's server and its MCP endpoint
node --test editor/static/*.test.mjs                   # the page's language tools, syntax reference, library and WebMCP tools
claude plugin validate .
uvx ruff@0.17.0 check . && uvx ruff@0.17.0 format --check .   # Python lint and format
npx @biomejs/biome@2.5.15 ci .                                # JS, TS and JSON lint and format
```

Loaded with `claude --plugin-dir .`, saving a file reloads the mod. Contributors and coding agents:
see [AGENTS.md](AGENTS.md).

## Acknowledgements

- [Mermaid](https://github.com/mermaid-js/mermaid) (MIT) draws every diagram. Its repository at 12.1.0 is
  also the source of the config schema (`config-schema.json`), the documentation examples the lint is
  tested on (`docs-examples.json`) and the syntax reference's facts.
- [Mermaid Live Editor](https://github.com/mermaid-js/mermaid-live-editor) (MIT) is the model for much of
  the editor: Monaco as the source editor, the dotted canvas, copying the image, PNG sizes, a docs link
  for each type, icon packs, checking config against Mermaid's schema, and the links that open a
  diagram in it.
- Mermaid's [tidy-tree layout](https://github.com/mermaid-js/mermaid/tree/develop/packages/mermaid-layout-tidy-tree)
  (MIT) lays out mind maps, and [ZenUML](https://github.com/mermaid-js/zenuml-core) (MIT), through
  `@mermaid-js/mermaid-zenuml`, draws `zenuml` diagrams.
- [Monaco Editor](https://github.com/microsoft/monaco-editor) (MIT) is the source editor.
- Icons come through [Iconify](https://iconify.design): [SVG Logos](https://github.com/gilbarbara/logos)
  by Gil Barbara (CC0-1.0), [Material Design Icons](https://github.com/Templarian/MaterialDesign) by
  Pictogrammers (Apache-2.0) and [Font Awesome Free](https://github.com/FortAwesome/Font-Awesome) 6 by
  Fonticons (CC BY 4.0).
