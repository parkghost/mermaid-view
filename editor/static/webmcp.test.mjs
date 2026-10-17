// node --test editor/static/webmcp.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { documentUrl, modelContextOf, registerTools, startWebMcp, tools } from './webmcp.js'

const BASE = 'http://localhost:8771/d/p1'
// The tools that read only, and those that change the page or the document shown.
const READERS = ['get_syntax_reference', 'check_diagram', 'get_current_document', 'search_library', 'export_diagram']
const WRITERS = ['set_diagram_source', 'fix_diagram', 'open_document']
// A syntax reference as syntax-reference.json holds it, two types only.
const REFERENCE = {
  mermaid: '12.1.0',
  common: ['%% comments'],
  types: [
    {
      id: 'flowchart',
      name: 'Flowchart',
      purpose: 'Steps.',
      headers: ['flowchart', 'graph'],
      syntax: ['A --> B'],
      notes: ['n'],
      example: 'flowchart TD\n    A --> B',
    },
    {
      id: 'state',
      name: 'State',
      purpose: 'States.',
      headers: ['stateDiagram-v2', 'stateDiagram'],
      syntax: ['[*] --> A'],
      notes: ['n'],
      example: 'stateDiagram-v2\n    [*] --> A',
    },
  ],
}

// A browser's model context as drafted: registerTool(tool, { signal }), the signal unregisters.
function fakeContext() {
  const registered = new Map()
  return {
    registered,
    async registerTool(tool, { signal } = {}) {
      if (registered.has(tool.name)) throw new DOMException('duplicate', 'InvalidStateError')
      registered.set(tool.name, tool)
      signal?.addEventListener('abort', () => registered.delete(tool.name))
    },
  }
}

// The page the tools act on, every call recorded.
function fakePage() {
  const calls = []
  const doc = {
    kind: 'page',
    id: 'p1',
    title: '流程',
    url: BASE,
    diagrams: [{ index: 0, source: 'flowchart TD\n  A --> B' }],
  }
  const finding = { line: 2, severity: 'warning', rule: 'quote-labels', message: 'quote it', fix: () => {} }
  const page = {
    calls,
    current: () => doc,
    findings: async index => (calls.push(['findings', index]), [finding]),
    setSource: async (index, text) => {
      calls.push(['setSource', index, text])
      doc.diagrams[index].source = text
      return []
    },
    fix: async index => (calls.push(['fix', index]), []),
    open: async url => calls.push(['open', url]),
    search: async query => (calls.push(['search', query]), { pages: [{ id: 'p1' }] }),
    exportText: (index, kind) => (
      calls.push(['export', index, kind]), kind === 'svg' ? '<svg/>' : doc.diagrams[index].source
    ),
    // The parser's error for a source with BROKEN in it, else nothing.
    check: async source => (
      calls.push(['check', source]),
      source.includes('BROKEN') ? [{ line: 2, severity: 'error', rule: 'parse', message: 'Parse error on line 2' }] : []
    ),
    reference: async () => REFERENCE,
    base: () => BASE,
  }
  return page
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const byName = page => Object.fromEntries(tools(page).map(t => [t.name, t]))
const names = () => tools(fakePage()).map(t => t.name)

test('without a model context nothing is registered', () => {
  assert.equal(modelContextOf({}, {}), null)
  assert.equal(startWebMcp(fakePage(), { doc: {}, nav: {} }), false)
})

test('document.modelContext is used, else the earlier navigator.modelContext', async () => {
  const current = fakeContext()
  const former = fakeContext()
  assert.equal(modelContextOf({ modelContext: current }, { modelContext: former }), current)
  assert.equal(modelContextOf({}, { modelContext: former }), former)
  assert.equal(startWebMcp(fakePage(), { doc: {}, nav: { modelContext: former } }), true)
  await settle()
  assert.deepEqual([...former.registered.keys()].sort(), names().sort())
})

test('every tool has a name, a description, an object schema and an execute; readers say so', () => {
  for (const t of tools(fakePage())) {
    assert.match(t.name, /^[a-z_]+$/)
    assert.ok(t.description)
    assert.equal(t.inputSchema.type, 'object')
    assert.equal(typeof t.execute, 'function')
  }
  const all = byName(fakePage())
  for (const name of READERS) assert.equal(all[name]?.annotations?.readOnlyHint, true, name)
  for (const name of WRITERS) assert.ok(all[name] && !all[name].annotations?.readOnlyHint, name)
})

test('aborting the signal unregisters the tools, in either form of the API', async () => {
  const context = fakeContext()
  const controller = new AbortController()
  await registerTools(context, tools(fakePage()), controller.signal)
  assert.equal(context.registered.size, names().length)
  controller.abort()
  assert.equal(context.registered.size, 0)

  // The earlier form: registerTool returned a handle to unregister with.
  const unregistered = []
  const former = { registerTool: tool => ({ unregister: () => unregistered.push(tool.name) }) }
  const again = new AbortController()
  await registerTools(former, tools(fakePage()), again.signal)
  again.abort()
  assert.deepEqual(unregistered.sort(), names().sort())

  // And the earliest: the whole set at once.
  const provided = []
  await registerTools({ provideContext: ({ tools: list }) => provided.push(...list) }, tools(fakePage()))
  assert.deepEqual(provided.map(t => t.name).sort(), names().sort())
})

test('get_current_document reads the document shown when called, with plain findings', async () => {
  const page = fakePage()
  const out = JSON.parse(await byName(page).get_current_document.execute({}))
  assert.equal(out.kind, 'page')
  assert.equal(out.id, 'p1')
  assert.deepEqual(out.diagrams[0].findings, [
    { line: 2, severity: 'warning', rule: 'quote-labels', message: 'quote it' },
  ])
  page.current = () => null
  assert.deepEqual(JSON.parse(await byName(page).get_current_document.execute({})), { kind: null, diagrams: [] })
})

test('the editing tools go through the page, and a diagram not on it is refused', async () => {
  const page = fakePage()
  const t = byName(page)
  const set = JSON.parse(await t.set_diagram_source.execute({ index: 0, source: 'flowchart LR\n  A --> C' }))
  assert.deepEqual([set.index, set.findings, set.check.ok, set.check.type], [0, [], true, 'flowchart'])
  assert.deepEqual(JSON.parse(await t.fix_diagram.execute({ index: 0 })), {
    index: 0,
    source: 'flowchart LR\n  A --> C',
    findings: [],
  })
  assert.equal(await t.export_diagram.execute({ index: 0, format: 'svg' }), '<svg/>')
  assert.equal(await t.export_diagram.execute({ index: 0, format: 'mmd' }), 'flowchart LR\n  A --> C')
  assert.deepEqual(page.calls, [
    ['setSource', 0, 'flowchart LR\n  A --> C'],
    ['fix', 0],
    ['export', 0, 'svg'],
    ['export', 0, 'mmd'],
  ])
  await assert.rejects(t.set_diagram_source.execute({ index: 3, source: 'x' }), /no diagram 3/)
  await assert.rejects(t.export_diagram.execute({ index: 0, format: 'png' }), /svg or mmd/)
})

test('open_document opens an id or an editor URL in the page, nothing elsewhere', async () => {
  const page = fakePage()
  const t = byName(page)
  await t.open_document.execute({ target: '2026-10-11T07-09-36-825' })
  await t.open_document.execute({ target: '/f/abc?path=docs%2Fa.md' })
  assert.deepEqual(page.calls, [
    ['open', 'http://localhost:8771/d/2026-10-11T07-09-36-825'],
    ['open', 'http://localhost:8771/f/abc?path=docs%2Fa.md'],
  ])
  await assert.rejects(t.open_document.execute({ target: 'https://example.com/d/x' }), /Not a document/)
  assert.equal(documentUrl('/api/pages', BASE), null)
  assert.equal(documentUrl('', BASE), null)
})

test('search_library searches through the library', async () => {
  const page = fakePage()
  assert.deepEqual(JSON.parse(await byName(page).search_library.execute({ query: '握手' })), { pages: [{ id: 'p1' }] })
  assert.deepEqual(page.calls, [['search', '握手']])
})

test('get_syntax_reference lists the types, gives one by id or header keyword, and names the valid ones', async () => {
  const t = byName(fakePage())
  assert.deepEqual(JSON.parse(await t.get_syntax_reference.execute({})), {
    mermaid: '12.1.0',
    types: [
      { id: 'flowchart', name: 'Flowchart', header: 'flowchart', purpose: 'Steps.' },
      { id: 'state', name: 'State', header: 'stateDiagram-v2', purpose: 'States.' },
    ],
  })
  for (const key of ['state', 'stateDiagram', 'STATEDIAGRAM-V2', ' State ']) {
    const one = JSON.parse(await t.get_syntax_reference.execute({ type: key }))
    assert.equal(one.id, 'state', key)
    assert.deepEqual(
      [one.mermaid, one.common, one.example],
      ['12.1.0', ['%% comments'], 'stateDiagram-v2\n    [*] --> A'],
    )
  }
  await assert.rejects(
    t.get_syntax_reference.execute({ type: 'plantuml' }),
    /No diagram type "plantuml"\. Valid types \(id: header\): flowchart: flowchart, state: stateDiagram-v2/,
  )
})

test('check_diagram reports the parser and the linter on any source, nothing saved', async () => {
  const page = fakePage()
  const t = byName(page)
  const ok = JSON.parse(await t.check_diagram.execute({ source: 'flowchart TD\n  A --> B' }))
  assert.deepEqual(ok, {
    checked: true,
    ok: true,
    type: 'flowchart',
    typeName: 'Flowchart',
    checker: "Mermaid 12.1.0 parser with the editor's config, and mermaid-view lint (Flowchart)",
    errors: [],
    warnings: [],
  })
  const bad = JSON.parse(await t.check_diagram.execute({ source: 'sequenceDiagram\n  BROKEN', type: 'graph' }))
  assert.equal(bad.ok, false)
  assert.equal(bad.type, 'sequence')
  assert.deepEqual(bad.errors, [{ line: 2, severity: 'error', rule: 'parse', message: 'Parse error on line 2' }])
  assert.deepEqual(
    bad.warnings.map(w => w.rule),
    ['type-mismatch'],
  )
  assert.match(bad.warnings[0].message, /type sequence \(Sequence\), not flowchart/)
  const none = JSON.parse(await t.check_diagram.execute({ source: 'hello' }))
  assert.deepEqual([none.type, none.typeName], [null, null])
  await assert.rejects(t.check_diagram.execute({ source: 'x', type: 'nope' }), /No diagram type "nope"/)
  assert.deepEqual(
    page.calls.map(c => c[0]),
    ['check', 'check', 'check'],
  ) // nothing written
})
