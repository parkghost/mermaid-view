# AGENTS.md

Guidance for coding agents working in this repository. What the project does is in
[README.md](README.md) and [docs/](docs/).

## Commands

```
claude plugin test .                                   # the mod's tests (hooks/*.test.ts)
python3 -I -m unittest discover -s editor              # the editor's server and its MCP endpoint
uv run --python 3.9 --no-project python -I -m unittest discover -s editor   # the same on the oldest Python
node --test editor/static/*.test.mjs                   # the page's modules
claude plugin validate .                               # the plugin manifest
python3 -I editor/mermaid_view.py --project . --open   # run the editor on this repository

uvx ruff@0.17.0 check . && uvx ruff@0.17.0 format .    # Python: lint, then format (ruff.toml)
npx @biomejs/biome@2.5.15 check --write .              # JS, TS and JSON: lint and format (biome.json)
uvx pre-commit install                                 # once per clone: each commit runs both (.pre-commit-config.yaml)
```

Run the tests of every part you touched, and both linters, before calling a change done. The tools
run through `uvx` and `npx` at pinned versions: there is no `pyproject.toml` or `package.json`, and
none should be added for them. A rule turned off in `ruff.toml` or `biome.json` says why; fix a
finding rather than silencing it, unless the rule fights a pattern the code uses on purpose.

`claude --plugin-dir .` loads the mod from the working tree; saving a file reloads it.

## Layout in one breath

- `hooks/register.ts`: the Claude Code mod (TypeScript, run by Claude Code; no build step). Types come
  from `.claude-plugin/types/`, written by Claude Code when it loads the mod (ignored by git).
- `editor/*.py`: the server, Python 3.9+ standard library only. Tests are `editor/test_*.py` (`unittest`).
- `editor/editor.html`, `editor/static/*.js`: the page, plain ES modules served as they are (no
  bundler, no `node_modules`). Monaco, Mermaid and the icon sets come from cdn.jsdelivr.net at
  pinned versions, through `/vendor/` (`editor/vendor.py`), which keeps each file the page loads in
  the data folder: name a new library by `/vendor/npm/...`, and add its package to `PACKAGE` there.
  Tests are `editor/static/*.test.mjs` (`node:test`), on the modules that need no DOM.
- `editor/static/type-*.js`: one module per diagram type, listed in `types.js`; the descriptor's
  fields are documented at the top of `type-core.js`.

## Translation

The page speaks English and Traditional Chinese (`editor/static/i18n.js`): the person's choice in the
header, else the browser's language. A change of language reloads the page, so a module may translate
its constants at import.

- Write every text a person reads in English, wrapped in `t()`: `t('Saved')`, or with values,
  `t('{name}: saved', { name })`. Without params, braces stay as written (snippet bodies).
- Add its translation to `locale-zh-hant.js`, or for a diagram type's snippets and lint messages to
  `locale-zh-hant-types.js`, keyed by the English text. `i18n.test.mjs` fails on a text with no
  translation, or a translation that drops a `{name}` place.
- `editor.html`'s static text is marked with `data-i18n`, `data-i18n-title` or
  `data-i18n-placeholder`, holding the English text.
- Lint messages are translated when the check runs, not at import: what an agent reads (MCP and
  WebMCP checks) is produced in English through `inEnglish()`.
- Not translated: what agents read (MCP tools, WebMCP descriptions), Mermaid's own parser errors and
  schema docs, and the mod's toasts. The request the mod puts in Claude Code's prompt box is in the
  language of the page that sent the note (`lang` on the note, `promptFor`).

## Adding a diagram type

A type is one module, `editor/static/type-<name>.js`, exporting a descriptor, and one line in `TYPES`
in `types.js`; nothing else in the code changes. Also add its entry to `syntax-reference.json` (a test
holds the reference to the registered types), its texts' translations to
`locale-zh-hant-types.js`, and its row to `docs/diagram-types.md`, and check its
link to the drawing in every look (see Testing).

## Rules

- **Language**: code, comments, docs and commit messages in English.
- **Text people read** (see Translation below): written in English in the code, through `t()`, with
  its Traditional Chinese in the catalog. Do not quote the Chinese in the docs.
- **Python**: standard library only, no third-party packages. Run with `python3 -I`. Python 3.9 or
  newer: 3.9 is the `python3` macOS ships. `ruff.toml` targets it and puts
  `from __future__ import annotations` in each module; nothing newer than 3.9 (`zip(strict=)`,
  `match`, `write_text(newline=)`) is used.
- **No build step**: the page's modules are served as written; do not add a bundler, transpiler or
  `package.json` dependencies.
- **Mermaid version**: everything targets Mermaid 12.1.0: the page (`editor/static/app.js`), the
  mod's static fallback page used without `python3` (`MERMAID` in `hooks/register.ts`), and
  `config-schema.json`, `docs-examples.json` and `syntax-reference.json`, taken from that release.
  Upgrade them together, never one alone.
- **Security**: the server listens on 127.0.0.1 only and checks `Host` and `Origin`; project paths stay
  inside the project. Keep those checks on any new endpoint.
- **Style**: whatever `ruff format` and Biome produce (120 columns; JS with single quotes and no
  semicolons). Do not hand-format against them.
- **Comments**: each file opens with a comment saying what it is and how it fits; functions carry a
  short doc comment on what they return or do. Match that density.
- **Docs**: a change visible to users updates README.md or the page in `docs/` it belongs to; a new
  diagram type adds its row to `docs/diagram-types.md` and its entry to `syntax-reference.json`.

## Testing

A test earns its place by catching a bug: test behaviour through a module's public interface, not the
current shape of the code. Do not write count constants, whole-set snapshots where only part matters,
or tests of private internals. When a test fails, decide whether the behaviour changed on purpose, the
code is wrong, or the test was a change-detector, and say which before changing it.

Anything that reads the rendered SVG (linking, lighting, export) must be checked in all three looks
(classic, neo, hand-drawn) and across diagram types, not one flowchart: Mermaid classes elements
differently per look. See `tasks/lessons.md`, and add to it when a mistake teaches a rule.
