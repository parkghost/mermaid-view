// node --test editor/static/mermaid-lang.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  elementOfDomId,
  fixAll,
  format,
  idsOnLine,
  lint,
  nodeIds,
  sourceLines,
  subgraphIndex,
  tokenize,
  typeOf,
} from './mermaid-lang.js'

const FLOW = `flowchart TD
    subgraph "Device"
        Wake["喚醒詞"]
        Mic["麥克風"]
    end
    Wake -->|"開始"| Mic
    Mic --> Out["輸出"]
`

test('tokens: strings, labels and arrows keep their text', () => {
  const types = tokenize('Wake -->|"開始"| Mic["a b"]').map(t => t.type)
  assert.deepEqual(types, ['id', 'space', 'arrow', 'label', 'space', 'id', 'punct', 'string', 'punct'])
  assert.equal(tokenize('%% a comment')[0].type, 'comment')
  assert.equal(tokenize('A -.-> B')[2].text, '-.->')
  assert.equal(tokenize('A ==> B')[2].text, '==>')
})

test('format indents blocks and spaces arrows, leaving quoted text alone', () => {
  const messy = 'flowchart TD\nsubgraph "Device"\nWake["a  b"]-->|"x"|Mic\nend\n\n\n\nMic-->Out   \n'
  assert.equal(
    format(messy),
    'flowchart TD\n    subgraph "Device"\n        Wake["a  b"] -->|"x"| Mic\n    end\n\n    Mic --> Out\n',
  )
  assert.equal(format(FLOW), FLOW) // already formatted: unchanged
})

test('format indents sequence diagram blocks', () => {
  const seq = 'sequenceDiagram\nA->>B: hi\nloop every second\nB->>A: tick\nend\n'
  assert.equal(format(seq), 'sequenceDiagram\n    A->>B: hi\n    loop every second\n        B->>A: tick\n    end\n')
})

test('lint finds the house-style problems', () => {
  const bad = [
    'flowchart TD',
    '    subgraph My Group',
    '        A[plain text] -->|go| B["ok"]',
    '        A -->|"a → b"| B',
    '    end',
    '    end',
    '    classDef red fill:#f00',
    '    節點["中文 id"]',
  ].join('\n')
  const rules = lint(bad).map(f => `${f.line}:${f.rule}`)
  assert.deepEqual(rules, [
    '2:subgraph-quote',
    '3:edge-label-quote',
    '3:node-text-quote',
    '4:edge-label-chars',
    '6:block-balance',
    '7:no-styling',
    '8:node-id',
  ])
  assert.deepEqual(lint(FLOW), [])
})

test('a quoted label is text: its brackets and bars are no shape or edge label, and fixes leave it', () => {
  const quoted = [
    'flowchart LR',
    '    a["call fetch()"] -->|"GET /items/{id}"| b["read arr[i]"]',
    '    c["cat f | grep x"] --> d["sort | uniq"]',
  ].join('\n')
  assert.deepEqual(lint(quoted), [])
  assert.equal(fixAll(quoted), quoted)
})

test('a fix keeps the $ signs of the text it quotes', () => {
  assert.equal(
    fixAll('flowchart LR\n    A[Price $& tax] -->|costs $$| B'),
    'flowchart LR\n    A["Price $& tax"] -->|"costs $$"| B',
  )
})

test('format keeps links with a head at each end, and long invisible links, whole', () => {
  const links = 'flowchart LR\n    A o--o B\n    C x--x D\n    E <--> F\n    G ~~~~ H\n'
  assert.equal(format(links), links)
})

test('a directive over several lines comes before the diagram: its type, lint and format follow it', () => {
  const mindmap = '%%{\n  init: { "theme": "dark" }\n}%%\nmindmap\n  root((Root))\n    A\n      A1\n'
  assert.equal(typeOf(mindmap).id, 'mindmap')
  assert.equal(format(mindmap), mindmap) // its indentation is its meaning
  const flow = '%%{\n  init: { "theme": "dark" }\n}%%\nflowchart TD\n    subgraph My Group\n    end\n'
  assert.equal(format(flow), flow)
  assert.ok(lint(flow).some(f => f.rule === 'subgraph-quote'))
})

test('an unclosed block is an error at its opening line', () => {
  assert.deepEqual(
    lint('flowchart TD\n    subgraph "x"\n    A --> B\n').map(f => `${f.line}:${f.rule}`),
    ['2:block-balance'],
  )
})

test('fixAll quotes titles, labels and node text', () => {
  const fixed = fixAll('flowchart TD\n    subgraph My Group\n        A[plain] -->|go| B\n    end\n')
  assert.equal(fixed, 'flowchart TD\n    subgraph "My Group"\n        A["plain"] -->|"go"| B\n    end\n')
  assert.deepEqual(lint(fixed), [])
})

// Mermaid 11+ shape data and edge ids: `id@{ ... }` (may span lines), `A e1@--> B`, `e1@{ ... }`.
const SHAPES = `flowchart LR
    db@{ shape: cyl, label: "Orders DB" }
    api["API"] e1@--> db
    e1@{ animate: true }
    api e2@==>|"read"| cache@{
      shape: lin-cyl
      label: "Cache"
    }
    cache-->db
`

test('shape data and edge ids are not house-style findings; the style still holds around them', () => {
  assert.deepEqual(lint(SHAPES), [])
  assert.deepEqual(
    lint(
      'flowchart TD\n  A@{ shape: rect, label: "Start here" } -->|go| B[plain]\n  B-->C["ok"]\n  e1@{ curve: linear }\n',
    ).map(f => `${f.line}:${f.rule}`),
    ['2:edge-label-quote', '2:node-text-quote'],
  )
  // Arrows without spaces split nodes: neither `B-->C` nor `-->C` is an id.
  assert.deepEqual(
    lint('flowchart TD\n  B-->C[fa:fa-ban forbidden]\n  id1(Start)-->id2(Stop)\n').map(
      f => `${f.line}:${f.rule}:${f.message.split(' ')[5]}`,
    ),
    ['2:node-text-quote:C', '3:node-text-quote:id1', '3:node-text-quote:id2'],
  )
  assert.deepEqual(
    lint('flowchart TD\n  A --> B\n  click B call callback() "tip"\n').map(f => f.rule),
    ['no-styling'],
  )
})

test('fixAll keeps the slants of lean and trapezoid shapes outside the quotes', () => {
  assert.equal(
    fixAll('flowchart TD\n  A[/Christmas\\] --> B[\\Go/]\n  C[x/y]\n'),
    'flowchart TD\n  A[/"Christmas"\\] --> B[\\"Go"/]\n  C["x/y"]\n',
  )
})

test('shape data and edge ids: names, rename and the drawing', async () => {
  const { definition, linkModel, names, occurrences, rename, symbols } = await import('./mermaid-lang.js')
  const { edgeIds } = await import('./type-flowchart.js')
  assert.deepEqual(nodeIds(SHAPES), ['db', 'api', 'cache'])
  assert.deepEqual(
    [...edgeIds(SHAPES)],
    [
      ['e1', { from: 'api', to: 'db', line: 3 }],
      ['e2', { from: 'api', to: 'cache', line: 5 }],
    ],
  )
  assert.deepEqual(names(SHAPES), ['db', 'api', 'cache', 'e1', 'e2'])
  assert.deepEqual(
    symbols(SHAPES)
      .filter(s => s.def)
      .map(s => `${s.name}:${s.line}`),
    ['db:2', 'api:3', 'e1:3', 'e2:5', 'cache:5'],
  )
  assert.ok(!symbols(SHAPES).some(s => ['shape', 'label', 'animate', 'true', 'cyl'].includes(s.name)))
  assert.deepEqual(
    occurrences(SHAPES, 'e1').map(o => o.line),
    [3, 4],
  )
  assert.deepEqual(definition(SHAPES, 'cache'), { line: 5, start: 24, end: 29 })
  assert.equal(
    rename(SHAPES, 'e1', 'fast').split('\n').slice(2, 4).join('\n'),
    '    api["API"] fast@--> db\n    fast@{ animate: true }',
  )
  assert.equal(rename(SHAPES, 'db', 'orders').split('\n')[1], '    orders@{ shape: cyl, label: "Orders DB" }')
  const model = linkModel(SHAPES)
  assert.deepEqual(model.keysAt(3), ['node:api', 'node:db', 'edge:api>db'])
  assert.deepEqual(model.keysAt(4), ['edge:api>db'])
  assert.deepEqual(model.keysAt(6), [])
  assert.deepEqual(model.select('edge:api>db'), { primary: 3, related: [3, 4] })
  assert.deepEqual(model.select('node:cache'), { primary: 5, related: [5, 9] })
  // An edge with an id is drawn under it (with or without the render's id first).
  assert.deepEqual(elementOfDomId('m0_3-e1', model.ids, 'm0_3', model.edges), { kind: 'edge', from: 'api', to: 'db' })
  assert.deepEqual(elementOfDomId('L_cache_db_0', model.ids, '', model.edges), {
    kind: 'edge',
    from: 'cache',
    to: 'db',
  })
})

test('ids: the node ids of a flowchart, in order', () => {
  assert.deepEqual(nodeIds(FLOW), ['Wake', 'Mic', 'Out'])
  assert.deepEqual(idsOnLine('    Wake -->|"開始 Mic"| Mic'), ['Wake', 'Mic'])
})

test('source lines of a node, an edge and a cluster', () => {
  assert.deepEqual(sourceLines(FLOW, { kind: 'node', id: 'Mic' }), { primary: 4, related: [4, 6, 7] })
  assert.deepEqual(sourceLines(FLOW, { kind: 'edge', from: 'Wake', to: 'Mic' }), { primary: 6, related: [6] })
  assert.deepEqual(sourceLines(FLOW, { kind: 'cluster', index: 0 }), { primary: 2, related: [2, 3, 4, 5] })
  assert.equal(sourceLines(FLOW, { kind: 'node', id: 'Nope' }), undefined)
})

test('a node is connected by its edges to the nodes at their other ends', async () => {
  const { linkModel } = await import('./mermaid-lang.js')
  const model = linkModel(
    'flowchart LR\n  A -->|"go"| B & C\n  B --> D --> E\n  E --> E\n  class A,D hot\n  %% A --> Z\n',
  )
  const sorted = key => model.neighbors(key).sort()
  // `&` links each node of its group; a class line or a comment connects nothing.
  assert.deepEqual(sorted('node:A'), ['edge:A>B', 'edge:A>C', 'node:B', 'node:C'])
  assert.deepEqual(model.keysAt(2), ['node:A', 'node:B', 'node:C', 'edge:A>B', 'edge:A>C'])
  // In a chain, only the arrows touching the node.
  assert.deepEqual(sorted('node:B'), ['edge:A>B', 'edge:B>D', 'node:A', 'node:D'])
  // A loop is its own edge, not its own neighbour.
  assert.deepEqual(sorted('node:E'), ['edge:D>E', 'edge:E>E', 'node:D'])
  assert.deepEqual(model.neighbors('edge:A>B'), [])
})

test('statements split by `;` and text links connect only the nodes they link', async () => {
  const { linkModel } = await import('./mermaid-lang.js')
  const semi = linkModel('graph TD\n  A-->B; C-->D\n')
  assert.deepEqual(semi.neighbors('node:A').sort(), ['edge:A>B', 'node:B'])
  assert.ok(!semi.keysAt(2).includes('edge:B>D'))
  const texted = linkModel('flowchart LR\n  A -- yes --> B\n  B == no ==> C\n')
  assert.deepEqual(texted.neighbors('node:B').sort(), ['edge:A>B', 'edge:B>C', 'node:A', 'node:C'])
})

test('dom ids of rendered nodes and edges map back to the source', () => {
  const ids = ['Wake', 'Mic', 'Out', 'Mic_2']
  assert.deepEqual(elementOfDomId('flowchart-Wake-3', ids), { kind: 'node', id: 'Wake' })
  assert.deepEqual(elementOfDomId('L_Wake_Mic_0', ids), { kind: 'edge', from: 'Wake', to: 'Mic' })
  assert.deepEqual(elementOfDomId('L-Mic-Out-0', ids), { kind: 'edge', from: 'Mic', to: 'Out' })
  assert.deepEqual(elementOfDomId('L_Wake_Mic_2_0', ids), { kind: 'edge', from: 'Wake', to: 'Mic_2' })
  assert.equal(elementOfDomId('something-else', ids), undefined)
})

test('mermaid 12 dom ids carry the render id first', () => {
  const ids = ['A', 'B_2']
  assert.deepEqual(elementOfDomId('m0_3-flowchart-B_2-1', ids, 'm0_3'), { kind: 'node', id: 'B_2' })
  assert.deepEqual(elementOfDomId('m0_3-L_A_B_2_0', ids, 'm0_3'), { kind: 'edge', from: 'A', to: 'B_2' })
  assert.deepEqual(elementOfDomId('L_A_B_2_0', ids, 'm0_3'), { kind: 'edge', from: 'A', to: 'B_2' }) // data-id
})

test('a subgraph is found by its title', () => {
  const text =
    'flowchart TD\n  subgraph "Voice PE 裝置"\n  end\n  subgraph gw["Gateway"]\n  end\n  subgraph Plain\n  end'
  assert.equal(subgraphIndex(text, 'Voice PE 裝置'), 0)
  assert.equal(subgraphIndex(text, 'Gateway'), 1)
  assert.equal(subgraphIndex(text, 'Plain'), 2)
  assert.equal(subgraphIndex(text, 'Nope'), undefined)
})

test('occurrences find a node id outside quotes and labels', async () => {
  const { occurrences, rename, symbolAt, foldingRanges } = await import('./mermaid-lang.js')
  const text = 'flowchart TD\n    Router{"Router 比對"}\n    Turn -->|"到 Router"| Router\n    Router --> Out'
  assert.deepEqual(occurrences(text, 'Router'), [
    { line: 2, start: 5, end: 11 },
    { line: 3, start: 26, end: 32 },
    { line: 4, start: 5, end: 11 },
  ])
  assert.equal(
    rename(text, 'Router', 'Match'),
    'flowchart TD\n    Match{"Router 比對"}\n    Turn -->|"到 Router"| Match\n    Match --> Out',
  )
  assert.equal(symbolAt(text, 4, 7)?.name, 'Router')
  assert.equal(symbolAt(text, 4, 11)?.name, 'Router') // just after the word
  assert.equal(symbolAt(text, 2, 15), undefined) // the word in a quoted label is no name
  assert.deepEqual(foldingRanges(FLOW), [{ start: 2, end: 5 }])
})

test('a line diff keeps the common lines and marks the changed ones', async () => {
  const { lineDiff } = await import('./mermaid-lang.js')
  const d = lineDiff('flowchart TD\n  A --> B\n  B --> C\n', 'flowchart TD\n  A --> X\n  B --> C\n  C --> D\n')
  assert.deepEqual(
    d.map(l => l.op + l.text),
    [' flowchart TD', '-  A --> B', '+  A --> X', '   B --> C', '+  C --> D'],
  )
  assert.deepEqual(lineDiff('a\n', 'a\n'), [{ op: ' ', text: 'a' }])
})
