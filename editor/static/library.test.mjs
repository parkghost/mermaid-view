// node --test editor/static/library.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { byFolder, group, Library, when } from './library.js'

test('pages group by project, then session, keeping the newest first', () => {
  const pages = [
    { id: '3', project: 'gateway', session: 's2' },
    { id: '2', project: 'agent', session: 's1' },
    { id: '1', project: 'gateway', session: 's1' },
    { id: '0', project: '', session: '' },
  ]
  assert.deepEqual(
    group(pages).map(g => [g.project, g.sessions.map(s => [s.session, s.pages.map(p => p.id)])]),
    [
      [
        'gateway',
        [
          ['s2', ['3']],
          ['s1', ['1']],
        ],
      ],
      ['agent', [['s1', ['2']]]],
      ['', [['', ['0']]]],
    ],
  )
})

test('a page id reads as a local month/day and time', () => {
  assert.match(when('2026-10-11T07-09-36-825'), /^\d{1,2}\/\d{1,2} \d\d:\d\d$/)
  assert.equal(when('nonsense'), '')
})

test("byFolder groups a project's files by folder, in path order", () => {
  const files = [{ path: 'docs/b.md' }, { path: 'README.md' }, { path: 'docs/diagrams/x.mmd' }, { path: 'docs/a.md' }]
  assert.deepEqual(
    byFolder(files).map(g => [g.folder, g.files.map(f => f.path)]),
    [
      ['', ['README.md']],
      ['docs', ['docs/a.md', 'docs/b.md']],
      ['docs/diagrams', ['docs/diagrams/x.mmd']],
    ],
  )
})

// A browser's storage, and a sidebar with only what the library reads and writes of it.
const kept = new Map()
globalThis.localStorage = {
  getItem: k => kept.get(k) ?? null,
  setItem: (k, v) => kept.set(k, String(v)),
  removeItem: k => kept.delete(k),
}
globalThis.addEventListener ??= () => {} // the keys [ and ], on the window
function sidebar() {
  const element = () => ({
    innerHTML: '',
    hidden: false,
    value: '',
    classList: { toggle() {} },
    addEventListener() {},
    querySelector: () => null,
  })
  const parts = {}
  return {
    innerHTML: '',
    querySelector: sel => (parts[sel] ??= element()),
    querySelectorAll: () => [],
  }
}

// An API whose answers come when the test lets them: answer(path, body).
function slowApi() {
  const waiting = new Map()
  const api = path => new Promise(resolve => waiting.set(path.split('?')[0], resolve))
  const answer = async (path, body) => {
    for (let i = 0; i < 20 && !waiting.has(path); i++) await new Promise(r => setImmediate(r))
    assert.ok(waiting.has(path), `nothing asked for ${path}`)
    waiting.get(path)(body)
    waiting.delete(path)
    await new Promise(r => setImmediate(r))
  }
  return { api, answer }
}

const PROJECTS = {
  projects: [
    { id: 'A', name: 'a', root: '/a' },
    { id: 'B', name: 'b', root: '/b' },
  ],
}
const fileOf = path => ({ path, kind: 'markdown', count: 1, kinds: ['flowchart'] })
const filesKept = id => JSON.parse(kept.get(`mermaid-view.files.${id}`) ?? 'null')

test("a project's file list that comes late does not take the place of the project opened since", async () => {
  kept.clear()
  const { api, answer } = slowApi()
  const library = new Library(sidebar(), api, () => {})
  const showingA = library.show({ kind: 'file', projectId: 'A', diagrams: [] })
  await answer('/api/projects', PROJECTS)
  const showingB = library.show({ kind: 'file', projectId: 'B', diagrams: [] })
  await answer('/api/projects/B/files', { files: [fileOf('b.md')] })
  await answer('/api/projects/A/files', { files: [fileOf('a.md')] }) // A's, after B's
  await Promise.all([showingA, showingB])
  assert.match(library.list.innerHTML, /href="\/f\/B\?path=b\.md"/)
  assert.doesNotMatch(library.list.innerHTML, /a\.md/)
  assert.deepEqual(
    filesKept('B').map(f => f.path),
    ['b.md'],
  )
  assert.equal(filesKept('A'), null)
})

test('a file list that comes after the pages tab opened does not replace the pages', async () => {
  kept.clear()
  const { api, answer } = slowApi()
  const library = new Library(sidebar(), api, () => {})
  const files = library.show({ kind: 'file', projectId: 'A', diagrams: [] })
  await answer('/api/projects', PROJECTS)
  const pages = library.show({ kind: 'page', diagrams: [] })
  const page = {
    id: '2026-10-11T07-09-36-825',
    title: 'Gateway',
    project: 'a',
    session: '',
    tags: [],
    kinds: [],
    count: 1,
  }
  await answer('/api/pages', { pages: [page] })
  await answer('/api/projects/A/files', { files: [fileOf('a.md')] })
  await Promise.all([files, pages])
  assert.match(library.list.innerHTML, /Gateway/)
  assert.doesNotMatch(library.list.innerHTML, /a\.md/)
})

test('a file list grown too big to keep forgets the one kept when it was smaller', async () => {
  kept.clear()
  kept.set('mermaid-view.files.A', JSON.stringify([fileOf('old.md')]))
  const { api, answer } = slowApi()
  const library = new Library(sidebar(), api, () => {})
  const shown = library.show({ kind: 'file', projectId: 'A', diagrams: [] })
  await answer('/api/projects', PROJECTS)
  const many = Array.from({ length: 5000 }, (_, i) => fileOf(`docs/a-long-folder-name/file-${i}.md`))
  await answer('/api/projects/A/files', { files: many })
  await shown
  assert.equal(filesKept('A'), null)
})

test('the kept list of a project no longer registered is forgotten, not shown', async () => {
  kept.clear()
  kept.set('mermaid-view.files.GONE', JSON.stringify([fileOf('gone.md')]))
  const { api, answer } = slowApi()
  const library = new Library(sidebar(), api, () => {})
  const shown = library.show({ kind: 'file', projectId: 'GONE', diagrams: [] })
  await answer('/api/projects', PROJECTS)
  await answer('/api/projects/A/files', { files: [fileOf('a.md')] })
  await shown
  assert.equal(filesKept('GONE'), null)
  assert.match(library.list.innerHTML, /href="\/f\/A\?path=a\.md"/)
})
