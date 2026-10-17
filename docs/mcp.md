# MCP and WebMCP

The editor offers its diagrams to agents two ways: as an MCP server any client can reach, and as
WebMCP tools the open page registers in a browser that supports them.

## MCP server

The editor serves the [Model Context Protocol](https://modelcontextprotocol.io) at
`http://127.0.0.1:8771/mcp` (Streamable HTTP), so any MCP client can use its diagrams, with or without
the mod. The editor must be running (started by the mod, or [on its own](../README.md#on-its-own)):

```
claude mcp add --transport http mermaid-view http://127.0.0.1:8771/mcp
```

Other clients take the same URL, for instance:

```json
{ "mcpServers": { "mermaid-view": { "type": "http", "url": "http://127.0.0.1:8771/mcp" } } }
```

With the mod in the same Claude Code session, its own `diagram_edits` and `diagram_search` already
cover pages and the session's project; the server's tools are for other clients and sessions.

### Tools

| Tool | |
|---|---|
| `get_syntax_reference` | A diagram type's syntax as Mermaid 12.1.0 takes it: header keywords and variants, statements, arrows, blocks, version differences and common mistakes, an example, its page in Mermaid's docs (`type`: an id or header keyword, e.g. `graph`, `stateDiagram-v2`); without `type`, every type with its header and purpose |
| `check_diagram` | Checks a source without saving it: Mermaid 12.1.0's parser and the editor's lint; valid or not, the detected type, errors and warnings with lines, what checked it (`source`, `type`: the type meant) |
| `search_diagrams` | Pages by title, tags, project and source, and registered projects' files by path and source (`query`, `project`) |
| `get_page` | A page's diagrams as first written and as they are now, with a diff where edited (`page`, required: with the mod, `diagram_edits` reads the session's newest page without an id) |
| `create_page` | New diagrams as a page, shown in the open editor tab when one takes it; returns its id, URL, whether it was shown and each diagram's check (`diagrams`, `title`, `project`) |
| `update_diagram` | Replaces a page's diagram as an edit in the editor would (history kept); a tab showing the page reloads it unless it has unsaved edits; returns the diff and the check (`page`, `index`, `source`) |
| `get_file_diagrams` | A project document's or `.mmd` file's diagrams, what changed since an agent last wrote it (else since the last commit), and the file's version (`project`, `path`) |
| `update_file_diagram` | Replaces one diagram of a project file in place; with `base` (the version read), refused if the file changed since, with the file's version and that diagram now; returns the check (`project`, `path`, `index`, `source`, `base`) |

A diagram's `index` counts from 0. `project` is a registered project's id, root or folder name.

### Checking needs an editor tab open

The server (Python) cannot run Mermaid's parser, so it hands the source to one open tab (the most
recently used, unsaved edits or not: checking changes nothing there), which runs Mermaid 12.1.0's
parser with the page's config and the lint, and posts the report back; the next tab is asked if one
does not answer within a few seconds.

With no tab answering, `check_diagram` is an error saying it was not checked, and a write is saved all
the same with "Not checked" as its check. (Mermaid 12.1.0 cannot run in Node without a DOM: its parsers
for most types sanitize labels with DOMPurify, which needs one, so there is no fallback without a tab.)

The syntax reference is one file, `editor/static/syntax-reference.json`, read by both the server and
the page; a test holds it to the registered types.

### Protocol and security

- Revision `2026-07-28` (stateless: version and capabilities on each request, `server/discover`) and,
  for clients that start with `initialize`, `2025-11-25`, `2025-06-18` and `2025-03-26`.
- Each request is answered with one JSON object (no SSE stream); no session is kept, so there is no
  `Mcp-Session-Id`, and `GET` and `DELETE` are `405`.
- The server listens on 127.0.0.1 only and refuses a request whose `Host` is not the editor's, or whose
  `Origin` is a page that is not on this machine (`403`); a client that sends no `Origin` (not a
  browser) is served.
- There is no authentication: any program on this machine can use the tools, as it can the editor's
  own API.

## WebMCP

In a browser with [WebMCP](https://webmachinelearning.github.io/webmcp/) (`document.modelContext`, or
the earlier `navigator.modelContext`; in Chrome behind `chrome://flags/#enable-webmcp-testing` or an
origin trial), the editor page registers tools that act on it as you would:

| Tool | |
|---|---|
| `get_syntax_reference` | A diagram type's syntax for Mermaid 12.1.0, as the MCP tool gives it (`type`; without it, every type) |
| `check_diagram` | Mermaid's parser and the linter on any source, nothing saved or changed: valid or not, the type, errors and warnings with lines (`source`, `type`) |
| `get_current_document` | The open document: kind, id or path, title, each diagram's source with the parser's errors and the linter's warnings |
| `set_diagram_source` | Replaces a diagram's text in its editor (one undo step, saved as typing is) and returns the findings once redrawn, and the check as `check_diagram` reports it |
| `fix_diagram` | Applies every quick fix, then formats a diagram |
| `open_document` | Opens a page id or an editor URL in the tab |
| `search_library` | Searches the library as its search box does |
| `export_diagram` | A diagram as `mmd` source or `svg` markup |

Without WebMCP the page does nothing more.
