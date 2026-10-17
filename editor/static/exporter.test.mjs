// node --test editor/static/exporter.test.mjs
// A PNG's size: times the drawing's, or a set width or height with the other side in proportion,
// never so large that the browser's canvas gives no image; a link to the Mermaid Live Editor; and a
// Markdown block that holds its diagram whole.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inflateSync } from 'node:zlib'

import { liveEditorUrl, MAX_SIDE, markdownBlock, pngSize } from './exporter.js'

test('a scale multiplies both sides', () => {
  assert.deepEqual(pngSize(400, 300, { scale: 3 }), { width: 1200, height: 900 })
})

test('a set width or height keeps the drawing in proportion', () => {
  assert.deepEqual(pngSize(400, 300, { width: 1600 }), { width: 1600, height: 1200 })
  assert.deepEqual(pngSize(400, 300, { height: 150 }), { width: 200, height: 150 })
})

test('no side goes past what a canvas can hold, the proportion kept', () => {
  const { width, height } = pngSize(6000, 1500, { scale: 4 })
  assert.equal(width, MAX_SIDE)
  assert.equal(height, MAX_SIDE / 4)
  assert.ok(pngSize(300, 200, { height: 100_000 }).width <= MAX_SIDE)
})

test('a width or height left empty falls back to twice the size', () => {
  assert.deepEqual(pngSize(400, 300, { width: 0 }), { width: 800, height: 600 })
  assert.deepEqual(pngSize(400, 300, { height: NaN }), { width: 800, height: 600 })
})

test('a Live Editor link carries the diagram and its config, as the Live Editor reads its pako: state', async () => {
  const code = 'flowchart LR\n  A["中文"] --> B'
  const url = await liveEditorUrl(code, { theme: 'dark', look: 'neo' })
  const [base, state] = url.split('#pako:')
  assert.equal(base, 'https://mermaid.live/edit')
  assert.match(state, /^[\w-]+$/) // base64url, no padding: nothing a URL would escape
  const json = JSON.parse(inflateSync(Buffer.from(state, 'base64url')).toString('utf8'))
  assert.equal(json.code, code)
  assert.deepEqual(JSON.parse(json.mermaid), { theme: 'dark', look: 'neo' })
})

// A fenced block's body as CommonMark reads it: up to the first line that closes the opening fence.
function readBlock(markdown) {
  const [opening, ...lines] = markdown.split('\n')
  const fence = /^(`{3,})/.exec(opening)[1]
  const end = lines.findIndex(line => (/^ {0,3}(`+)[ \t]*$/.exec(line)?.[1].length ?? 0) >= fence.length)
  return `${lines.slice(0, end).join('\n')}\n`
}

test('a Markdown block holds a diagram whose lines look like a closing fence, whole', () => {
  const source = 'flowchart TD\n  A --> B\n```\n   ````  \n  B --> C\n'
  assert.equal(readBlock(markdownBlock(source)), source)
  assert.equal(readBlock(markdownBlock('flowchart TD\n  A --> B\n')), 'flowchart TD\n  A --> B\n')
})
