// node --test editor/static/docs-examples.test.mjs
// The lint against real Mermaid 12.1.0 sources: every example of its documentation
// (docs-examples.json, each one parsed by Mermaid 12.1.0) raises no finding beyond the flowchart
// house style and a few named ones; and every rule has a broken source it catches.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { MERMAID_VERSION } from './check.js'
import { lint, TYPES, typeOf } from './mermaid-lang.js'

const docs = JSON.parse(readFileSync(new URL('./docs-examples.json', import.meta.url), 'utf8'))
const reference = JSON.parse(readFileSync(new URL('./syntax-reference.json', import.meta.url), 'utf8'))

// The flowchart's house style (quoted text, plain ids, ASCII labels, no styling) is meant to flag
// the docs' plain flowcharts; no other type has a style rule.
const HOUSE_STYLE = new Set([
  'subgraph-quote',
  'edge-label-quote',
  'edge-label-chars',
  'node-text-quote',
  'node-id',
  'no-styling',
])

// Findings the docs earn by Mermaid's own rules (each example is drawn all the same).
const KNOWN = {
  'gitgraph.md#14': ['duplicate'], // commit id "Boston" twice: Mermaid warns and keeps only the second
  'kanban.md#2': ['duplicate'], // task id id3 twice: the docs ask for unique ids
  'railroad.md#8': ['undefined', 'undefined', 'undefined'], // string and number are left undefined
}

const byType = new Map()
for (const ex of docs.examples) {
  const id = typeOf(ex.text).id
  byType.set(id, [...(byType.get(id) ?? []), ex])
}

test('the docs examples cover every type but info', () => {
  assert.equal(docs.mermaid, MERMAID_VERSION) // the version the page renders with
  assert.deepEqual(
    TYPES.map(d => d.id).filter(id => !byType.has(id)),
    ['info'],
  )
})

for (const [id, examples] of byType) {
  test(`${id}: the Mermaid 12.1.0 docs examples raise no findings but the house style`, () => {
    for (const ex of examples) {
      const rules = lint(ex.text)
        .map(f => f.rule)
        .filter(rule => !(id === 'flowchart' && HOUSE_STYLE.has(rule)))
      assert.deepEqual(rules, KNOWN[ex.src] ?? [], `${ex.src}:\n${ex.text}`)
    }
  })
}

test('the syntax reference examples raise no findings at all', () => {
  for (const t of reference.types) assert.deepEqual(lint(t.example), [], t.id)
})

// The lint runs on every keystroke: half-typed text (`style ` with no id yet) must not throw.
test('the lint never throws on a half-typed source', () => {
  for (const t of reference.types) {
    for (let n = 1; n <= t.example.length; n++) {
      const text = t.example.slice(0, n)
      assert.doesNotThrow(() => lint(text), `${t.id}:\n${text}`)
    }
  }
})

// Sources that break the rules of every type, one or more findings each.
const BROKEN = [
  'flowchart TD\n  subgraph My Group\n    A[plain] -->|go| B["ok"]\n    A -->|"a → b"| B\n  end\n  end\n  classDef red fill:#f00\n  my.node["x"]\n  subgraph "x"\n',
  'sequenceDiagram\n  participant A\n  participant A\n  B->>A: x; y\n  participant B\n',
  'classDiagram\n  class A {\n  }\n  class A {\n  }\n  style Nope fill:#f00\n  A --> B : go direction LR\n',
  'stateDiagram-v2\n  state S {\n    A --> B\n  }\n  state S {\n  }\n  --\n  A --> B : go direction LR\n',
  'erDiagram\n  A ||--o{ B : has %% why\n  A ||--o{ B : has direction LR\n  style Nope fill:#f00\n',
  'requirementDiagram\n  title x\n  requirement r {\n  }\n  requirement r {\n  }\n  element e {\n  type: x }\n  f - satisfies -> r\n',
  'C4Context\n  direction LR\n  Person(a, "A")\n  Person(a, "B")\n  Rel(a, b)\n  Rel(a, b, "x")\n  Rel(a, b, "y")\n',
  'gantt\n  A :a1, 2024-01-01, 1d\n  B :a1, 2024-01-01, 1d\n  C :after a2, 1d\n',
  'pie\n  "a" : 1\n  "a" : -2\n',
  'journey\n  section S\n    a: x: Me\n    b # c: 3: Me\n',
  'timeline\n  : orphan\n',
  'mindmap\n  root\n    a\n  other\n',
  "kanban\n  todo[Todo]\n    a[A]@{ priority: 'Urgent' }\n    a[B]\n x[X]\n",
  'gitGraph\n  commit id: "a"\n  commit id: "a"\n  branch dev\n  branch dev\n  checkout nope\n',
  'quadrantChart\n  A:::nope: [1.5, 0.2]\n',
  'xychart\n  x-axis [a, b, c]\n  bar [1, 2]\n',
  'xychart\n  x-axis [a]\n',
  'sankey\nA,B\nA,B,x\n',
  'packet\n  0-15: "a"\n  20-31: "b"\n  40-35: "c"\n',
  'block\n  style a fill:#f00\n  a["x"] b\n  b[y]\n  style a,b fill:#f00\n',
  'architecture\n  service a(server)[A]\n  service a(server)[A2]\n  group g(cloud)[G]\n  a:L -- R:b\n  service b(server)[B] in g\n  service c(server)[C] in a\n  a:L -- R:g\n  service x(server)[X] in nope\n',
  'radar-beta\n  axis a, a\n  curve c{ zz: 1 }\n  curve c{ a: 1 }\n',
  'treemap\n  "a": 1:::nope\n',
  'treeView-beta\n  a\n\t b\n      c\n    d\n',
  'eventmodeling\n  title x\n  data D {\n  }\n  data D {\n  }\n  tf 01 evt E [[Nope]]\n',
  'ishikawa\n  title x\n  Head %% c\n\t  bone\n',
  'venn-beta\n  accTitle: x\n  set A\n  set A\n  union A,B\n',
  'usecase-beta\n  title x\n  actor U\n  actor U\n  note for Nope "x"\n',
  'wardley-beta\n  component A [1, 0.5]\n  component A [0.5, 0.5]\n  A -> Nope\n',
  'cynefin-beta\n  Complex\n  complex\n  complex\n  complex --> complex : "x"\n',
  'railroad-ebnf-beta\n  a = b ;\n  a = "x" ;\n',
  'railroad-abnf-beta\n  a = b DIGIT\n',
  'railroad-peg-beta\n  A <- B ;\n',
  'railroad-beta\n  a = nonterminal("b");\n',
  'sequenceDiagram\n  loop x\n  A->>B: y\n',
  'stateDiagram\n  A --> B\n  }\n',
]

test('every broken source raises a finding', () => {
  for (const text of BROKEN) assert.ok(lint(text).length, `no finding for:\n${text}`)
})
