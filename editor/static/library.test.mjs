// node --test editor/static/library.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { byFolder, group, when } from './library.js'

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
