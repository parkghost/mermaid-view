// node --test editor/static/icons.test.mjs
// The icon packs: every Font Awesome prefix Mermaid reads in a label has one, a set shared by two
// names is fetched once, and a set that failed to load is fetched again.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ICON_PACKS, iconPacks } from './icons.js'

const fetching = (fail = () => false) => {
  const urls = []
  const fetchFn = async url => {
    urls.push(url)
    if (fail()) return { ok: false, status: 503 }
    return { ok: true, json: async () => ({ prefix: url.split('/').at(-2), icons: {} }) }
  }
  return { urls, fetchFn }
}

test('each Font Awesome prefix Mermaid reads in a label has a pack (its /(fa[bklrs]?):fa-/, free sets)', () => {
  for (const name of ['fa', 'fas', 'far', 'fab']) assert.ok(ICON_PACKS[name], name)
  assert.match(ICON_PACKS.fab, /brands/)
  assert.match(ICON_PACKS.far, /regular/)
})

test('a set two names share is fetched once', async () => {
  const { urls, fetchFn } = fetching()
  const packs = Object.fromEntries(iconPacks(fetchFn).map(p => [p.name, p]))
  await packs.fa.loader()
  await packs.fas.loader()
  assert.equal(urls.length, 1)
  assert.match(urls[0], /^https:\/\/cdn\.jsdelivr\.net\/npm\/@iconify-json\/fa6-solid@[\d.]+\/icons\.json$/)
})

test('a set that failed to load is fetched again when next asked for', async () => {
  let down = true
  const { urls, fetchFn } = fetching(() => down)
  const logos = iconPacks(fetchFn).find(p => p.name === 'logos')
  await assert.rejects(logos.loader(), /503/)
  down = false
  assert.ok(await logos.loader())
  assert.equal(urls.length, 2)
})
