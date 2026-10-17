// node --test editor/static/syntax-reference.test.mjs
// The syntax reference (syntax-reference.json) against the types the editor knows: one entry for
// each registered type, headers its descriptor detects, an example of that type the lint finds no
// error in; and how a type is looked up (the MCP server's reference.py looks up the same way).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { checkReport, MERMAID_VERSION } from './check.js'
import { lint } from './mermaid-lang.js'
import { findType, loadReference, summaries, unknownType } from './syntax-reference.js'
import { TYPES, typeOf, typeOfHeader } from './types.js'

const reference = JSON.parse(readFileSync(new URL('./syntax-reference.json', import.meta.url), 'utf8'))

test('every registered type has exactly one entry, in the same order', () => {
  assert.equal(reference.mermaid, MERMAID_VERSION) // the version the page renders with
  assert.deepEqual(
    reference.types.map(t => t.id),
    TYPES.map(d => d.id),
  )
  for (const d of TYPES) assert.equal(reference.types.find(t => t.id === d.id).name, d.name, d.id)
})

test('each entry is complete, its headers are ones its descriptor detects', () => {
  for (const t of reference.types) {
    for (const key of ['purpose', 'headers', 'syntax', 'notes', 'example']) assert.ok(t[key]?.length, `${t.id}: ${key}`)
    for (const key of ['syntax', 'relations', 'blocks', 'notes', 'houseStyle']) {
      for (const line of t[key] ?? [])
        assert.ok(typeof line === 'string' && !line.includes('\n'), `${t.id}: ${key}: one line each`)
    }
    for (const header of t.headers) assert.equal(typeOfHeader(header).id, t.id, `${t.id}: header ${header}`)
  }
  assert.ok(
    reference.types.find(t => t.id === 'flowchart').houseStyle?.length,
    "the flowchart lint's house style is told",
  )
})

test("each type with a page in Mermaid's docs links to it", () => {
  for (const t of reference.types.filter(t => t.id !== 'info')) {
    assert.match(t.docs ?? '', /^https:\/\/mermaid\.js\.org\/syntax\/\w+\.html$/, `${t.id}: docs`)
  }
})

test("each entry's example is of its type and the lint finds no error in it", () => {
  for (const t of reference.types) {
    assert.equal(typeOf(t.example).id, t.id, `${t.id}: example's type`)
    const errors = lint(t.example).filter(f => f.severity === 'error')
    assert.deepEqual(errors, [], `${t.id}: lint errors in the example`)
    assert.equal(checkReport(t.example, lint(t.example), t.id).ok, true)
  }
})

test('a type is found by its id, a header keyword or its name, in any case; nothing else', () => {
  const id = key => findType(reference, key)?.id
  assert.equal(id('flowchart'), 'flowchart')
  assert.equal(id('graph'), 'flowchart')
  assert.equal(id(' GRAPH '), 'flowchart')
  assert.equal(id('stateDiagram-v2'), 'state')
  assert.equal(id('Entity relationship'), 'er')
  assert.equal(id('railroad-ebnf-beta'), 'railroadEbnf')
  assert.equal(id('plantuml'), undefined)
  assert.equal(id(''), undefined)
  assert.match(
    unknownType(reference, 'plantuml'),
    /^No diagram type "plantuml"\. Valid types \(id: header\): flowchart: flowchart, /,
  )
  // What an agent reads of each type in the list: its id, name, the header to write, its purpose.
  const flow = summaries(reference).find(s => s.id === 'flowchart')
  assert.equal(flow.name, 'Flowchart')
  assert.equal(flow.header, 'flowchart')
  assert.ok(flow.purpose)
})

test('the page fetches the reference once, and again after a failure', async () => {
  const urls = []
  let fail = true
  const fetchFn = async url => {
    urls.push(String(url))
    if (fail) return { ok: false, status: 500 }
    return { ok: true, json: async () => reference }
  }
  await assert.rejects(loadReference(fetchFn), /500/)
  fail = false
  assert.equal(await loadReference(fetchFn), reference)
  assert.equal(await loadReference(fetchFn), reference)
  assert.equal(urls.length, 2)
  assert.match(urls[0], /\/syntax-reference\.json$/)
})
