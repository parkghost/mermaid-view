// node --test editor/static/arrival.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { editing, listening, notify, STALE, TYPING_GRACE } from './arrival.js'

test('a tab with unsaved edits or an unsent note is not switched away from', () => {
  assert.equal(editing({ unsaved: true }), true)
  assert.equal(editing({ note: '把 B 改成 C' }), true)
  assert.equal(editing({ note: '   ' }), false)
  assert.equal(editing({}), false)
})

test('typing a moment ago counts as editing; it stops counting once typing settles', () => {
  const now = 1_000_000
  assert.equal(editing({ typedAt: now - 1000, now }), true)
  assert.equal(editing({ typedAt: now - TYPING_GRACE - 1, now }), false)
})

// A Notification stand-in recording what the page asked of it.
function fakeNotification(permission) {
  const made = []
  function N(title, options) {
    made.push({ title, ...options })
    this.close = () => {}
  }
  N.permission = permission
  N.requestPermission = () => {
    throw new Error('the page must never ask on its own')
  }
  return { N, made }
}

test('a notification shows only where the person allowed them, and the page never asks', () => {
  for (const permission of ['default', 'denied']) {
    const { N, made } = fakeNotification(permission)
    assert.equal(notify(N, '新的圖'), false)
    assert.deepEqual(made, [])
  }
  const { N, made } = fakeNotification('granted')
  assert.equal(notify(N, '新的圖'), true)
  assert.equal(made[0].body, '新的圖')
  assert.equal(notify(undefined, '新的圖'), false) // a browser without notifications
})

test('a tab hidden and unused for STALE lets its stream go; one in view keeps it however long unused', () => {
  const now = 10_000_000_000
  assert.equal(listening({ visible: false, usedAt: now - STALE + 60_000, now }), true)
  assert.equal(listening({ visible: false, usedAt: now - STALE - 1, now }), false)
  assert.equal(listening({ visible: true, usedAt: now - 10 * STALE, now }), true)
})
