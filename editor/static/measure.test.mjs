// node --test editor/static/measure.test.mjs
// Mermaid's measuring of labels at a fractional screen scale: a width a hair from the wrapping width
// is that width (so the label wraps), one that truly differs is kept (so a short label does not),
// and elements measure as before once a drawing ends, or fails.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { snapped, snappedSizes } from './measure.js'

test('a width a hair from whole, as Chrome measures at 175%, is whole', () => {
  assert.equal(snapped(120.00001525878906), 120) // measured on a Windows screen at 175%
  assert.equal(snapped(200.0078125), 200) // mermaid-js/mermaid#7794
  assert.equal(snapped(119.99999), 120)
})

test('a width that truly differs is kept: a label shorter than the wrapping width stays on one line', () => {
  assert.equal(snapped(199.9), 199.9)
  assert.equal(snapped(87.3), 87.3)
})

// An element whose measure (inherited, as HTMLElement's is from Element) says `width`.
class Measured {
  getBoundingClientRect() {
    return { x: 1, y: 2, width: this.width, height: 21.00001 }
  }
}
class Label extends Measured {}
const label = width => Object.assign(new Label(), { width })

test('while a drawing runs its labels measure snapped, and after it as before', async () => {
  const during = await snappedSizes(() => label(120.00001525878906).getBoundingClientRect(), Label.prototype)
  assert.deepEqual([during.width, during.height, during.x, during.right], [120, 21, 1, 121])
  assert.equal(label(120.00001525878906).getBoundingClientRect().width, 120.00001525878906)
  assert.equal(Object.hasOwn(Label.prototype, 'getBoundingClientRect'), false)
})

test('a drawing that fails leaves the measure as it was', async () => {
  await assert.rejects(
    snappedSizes(() => Promise.reject(new Error('parse error')), Label.prototype),
    /parse error/,
  )
  assert.equal(label(200.0078125).getBoundingClientRect().width, 200.0078125)
})
