// node --test editor/static/themes.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TYPES, typeOf } from './mermaid-lang.js'
import { fitTo, LAYOUTS, LOOKS } from './themes.js'

const fit = (text, look, layout) => fitTo(typeOf(text), look, layout)

test('a diagram is drawn with the chosen look and layout where its type takes them', () => {
  assert.deepEqual(fit('flowchart LR\n  A --> B', 'handDrawn', 'elk'), {
    look: 'handDrawn',
    layout: 'elk',
    declined: [],
  })
  assert.deepEqual(fit('swimlane-beta\n  A --> B', 'neo', 'elk'), { look: 'neo', layout: 'elk', declined: [] })
  assert.deepEqual(fit('sequenceDiagram\n  A->>B: hi', 'neo', 'dagre'), { look: 'neo', layout: 'dagre', declined: [] })
})

test('a type that does not take the chosen look or layout is drawn classic, with dagre, and says so', () => {
  // ELK fails every mind map: it is never asked to lay one out.
  assert.deepEqual(fit('mindmap\n  root\n    A', 'handDrawn', 'elk'), {
    look: 'handDrawn',
    layout: 'dagre',
    declined: ['ELK'],
  })
  assert.deepEqual(fit('pie\n  "a" : 1', 'handDrawn', 'elk'), {
    look: 'classic',
    layout: 'dagre',
    declined: [LOOKS.handDrawn, 'ELK'],
  })
  assert.deepEqual(fit('pie\n  "a" : 1', 'classic', 'dagre').declined, [])
})

test('only a mind map is laid out as a tidy tree: it fails a flowchart and hangs a state diagram', () => {
  assert.deepEqual(fit('mindmap\n  root\n    A', 'neo', 'tidy-tree'), {
    look: 'neo',
    layout: 'tidy-tree',
    declined: [],
  })
  for (const text of ['flowchart LR\n  A --> B', 'stateDiagram-v2\n  [*] --> A', 'classDiagram\n  class A']) {
    assert.deepEqual(
      fit(text, 'classic', 'tidy-tree'),
      { look: 'classic', layout: 'dagre', declined: ['Tidy tree'] },
      text,
    )
  }
})

test('each type takes only looks and layouts the page offers', () => {
  for (const desc of TYPES) {
    for (const look of desc.looks ?? []) assert.ok(look in LOOKS && look !== 'classic', `${desc.id}: look ${look}`)
    for (const layout of desc.layouts ?? [])
      assert.ok(layout in LAYOUTS && layout !== 'dagre', `${desc.id}: layout ${layout}`)
  }
})
