import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import {
  kindOf,
  MERMAID,
  mermaidBlocks,
  page,
  projectPath,
  promptFor,
  SEARCH_NAME,
  TOOL_NAME,
  titleFor,
} from './register'

const ANSWER = [
  'Here is the flow:',
  '```mermaid',
  'flowchart TD',
  '    A["start"] -->|"go"| B["end"]',
  '```',
  'and some code:',
  '```ts',
  'const x = 1',
  '```',
  '```mermaid',
  'sequenceDiagram',
  '    A->>B: hi',
  '```',
].join('\n')

const turnEnd = (answer: string, agentId?: string) => ({
  answer,
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
  ...(agentId ? { agentId } : {}),
})

// The test stands for the engine: its fs and process hooks answer { value }.
const exited = (exitCode: number) => ({
  value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// The editor's answer to a request: 200 with this body.
const ok = (text: string) => ({ value: { status: 200, ok: true, headers: {}, text } })

// The engine side of a session in /home/tester whose editor starts on PORT 8771 and runs on; the
// argv of each start.
function editorRunning(on: On) {
  const spawned: (readonly string[])[] = []
  mock.env(on, { HOME: '/home/tester' })
  on('process.spawn', async function* ($, e) {
    spawned.push(e.argv)
    yield { stream: 'stdout' as const, text: 'PORT 8771\n' }
    await new Promise(() => {}) // the editor runs on
    return { value: { code: 0, signal: null } }
  })
  return spawned
}

// show() runs after the hook returns: let its awaits settle.
const settle = async (done: () => boolean = () => false) => {
  for (let i = 0; i < 2000 && !done(); i++) await Promise.resolve()
}

test('finds every mermaid block and nothing else', () => {
  expect(mermaidBlocks(ANSWER)).toEqual([
    'flowchart TD\n    A["start"] -->|"go"| B["end"]',
    'sequenceDiagram\n    A->>B: hi',
  ])
  expect(mermaidBlocks('no diagram here\n```ts\nx\n```')).toEqual([])
})

test('a block ends at a fence of its own on a line of its own, as CommonMark reads it', () => {
  const inline = 'flowchart TD\n  A["a ``` b"] --> B'
  const fenceLine = 'flowchart TD\n  A --> B\n```\n  %% the line above is no fence of this block'
  expect(mermaidBlocks(`\`\`\`mermaid\n${inline}\n\`\`\``)).toEqual([inline])
  expect(mermaidBlocks(`\`\`\`\`mermaid\n${fenceLine}\n\`\`\`\``)).toEqual([fenceLine])
  expect(mermaidBlocks('~~~mermaid\npie\n  "a": 1\n~~~')).toEqual(['pie\n  "a": 1'])
  expect(mermaidBlocks('1. item\n   ```mermaid\n   flowchart TD\n     A --> B\n   ```')).toEqual([
    'flowchart TD\n  A --> B',
  ])
  expect(mermaidBlocks('    ```mermaid\n    flowchart TD\n    ```')).toEqual([]) // indented code, not a fence
  expect(mermaidBlocks('````md\n```mermaid\nflowchart TD\n```\n````')).toEqual([]) // shown as an example
})

test('the page escapes the source mermaid.js reads back as text', () => {
  const html = page(['A-->B<br>'], 't')
  expect(html).toContain('A--&gt;B&lt;br&gt;')
  expect(html).toContain(MERMAID)
})

test('an answer with diagrams is written to a page and opened', async ($, on) => {
  const written: { path: string; text: string }[] = []
  const ran: (readonly string[])[] = []
  mock.env(on, { HOME: '/home/tester' })
  on('fs.write', ($, e) => {
    written.push(e)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    ran.push(e.argv)
    return exited(0)
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.turn.complete(turnEnd(ANSWER))
  await settle(() => ran.length > 0)

  const [file] = written
  expect(written.length).toBe(1)
  expect(file?.path).toMatch(/^\/home\/tester\/\.local\/share\/mermaid-view\/diagram-.*\.html$/)
  expect(file?.text).toContain('sequenceDiagram')
  expect(ran).toEqual([['wslview', file?.path]])
})

test('an answer without diagrams, or a subagent turn, opens nothing', async ($, on) => {
  let writes = 0
  on('fs.write', () => {
    writes++
    return { value: undefined }
  })
  on('process.run', () => exited(0))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.turn.complete(turnEnd('plain text'))
  await $.turn.complete(turnEnd(ANSWER, 'agent-1'))
  await settle()

  expect(writes).toBe(0)
})

test('with no opener it falls through each in turn', async ($, on) => {
  const tried: string[] = []
  mock.env(on, { HOME: '/home/tester' })
  on('fs.write', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    tried.push(e.argv[0] ?? '')
    return exited(1)
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.turn.complete(turnEnd(ANSWER))
  await settle(() => tried.length === 3)

  expect(tried).toEqual(['wslview', 'xdg-open', 'open'])
})

test('an editor that stops before listening says why, once, and the static page stands in', async ($, on) => {
  const written: string[] = []
  const toasts: string[] = []
  mock.env(on, { HOME: '/home/tester' })
  on('process.spawn', async function* () {
    yield { stream: 'stderr' as const, text: 'Traceback (most recent call last):\n' }
    yield { stream: 'stderr' as const, text: 'mermaid-view needs Python 3.9 or newer, not 3.8.20\n' }
    return { value: { code: 1, signal: null } }
  })
  on('fs.write', ($, e) => {
    written.push(e.path)
    return { value: undefined }
  })
  on('process.run', () => exited(0))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.turn.complete(turnEnd(ANSWER))
  await settle(() => written.length > 0)
  await $.turn.complete(turnEnd(ANSWER))
  await settle(() => written.length > 1)

  expect(written.every(path => path.endsWith('.html'))).toBe(true)
  const why = toasts.filter(text => text.includes('did not start'))
  expect(why.length).toBe(1)
  expect(why[0]).toContain('needs Python 3.9 or newer')
})

test('the prompt names the page, the note and the tool, in the language of the page that sent it', () => {
  const en = promptFor({ page: 'p1', note: ' change B to C ', lang: 'en' })
  expect(en).toContain('page p1')
  expect(en).toContain(': change B to C.')
  expect(en).toContain(TOOL_NAME)
  const zh = promptFor({ page: 'p1', note: ' 改成 C ', lang: 'zh-Hant' })
  expect(zh).toContain('頁面 p1')
  expect(zh).toContain('：改成 C請用')
  expect(zh).toContain(TOOL_NAME)
  // Without a note, no colon is left hanging; a page in no known language asks in English.
  expect(promptFor({ page: 'p1' })).toContain('in mermaid-view. Use')
  expect(promptFor({ page: 'p1', lang: 'zh-Hant' })).toContain('的圖。請用')
})

test('with the page server running, an answer becomes a page opened by its URL', async ($, on) => {
  editorRunning(on)
  const created: string[] = []
  const ran: (readonly string[])[] = []
  on('http.fetch', ($, e) => {
    if (e.url.endsWith('/api/pages')) created.push(String(e.init?.body ?? ''))
    return ok(e.url.endsWith('/api/pages') ? '{"id":"2026-10-11T07-09-36-825"}' : '{"shown":false}')
  })
  on('process.run', ($, e) => {
    ran.push(e.argv)
    return exited(0)
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.turn.complete(turnEnd(ANSWER))
  await settle(() => ran.length > 0)

  // The server writes and commits the page.
  expect(JSON.parse(created[0] ?? '{}').diagrams.length).toBe(2)
  expect(ran[0]?.[0]).toBe('wslview')
  expect(ran[0]?.[1]).toBe('http://localhost:8771/d/2026-10-11T07-09-36-825')
})

// A page's edit whose source holds a line of ```, and the editor's report of it (its fence longer).
const FENCE_LINE = 'flowchart TD\n  A --> C\n```'
const PAGE = {
  id: 'p1',
  diagrams: [
    { index: 0, original: 'flowchart TD\n  A --> B', edited: FENCE_LINE, diff: '-  A --> B\n+  A --> C\n+```' },
  ],
  report: `Page p1: 1 of 1 diagram(s) edited by the person.\n\nSource now:\n\`\`\`\`mermaid\n${FENCE_LINE}\n\`\`\`\``,
}

test("diagram_edits gives the editor's report of a page or a file, each source whole", async ($, on) => {
  const urls: string[] = []
  editorRunning(on)
  on('session.root', () => ({ value: '/home/tester/proj' }))
  on('http.fetch', ($, e) => {
    urls.push(e.url)
    return ok(
      JSON.stringify(
        e.url.includes('/api/projects') && !e.url.includes('/file?')
          ? { id: 'p1', name: 'proj', root: '/home/tester/proj' }
          : PAGE,
      ),
    )
  })
  for (const args of [{ page: 'p1' }, { file: 'docs/a.md' }]) {
    const called = await $.tool.call({ tool: TOOL_NAME, ...args } as never)
    const result = 'result' in called ? String(called.result) : ''
    expect(result).toBe(PAGE.report)
    expect(mermaidBlocks(result)).toEqual([FENCE_LINE])
  }
  expect(urls.filter(u => u.includes('/api/pages/p1') || u.includes('/file?')).every(u => /[?&]report=1/.test(u))).toBe(
    true,
  )
})

test("diagram_edits without a page reads this session's newest page, never another session's", async ($, on) => {
  editorRunning(on)
  on('session.id', () => ({ value: 'this-session' }))
  let pages = [{ id: 'theirs', session: 'another-session' }]
  const report = (id: string) => ({ id, report: `edited: A-->${id}` })
  on('http.fetch', ($, e) =>
    ok(
      JSON.stringify(e.url.endsWith('/api/pages') ? { pages } : report(new URL(e.url).pathname.split('/').pop() ?? '')),
    ),
  )

  const none = await $.tool.call({ tool: TOOL_NAME } as never)
  expect('result' in none && String(none.result)).not.toContain('A-->theirs')
  expect('result' in none && String(none.result)).toContain('give a page id')
  pages = [
    { id: 'theirs', session: 'another-session' },
    { id: 'mine', session: 'this-session' },
  ]
  const mine = await $.tool.call({ tool: TOOL_NAME } as never)
  expect('result' in mine && String(mine.result)).toContain('A-->mine')
})

test("diagram_search gives the editor's reports of pages and of the session's project files", async ($, on) => {
  let files = [{ path: 'docs/a.md' }]
  editorRunning(on)
  on('session.root', () => ({ value: '/home/tester/proj' }))
  on('http.fetch', ($, e) => {
    if (e.url.endsWith('/api/projects'))
      return ok(JSON.stringify({ id: 'p1', name: 'proj', root: '/home/tester/proj' }))
    if (e.url.includes('/files?')) return ok(JSON.stringify({ files, report: 'FILES REPORT' }))
    return ok(JSON.stringify({ pages: [{ id: 'x' }], report: 'PAGES REPORT' }))
  })
  const both = await $.tool.call({ tool: SEARCH_NAME, query: 'Router' } as never)
  expect('result' in both && both.result).toBe('PAGES REPORT\n\nFILES REPORT')
  files = []
  const pages = await $.tool.call({ tool: SEARCH_NAME, query: 'Router' } as never)
  expect('result' in pages && pages.result).toBe('PAGES REPORT')
})

test('a page is titled by the prose before its diagram, else by its kind and labels', () => {
  expect(titleFor('## 完整流程圖\n\n下面是架構：\n```mermaid\nflowchart TD\n```', ['flowchart TD'])).toBe('下面是架構')
  expect(titleFor('**整體架構**\n```mermaid\nx\n```', ['x'])).toBe('整體架構')
  expect(
    titleFor('```mermaid\nflowchart TD\n  A["喚醒詞"] --> B{"判斷"}\n```', [
      'flowchart TD\n  A["喚醒詞"] --> B{"判斷"}',
    ]),
  ).toBe('flowchart · 喚醒詞、判斷')
  expect(titleFor('Write ```mermaid in a fence:\n~~~mermaid\nflowchart TD\n~~~', ['flowchart TD'])).toBe(
    'Write mermaid in a fence',
  )
  expect(kindOf('%% note\nsequenceDiagram\n  A->>B: hi')).toBe('sequenceDiagram')
})

test(
  'the data folder option decides where pages go',
  { options: { dataDir: '~/notes/diagrams', keepDays: 0 } },
  async ($, on) => {
    const ran = editorRunning(on)
    on('fs.write', () => ({ value: undefined }))
    on('process.run', () => exited(0))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await $.turn.complete(turnEnd(ANSWER))
    await settle(() => ran.length > 0)

    const argv = ran[0] ?? []
    expect(argv[argv.indexOf('--root') + 1]).toBe('/home/tester/notes/diagrams')
    expect(argv[argv.indexOf('--keep-days') + 1]).toBe('0')
    expect(argv[argv.indexOf('--migrate-from') + 1]).toBe('/home/tester/.cache/mermaid-view')
    expect(argv).toContain('--exit-with-parent') // a server per session would outlive it otherwise
  },
)

test('a project path is relative to its root, and only inside it', () => {
  expect(projectPath('/w/proj', '/w/proj/docs/a.md')).toBe('docs/a.md')
  expect(projectPath('/w/proj/', '/w/proj/a.mmd')).toBe('a.mmd')
  expect(projectPath('/w/proj', '/w/project2/a.md')).toBeUndefined()
  expect(projectPath('/w/proj', '/w/proj')).toBeUndefined()
})

test('the prompt for a project file names the file and how to read it', () => {
  const text = promptFor({ file: 'docs/a.md', projectName: 'agent', note: '改了 Router' })
  expect(text).toContain('docs/a.md')
  expect(text).toContain('改了 Router')
  expect(text).toContain('file: "docs/a.md"')
})

// The engine side of a session in /home/tester/proj whose editor is running; `shown` is its
// answer to POST /api/show.
function projectSession(on: On, files: Record<string, string>, shown = false) {
  const posts: { url: string; body: string }[] = []
  const opened: string[] = []
  editorRunning(on)
  on('session.root', () => ({ value: '/home/tester/proj' }))
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }))
  on('http.fetch', ($, e) => {
    posts.push({ url: e.url, body: String(e.init?.body ?? '') })
    const value = e.url.endsWith('/api/projects')
      ? { id: 'p1', name: 'proj', root: '/home/tester/proj' }
      : e.url.endsWith('/api/show')
        ? { shown }
        : { ok: true, diagrams: 1 }
    return ok(JSON.stringify(value))
  })
  on('process.run', ($, e) => {
    opened.push(e.argv[1] ?? '')
    return exited(0)
  })
  return { posts, opened }
}

test('a project file Claude writes with diagrams opens once and is followed after', async ($, on) => {
  const doc = '# A\n```mermaid\nflowchart TD\n  A-->B\n```\n'
  const { posts, opened } = projectSession(on, {
    '/home/tester/proj/docs/a.md': doc,
    '/home/tester/proj/docs/plain.md': '# none\n',
  })
  on('tool.call', () => ({ result: 'ok' }))

  await $.tool.call({ tool: 'Write', file_path: '/home/tester/proj/docs/a.md', content: doc } as never)
  await settle(() => opened.length > 0)
  expect(opened).toEqual(['http://localhost:8771/f/p1?path=docs%2Fa.md'])
  const seen = posts.find(p => p.url.includes('/api/projects/p1/seen?path=docs%2Fa.md'))
  expect(seen && JSON.parse(seen.body).text).toBe(doc)

  await $.tool.call({
    tool: 'Edit',
    file_path: '/home/tester/proj/docs/a.md',
    old_string: 'B',
    new_string: 'C',
  } as never)
  await settle(() => posts.filter(p => p.url.includes('/seen?')).length > 1)
  expect(opened.length).toBe(1) // the open page follows the file by itself

  await $.tool.call({ tool: 'Write', file_path: '/home/tester/proj/docs/plain.md', content: '# none\n' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/home/tester/other/b.md', content: doc } as never)
  await $.tool.call({ tool: 'Write', file_path: '/home/tester/proj/src/x.ts', content: '' } as never)
  await settle()
  expect(opened.length).toBe(1)
  expect(posts.filter(p => p.url.includes('/seen?')).length).toBe(2)
})

test('a write the person refused, or one that failed, is not taken for what Claude wrote', async ($, on) => {
  const doc = '# A\n```mermaid\nflowchart TD\n  A-->PERSON\n```\n' // the person's edit, on disk
  const { posts, opened } = projectSession(on, { '/home/tester/proj/docs/a.md': doc })
  const answers = [
    { deny: 'The user refused' },
    { isError: true as const, result: 'File has been modified since read' },
  ]
  on('tool.call', () => answers.shift() ?? { result: 'ok' })
  await $.tool
    .call({ tool: 'Write', file_path: '/home/tester/proj/docs/a.md', content: 'x' } as never)
    .catch(() => undefined)
  await $.tool
    .call({ tool: 'Edit', file_path: '/home/tester/proj/docs/a.md', old_string: 'A', new_string: 'B' } as never)
    .catch(() => undefined)
  await settle()
  expect(posts.filter(p => p.url.includes('/seen?'))).toEqual([])
  expect(opened).toEqual([])
})

test("a note about another project's file reads that project's file", async ($, on) => {
  expect(promptFor({ file: 'docs/a.md', project: 'b2', projectName: 'other', note: '' })).toContain(
    'file: "docs/a.md", project: "b2"',
  )
  const { posts } = projectSession(on, {})
  await $.tool.call({ tool: TOOL_NAME, file: 'docs/a.md', project: 'b2' } as never)
  expect(posts.some(p => p.url.startsWith('http://127.0.0.1:8771/api/projects/b2/file?path=docs%2Fa.md'))).toBe(true)
})

test('with openFiles off a written file is noted but not opened', { options: { openFiles: false } }, async ($, on) => {
  const doc = 'flowchart TD\n  A-->B\n'
  const { posts, opened } = projectSession(on, { '/home/tester/proj/d/x.mmd': doc })
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Write', file_path: '/home/tester/proj/d/x.mmd', content: doc } as never)
  await settle(() => posts.some(p => p.url.includes('/seen?')))
  await settle()
  expect(opened).toEqual([])
})

test('a project file Claude writes shows in the open tab when one takes it', async ($, on) => {
  const doc = 'flowchart TD\n  A-->B\n'
  const { posts, opened } = projectSession(on, { '/home/tester/proj/d/x.mmd': doc }, true)
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Write', file_path: '/home/tester/proj/d/x.mmd', content: doc } as never)
  await settle(() => posts.some(p => p.url.endsWith('/api/show')))
  await settle()
  const show = posts.find(p => p.url.endsWith('/api/show'))
  expect(show && JSON.parse(show.body).url).toBe('/f/p1?path=d%2Fx.mmd')
  expect(opened).toEqual([])
})

// The engine side of a session whose editor runs and answers POST /api/show with `show`.
function editorSession(on: On, show: (url: string) => { status: number; text: string }) {
  const ran: (readonly string[])[] = []
  const toasts: string[] = []
  const shows: string[] = []
  editorRunning(on)
  on('fs.write', () => ({ value: undefined }))
  on('http.fetch', ($, e) => {
    if (e.url.endsWith('/api/pages')) return ok('{"id":"2026-10-11T07-09-36-825"}')
    if (!e.url.endsWith('/api/show')) return ok('{"ok":true}')
    shows.push(String(e.init?.body ?? ''))
    const { status, text } = show(e.url)
    return { value: { status, ok: status === 200, headers: {}, text } }
  })
  on('process.run', ($, e) => {
    ran.push(e.argv)
    return exited(0)
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { ran, toasts, shows }
}

test('a new page shows in the open tab when one takes it, and opens nothing', async ($, on) => {
  const { ran, toasts, shows } = editorSession(on, () => ({ status: 200, text: '{"shown":true}' }))
  await $.turn.complete(turnEnd(ANSWER))
  await settle(() => toasts.length > 0)
  expect(JSON.parse(shows[0] ?? '{}').url).toMatch(/^\/d\/[^/]+$/)
  expect(toasts[0]).toContain('showed 2 diagrams in the open tab')
  expect(ran.filter(argv => argv[0] === 'wslview')).toEqual([])
})

test('a new page opens a tab when no open tab takes it, or the editor cannot say', async ($, on) => {
  const answers = [
    { status: 200, text: '{"shown":false}' },
    { status: 500, text: 'oops' },
  ]
  const { ran, toasts } = editorSession(on, () => answers.shift() ?? { status: 200, text: '{"shown":false}' })
  await $.turn.complete(turnEnd(ANSWER))
  await settle(() => toasts.length > 0)
  await $.turn.complete(turnEnd(ANSWER))
  await settle(() => toasts.length > 1)
  const opened = ran.filter(argv => argv[0] === 'wslview')
  expect(opened.length).toBe(2)
  expect(opened[0]?.[1]).toMatch(/^http:\/\/localhost:8771\/d\/[^/]+$/)
  for (const toast of toasts) expect(toast).toContain('opened 2 diagrams')
})

test('with reuseTab off a new page always opens a tab', { options: { reuseTab: false } }, async ($, on) => {
  const { ran, toasts, shows } = editorSession(on, () => ({ status: 200, text: '{"shown":true}' }))
  await $.turn.complete(turnEnd(ANSWER))
  await settle(() => toasts.length > 0)
  expect(shows).toEqual([])
  expect(ran.filter(argv => argv[0] === 'wslview').length).toBe(1)
})

test('a new page waits in an open tab with edits in progress instead of opening another', async ($, on) => {
  const { ran, toasts } = editorSession(on, () => ({ status: 200, text: '{"shown":true,"offered":true}' }))
  await $.turn.complete(turnEnd(ANSWER))
  await settle(() => toasts.length > 0)
  expect(toasts[0]).toContain('waiting in the open tab')
  expect(ran.filter(argv => argv[0] === 'wslview')).toEqual([])
})

// The person types /mermaid at the prompt.
const typedMermaid = {
  command: 'mermaid',
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
}

test('/mermaid shows the last page in the open tab, and opens a tab only when none takes it', async ($, on) => {
  const answers = [
    { status: 200, text: '{"shown":false}' },
    { status: 200, text: '{"shown":true}' },
    { status: 200, text: '{"shown":false}' },
  ]
  const { ran, toasts, shows } = editorSession(on, () => answers.shift() ?? { status: 200, text: '{"shown":false}' })
  await $.turn.complete(turnEnd(ANSWER))
  await settle(() => toasts.length > 0) // no tab yet: it opened one
  const page = JSON.parse(shows[0] ?? '{}').url
  const shown = await $.command.run(typedMermaid)
  expect(JSON.parse(shows[1] ?? '{}').url).toBe(page)
  expect(shown.text).toMatch(/^Showed .* in the open tab$/)
  expect(ran.filter(argv => argv[0] === 'wslview').length).toBe(1)
  await $.command.run(typedMermaid) // the tab was closed since
  expect(ran.filter(argv => argv[0] === 'wslview').length).toBe(2)
})

test('/mermaid with nothing shown yet opens the editor on the project files', async ($, on) => {
  const { opened } = projectSession(on, {})
  const out = await $.command.run(typedMermaid)
  expect(opened).toEqual(['http://localhost:8771/f/p1'])
  expect(out.text).toContain('Opened')
})

test('/mermaid with nothing shown and no editor says so, and opens nothing', async ($, on) => {
  const ran: (readonly string[])[] = []
  // biome-ignore lint/correctness/useYield: python3 is missing, so the editor yields nothing
  on('process.spawn', async function* () {
    throw new Error('python3: not found')
  })
  on('process.run', ($, e) => {
    ran.push(e.argv)
    return exited(0)
  })
  const out = await $.command.run(typedMermaid)
  expect(out.text).toContain('not running')
  expect(ran).toEqual([])
})

test('a note the prompt box refuses is acknowledged undelivered, and filled on a later poll', async ($, on) => {
  const clock = mock.clock(on)
  const note = { id: 'n1', page: 'p1', note: '改成 C' }
  const acks: unknown[] = []
  const toasts: string[] = []
  const fills: string[] = []
  let waiting = true // the note stays the server's next until acknowledged delivered
  editorRunning(on)
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => exited(0))
  on('http.fetch', ($, e) => {
    if (e.url.endsWith('/api/pages')) return ok('{"id":"p1"}')
    if (e.url.endsWith('/api/outbox/take')) return ok(JSON.stringify({ item: waiting ? note : null }))
    if (e.url.endsWith('/api/outbox/ack')) {
      const ack = JSON.parse(String(e.init?.body ?? '{}'))
      acks.push(ack)
      if (ack.filled) waiting = false
      return ok('{"ok":true}')
    }
    return ok('{"shown":true}')
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  let dialog = true
  on('prompt.fill', ($, e) => {
    if (dialog) return { isFilled: false, refusal: 'dialog' as const }
    fills.push(e.text)
    return { isFilled: true }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await $.turn.complete(turnEnd(ANSWER)) // starts the editor, and the polling with it
  await clock.settle()

  await clock.advance(1500)
  expect(acks).toEqual([{ id: 'n1', filled: false }])
  expect(fills).toEqual([])
  dialog = false
  await clock.advance(1500)
  expect(acks).toEqual([
    { id: 'n1', filled: false },
    { id: 'n1', filled: true },
  ])
  expect(fills.length).toBe(1)
  expect(fills[0]).toContain('改成 C')
  expect(toasts).toContain('Mermaid: your edits are in the prompt box; press Enter to send')
})
