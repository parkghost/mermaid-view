// node --test editor/static/i18n.test.mjs
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import { pickLang, t, translate } from './i18n.js'
import zhHant from './locale-zh-hant.js'

const dir = new URL('./', import.meta.url)

// Every t('...') with a literal text in the page's modules, and every text editor.html marks for
// translation: the file it is in, and whether it passes params (its {name} places are then filled).
function literalTexts() {
  const found = []
  for (const file of readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('locale-'))) {
    const source = readFileSync(new URL(file, dir), 'utf8')
    for (const m of source.matchAll(/\bt\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*(,?)/g)) {
      found.push({ file, text: Function(`return ${m[1]}`)(), params: m[2] === ',' })
    }
  }
  // The page's static text, translated by translatePage().
  const html = readFileSync(new URL('../editor.html', dir), 'utf8')
  for (const m of html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]*)"/g)) {
    found.push({ file: 'editor.html', text: m[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'), params: false })
  }
  return found
}

// The {name} places of a text a t() call with params fills.
const places = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()

test('every text the page translates has a Traditional Chinese translation', () => {
  const missing = literalTexts()
    .filter(({ text }) => !(text in zhHant))
    .map(({ file, text }) => ({ file, text }))
  assert.deepEqual(missing, [])
})

test("a translation keeps its text's {name} places, so the values still go in", () => {
  const broken = literalTexts()
    .filter(({ text, params }) => params && text in zhHant && places(text).join() !== places(zhHant[text]).join())
    .map(({ file, text }) => ({ file, text, zh: zhHant[text] }))
  assert.deepEqual(broken, [])
})

test('a browser in any Chinese reads Traditional Chinese; others read English; a choice wins', () => {
  assert.equal(pickLang('auto', ['zh-TW', 'en']), 'zh-Hant')
  assert.equal(pickLang('auto', ['zh-CN']), 'zh-Hant')
  assert.equal(pickLang('auto', ['fr-FR', 'en-US', 'zh-TW']), 'en')
  assert.equal(pickLang('auto', ['ja-JP']), 'en')
  assert.equal(pickLang('auto', []), 'en')
  assert.equal(pickLang('zh-Hant', ['en-US']), 'zh-Hant')
  assert.equal(pickLang('en', ['zh-TW']), 'en')
})

test('a text fills its places from params; without params, braces stay as written', () => {
  assert.equal(translate('zh-Hant', '{name}: saved', { name: '圖 1' }), '圖 1：已儲存')
  assert.equal(translate('en', '{name}: saved', { name: 'Diagram 1' }), 'Diagram 1: saved')
  assert.equal(translate('en', 'subgraph "${1:title}"\n\t$0\nend'), 'subgraph "${1:title}"\n\t$0\nend')
})

test('a text with no translation reads in English', () => {
  assert.equal(translate('zh-Hant', 'A text no catalog has'), 'A text no catalog has')
  assert.equal(t('Fix all'), 'Fix all') // node has no browser language: English
})
