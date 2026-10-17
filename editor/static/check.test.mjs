// node --test editor/static/check.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkReport, sourceLine } from './check.js'

test("a parser's line is the source's line, past front matter, directives and comments", () => {
  const cases = [
    ['flowchart TD\n    A --> B\n    B --> -->', 3, 3],
    ['---\ntitle: x\n---\nflowchart TD\n    A --> B\n    B --> -->', 3, 6],
    ['---\ntitle: x\n---\n\n\nflowchart TD\n    A --> B\n    B --> -->', 3, 8],
    ['%% c\nflowchart TD\n    %% mid\n    A --> B\n    B --> -->', 3, 5],
    ['%%{init: {"theme":"dark"}}%%\nflowchart TD\n    A --> B\n    B --> -->', 3, 4],
    ['\n\nflowchart TD\n\n    A --> B\n    B --> -->', 4, 6],
    ['flowchart TD\n    A --> B', 9, 9], // past the end: as said
  ]
  for (const [source, parsed, want] of cases) assert.equal(sourceLine(source, parsed), want, JSON.stringify(source))
})

test('a report: valid when nothing is an error, the type detected, a type other than the one meant warned of', () => {
  const lint = { line: 2, severity: 'warning', rule: 'edge-label-quote', message: 'quote it', fix: () => {} }
  const report = checkReport('flowchart TD\n    A -->|x| B', [lint])
  assert.equal(report.ok, true)
  assert.equal(report.type, 'flowchart')
  assert.equal(report.typeName, 'Flowchart')
  assert.deepEqual(report.errors, [])
  // A warning as plain data: its fix (a function) does not go into the report.
  assert.deepEqual(report.warnings, [{ line: 2, severity: 'warning', rule: 'edge-label-quote', message: 'quote it' }])
  const parse = { line: 1, severity: 'error', rule: 'parse', message: 'No diagram type detected' }
  const unknown = checkReport('hello', [parse], 'state')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.type, null)
  assert.deepEqual(
    unknown.errors.map(f => f.rule),
    ['parse'],
  )
  assert.equal(unknown.warnings[0].rule, 'type-mismatch')
  assert.match(unknown.warnings[0].message, /not state/)
})
