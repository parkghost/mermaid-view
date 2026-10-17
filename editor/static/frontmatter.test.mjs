// node --test editor/static/frontmatter.test.mjs
// Front matter against Mermaid 12.1.0's config schema: what Mermaid would ignore or cannot use is
// a warning (a slip of one letter fixed to the option), nothing in Mermaid's docs examples is, and
// completion and hover offer the options and values the schema has.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { configCompletions, configFindings, configHover, frontMatter } from './frontmatter.js'
import { fixAll, lint } from './mermaid-lang.js'

const schema = JSON.parse(readFileSync(new URL('./config-schema.json', import.meta.url), 'utf8'))
const docs = JSON.parse(readFileSync(new URL('./docs-examples.json', import.meta.url), 'utf8'))
const fm = (yaml, body = 'flowchart LR\n  A --> B') => `---\n${yaml}\n---\n${body}`
const messages = text => configFindings(text, schema).map(f => `${f.line}: ${f.message}`)

test("no warning on any of Mermaid's docs examples with front matter", () => {
  const sources = docs.examples.map(e => e.text).filter(frontMatter)
  assert.ok(sources.length)
  for (const source of sources) assert.deepEqual(configFindings(source, schema), [], source)
})

test('an option Mermaid does not have is a warning, a one-letter slip fixed to the option', () => {
  const text = fm('config:\n  flowchart:\n    curv: basis\n    nodeSpacing: 40')
  const [f, ...rest] = configFindings(text, schema)
  assert.deepEqual(rest, [])
  assert.equal(f.line, 4)
  assert.match(f.message, /"curv" is not a Mermaid 12\.1\.0 option of config\.flowchart.*did you mean "curve"/)
  assert.equal(f.fix, '    curve: basis')
  assert.match(fixAll(text, { config: schema }), /\n {4}curve: basis\n/)
})

test('a swapped pair of letters is one slip too; a key far from every option gets no guess', () => {
  const [titel] = configFindings(fm('titel: Hello'), schema)
  assert.equal(titel.fix, 'title: Hello')
  const [far] = configFindings(fm('config:\n  colours: true'), schema)
  assert.equal(far.fix, undefined)
})

test("an unknown option's own entries are not reported again", () => {
  assert.equal(messages(fm('config:\n  flowchat:\n    curve: basis\n    padding: 2')).length, 1)
})

test('a value of the wrong type, or one an option does not take, is a warning', () => {
  assert.deepEqual(messages(fm('config:\n  look: sketch\n  flowchart:\n    nodeSpacing: wide\n    htmlLabels: yes')), [
    '3: config.look does not take "sketch": one of "classic", "handDrawn", "neo"',
    '5: config.flowchart.nodeSpacing takes a whole number, not a string ("wide")',
    '6: config.flowchart.htmlLabels takes a boolean or null, not a string ("yes")',
  ])
  assert.deepEqual(
    messages(
      fm('config:\n  look: handDrawn\n  fontSize: 14\n  flowchart:\n    nodeSpacing: 40\n    htmlLabels: false'),
    ),
    [],
  )
})

test('a mapping where a value goes, and a value where a mapping goes, are warnings', () => {
  assert.equal(messages(fm('config:\n  look:\n    x: 1')).length, 1)
  assert.match(messages(fm('config:\n  flowchart: basis'))[0], /config\.flowchart is a mapping/)
})

test('a key still being written (nothing under it yet) is not called a mapping', () => {
  assert.deepEqual(messages(fm('config:\n  flowchart:\n    curve:\ntitle: T')), [])
})

test('a secure option, which a diagram cannot set, and a top-level key Mermaid ignores, are warnings', () => {
  assert.match(messages(fm('config:\n  securityLevel: loose'))[0], /only the page that draws it can set it/)
  assert.match(messages(fm('author: me'))[0], /Mermaid ignores "author" in front matter/)
})

test('options that take any key, and options Mermaid sets only in its runtime defaults, pass', () => {
  assert.deepEqual(
    messages(
      fm(
        'config:\n  themeVariables:\n    primaryColor: "#f00"\n    anything: 1\n  treemap:\n    valueFormat: "$0,0"\n  elk:\n    preset: default',
      ),
    ),
    [],
  )
})

test('a string over lines and a block scalar are values, not keys', () => {
  assert.deepEqual(messages(fm('config:\n  themeCSS: " .a { fill: red }\n    .b { stroke: blue } "\n  look: neo')), [])
  assert.deepEqual(
    messages(fm('config:\n  themeCSS: |\n    .a { fill: red }\n    rect[id^=x] { height: 2px }\n  look: neo')),
    [],
  )
})

test('lint reports front matter only when given the schema', () => {
  const text = fm('config:\n  look: sketch')
  assert.ok(lint(text, { config: schema }).some(f => f.rule === 'config'))
  assert.ok(!lint(text).some(f => f.rule === 'config'))
})

test("completion offers an option's keys there, not those already written", () => {
  const text = fm('config:\n  flowchart:\n    curve: basis\n    ')
  const at = configCompletions(text, 5, 5, schema)
  assert.equal(at.kind, 'key')
  const labels = at.items.map(i => i.label)
  assert.ok(labels.includes('nodeSpacing'))
  assert.ok(!labels.includes('curve'))
  assert.match(at.items.find(i => i.label === 'nodeSpacing').doc, /\S/)
  const top = configCompletions(fm('config:\n  '), 3, 3, schema).items
  assert.ok(top.find(i => i.label === 'flowchart').mapping)
  assert.ok(!top.some(i => i.label === 'securityLevel')) // a diagram cannot set it
  assert.deepEqual(
    configCompletions(fm(''), 2, 1, schema)
      .items.map(i => i.label)
      .sort(),
    ['config', 'displayMode', 'title'],
  )
})

test('completion after `option: ` offers the values it takes; outside front matter, nothing', () => {
  const text = fm('config:\n  look: ')
  assert.deepEqual(
    configCompletions(text, 3, 9, schema).items.map(i => i.label),
    ['classic', 'handDrawn', 'neo'],
  )
  assert.equal(configCompletions(fm('config:\n  fontSize: '), 3, 13, schema).kind, 'none')
  assert.equal(configCompletions(text, 6, 3, schema), null)
  assert.equal(configCompletions('flowchart LR\n  A', 2, 3, schema), null)
})

test('hover on a key gives the option, its docs and what it takes', () => {
  const h = configHover(fm('config:\n  look: neo'), 3, 4, schema)
  assert.equal(h.name, 'config.look')
  assert.match(h.doc, /look/i)
  assert.match(h.doc, /"handDrawn"/)
  assert.equal(configHover(fm('config:\n  look: neo'), 3, 10, schema), null) // on the value, not the key
})
