# Diagram types

Every type of Mermaid 12.1.0, and ZenUML (Mermaid's separate plugin, which the editor registers), is
detected from its keyword line (after front matter, `%%{…}%%` directives and comments), highlighted with
its own keywords and arrows, and offers its snippets. Beyond that:

| Type (keyword) | Folding, format | Names: rename, F12, references | Linked to the drawing | Lint (besides balanced blocks) |
|---|---|---|---|---|
| Flowchart (`flowchart`, `graph`) | `subgraph … end`; indent, spaced arrows | node ids, edge ids (`e1@-->`) | nodes, edges, subgraphs | house style: quoted titles, labels and node text, plain ids, ASCII labels, no styling (fixes) |
| Swimlane (`swimlane-beta`) | `subgraph … end`; indent | node ids | nodes, edges, lanes | — |
| Agent flow (`agentflow-beta`) | `flow`/`global … end`; indent | node ids | nodes, edges, flows | — |
| Sequence (`sequenceDiagram`) | `loop`, `alt`/`else`, `par`/`and`, `critical`/`option`, `box` … `end`; indent | participants (aliases, names with spaces) | participants, messages, notes, groups | declared twice, declared after use, text cut by `#` or `;` |
| ZenUML (`zenuml`) | `{ }` bodies and fragments; indent | participants | — | declared twice, `@Starter` above an annotated or aliased declaration (ZenUML then draws next to nothing), sequenceDiagram syntax (`participant`, `->>`, `alt`, `end`…), which ZenUML's parser takes without an error |
| Class (`classDiagram`) | `{ }` bodies, namespaces; indent | classes | classes, relations, notes, namespaces | style/click/link on an unknown class, two bodies, `direction` inside a line |
| State (`stateDiagram`) | composite `{ }`, `note … end note` (kept as written); indent | states | states, composites, transitions, notes | `--` outside a composite, two bodies, `direction` inside a line |
| ER (`erDiagram`) | attribute `{ }`, `subgraph … end`; indent | entities | entities, relations | trailing `%%` (fix), class/style on an unknown entity, `direction` inside a line |
| Requirement (`requirementDiagram`) | `{ }`; indent | requirements, elements | requirements, elements, relations | undeclared or twice-declared names, `title`, `}` not alone |
| C4 (`C4Context`, …) | boundaries `{ }`; indent | aliases | elements, relations | undeclared or reused aliases, `Rel` without label, repeated `Rel`, `direction` |
| Gantt (`gantt`) | sections; indent | task ids (`after`, `until`, `click`) | task bars | unknown or reused task ids |
| Pie (`pie`) | indent | — | slices, legend | repeated label, negative value |
| User journey (`journey`) | sections; indent | — | tasks, sections | score not a number, `#` |
| Timeline (`timeline`) | sections; indent | — | sections, periods, events | event before any period |
| Mindmap (`mindmap`) | by indentation; spaces kept | — | nodes | a second root |
| Kanban (`kanban`) | by indentation; spaces kept | item and column ids | columns, items | reused id, item left of its column, unknown priority |
| Git graph (`gitGraph`) | indent | branches, commit ids | commits, branch labels | unknown branch, reused branch or commit id |
| Quadrant (`quadrantChart`) | indent | `classDef` names | quadrants, points | unknown class, point outside 0–1 |
| XY chart (`xychart`) | indent | — | bar and line plots | values vs. categories, no plot |
| Sankey (`sankey`) | spaces kept | node names | nodes, links | not three fields, value not a number |
| Packet (`packet`) | indent | — | fields (also split over rows) | gaps, overlaps, end before start |
| Block (`block`) | `block … end`; indent | block ids | blocks, edges | `style` before its block or on a list, unquoted label |
| Architecture (`architecture-beta`) | indent | group, service, junction ids | services, junctions, groups, edges | unknown or later-declared ids, `in` a non-group, edge to a group, plain `architecture` (fix) |
| Radar (`radar-beta`) | curve `{ }`; indent | axes, curves | axes, curves, legend | unknown axis, reused names |
| Treemap (`treemap`) | by indentation; spaces kept | `classDef` names | sections, leaves | unknown class |
| Tree view (`treeView-beta`) | by indentation; spaces kept | — | entries | mixed tabs and spaces, a dedent matching no level |
| Event modeling (`eventmodeling`) | spaces kept | data and entity names | time frames | unknown or reused data, `title` |
| Ishikawa (`ishikawa`) | by indentation; spaces kept | — | head and bones (from the source only) | `title` lines, inline `%%`, mixed indentation |
| Venn (`venn-beta`) | spaces kept | sets, text ids | sets, unions, texts | union of an undeclared set, `accTitle` |
| Use case (`usecase-beta`) | `systemBoundary … end`; indent | actors, use cases, boundaries | actors, use cases, boundaries, relations, notes | note/class/style on an unknown id, reused ids, `title` |
| Wardley (`wardley-beta`) | pipeline `{ }`; indent | components (names with spaces) | components | unknown link target, reused names, whole-number coordinates |
| Cynefin (`cynefin-beta`) | domains; indent | — | domains, items | repeated domain, self transition, capitalised domain (fix) |
| Railroad (`railroad-beta`, `-ebnf-`, `-abnf-`, `-peg-`) | spaces kept (ABNF: as written) | rules | rules, nonterminals | undefined or repeated rules |
| Info (`info`) | — | — | — | — |

"Spaces kept": the indentation carries meaning, so format only removes trailing spaces and extra blank
lines.

A type's knowledge lives in one module, `editor/static/type-<name>.js`, listed in `types.js`; the
descriptor's fields are documented at the top of `type-core.js`.
