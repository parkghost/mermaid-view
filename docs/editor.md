# The editor

What the editor does, for either kind of document it opens: a page kept from Claude's answers, or a
project's Markdown document or `.mmd` file ([Project files](project-files.md)).

## View

- Zoom (wheel, buttons, fit), pan, a minimap, full screen; the canvas fills the window.
- Mermaid 12 themes (Neo, Redux, …), looks (classic, neo, hand-drawn) and layout engines (dagre, ELK,
  and tidy tree for a mind map). A look or layout applies to the types Mermaid draws with it (each
  option lists them); a diagram of another type is drawn classic with dagre, and its card says so.
- Named icons come from the Iconify sets `logos`, `mdi` and Font Awesome (`fa`, `fas`, `far`, `fab`),
  fetched when a diagram first uses one (`editor/static/icons.js`).

## Edit

The source is edited in Monaco (VS Code's editor):

- Highlighting by diagram type, every place of a name lit.
- Rename (F2), go to definition (F12) and references (Shift+F12).
- Completion and snippets, including a new diagram of any type in an empty source.
- Parser errors and lint warnings, with quick fixes.
- Format (Shift+Alt+F), folding, undo/redo (↶ ↷).
- A link to the type's page in Mermaid's docs.
- Front matter: Mermaid's config options and values are completed and explained on hover. An option
  Mermaid 12.1.0 would ignore (a slip of one letter is fixed to the option), a value it cannot use, or
  a key only the page can set is a warning (`editor/static/frontmatter.js`, on `config-schema.json`:
  Mermaid's own schema plus the options its defaults add).

What each type gets is in [Diagram types](diagram-types.md).

## Linked both ways

A click on a drawn element (a node, edge, message, task, slice…) lights it, and for a node its
connections too (its edges and the nodes at their other ends); with the source open it also selects
its lines. The caret's line lights its elements in the diagram.

## Library

Pages are grouped by project and session, searched by title, tags and source, filtered, pinned,
tagged, renamed and deleted; `[` and `]` step through them. A second tab lists the files of a
registered project that hold diagrams, by folder, searched by path and source.

A page or file opens in the same tab without reloading it (back and forward work; unsaved edits are
saved first).

## One tab

A new answer's diagrams (and `/mermaid`) show in the editor tab already open instead of a new one
(option `reuseTab`). Each open tab holds a live connection to the editor, so it knows which tabs are
open:

- A tab without work in progress is chosen first, then a visible one, then the most recently used; the
  other tabs only add the page to their library.
- A tab you are working in (unsaved edits, a note for Claude not sent yet, or typing in the last 5
  seconds) is not switched away from: it offers to open the new diagram beside the status instead.
- A new tab opens only when no tab is open, or every open tab has been hidden and unused for 30
  minutes (likely forgotten: a diagram sent there would go unseen). Such a tab also closes its live
  connection until you come back to it: the browser keeps only six connections to the editor, and
  every open tab would otherwise hold one.

Finding the tab among many: a browser does not let a page bring its own tab to the front, so the tab
stands out instead until you look at it:

- **A red dot on its tab icon**, which still shows when the tab strip is too crowded for titles; its
  title is also led by a mark.
- **A system notification**, once you turn them on with the header's button for notifications (the page
  never asks on its own). Clicking the notification brings the tab to the front.
- **The browser's tab search** (Ctrl+Shift+A in Chrome and Edge) finds it by its title.

Claude Code's toast says which happened, and reminds you of the dot and the tab search.

## History

The data folder is a git repository (its `vendor/`, the page's libraries kept from the CDN, is left
out). Edits are committed after a few quiet seconds; each diagram's
versions can be compared, restored and named. A project file's history is the project's own git
instead ([Project files](project-files.md)).

To back up or sync the history, add a remote to the data folder:

```
git -C ~/.local/share/mermaid-view remote add origin <url>
```

## Export

- A diagram as `.mmd`, SVG, PNG (as shown, icons and all; 1–4 times its size, or a set width or
  height) or a Markdown block.
- Its image onto the clipboard.
- Opened in the Mermaid Live Editor: the diagram rides in the link's `#` part, which the browser does
  not send to a server.
- A page as `.md`; every page as a zip, which imports on another machine.
- A diagram of an answer into the project: a new `.mmd`, or a block at the end of a document.

## Back to Claude

Sending a note to Claude puts a request into Claude Code's prompt; Claude reads your edits with the
`diagram_edits` tool and finds earlier diagrams with `diagram_search`.

While the prompt box cannot take it (a dialog is open), the tab says it has not arrived yet and it is
tried again. One not taken within 10 minutes, or pushed out by newer ones (20 wait at most), is
dropped; the tab says so and gives the note back.
