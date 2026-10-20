// Mermaid diagrams in an answer, viewed and edited in the browser, and the edits back to Claude.
//
// The editor (editor/mermaid_view.py, a program of its own) runs for the session on 127.0.0.1;
// this mod is Claude Code's side of it:
//   - when a main-loop turn ends with ```mermaid blocks, they become a page of the editor, shown
//     in a tab already open on it when there is one (option reuseTab; a tab with edits in
//     progress offers it instead of switching), else in a new tab;
//   - the session's project is registered with it, so its Markdown documents and .mmd files open
//     there too, and when Claude writes one that holds diagrams, it opens (once per file) and
//     follows the file from then on;
//   - the model reads the person's edits, with their diffs, through diagram_edits (a page's, or a
//     project file's), and finds earlier diagrams through diagram_search; a note sent from a
//     page puts a prompt asking for that into the input box, in the page's language.
// Without python3 a page is a static file. /mermaid shows the last page again, the same way, or
// with nothing shown yet, the editor itself: the session's project files, else its latest page.
import type { EngineInterface, Register } from 'claude-code'

export const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.esm.min.mjs'
// Tried in order: WSL (the Windows browser), Linux desktops, macOS.
const OPENERS = [['wslview'], ['xdg-open'], ['open']]
// The same port across reloads keeps open pages working; the server takes any free one if busy.
const PORT = 8771
const TOOL = 'diagram_edits'
export const TOOL_NAME = 'mcp__mermaid-view__diagram_edits' // mcp__<plugin>__<TOOL>
const SEARCH = 'diagram_search'
export const SEARCH_NAME = 'mcp__mermaid-view__diagram_search'
// The plugin's options (plugin.json userConfig), as register() receives them.
type Options = { dataDir: string; keepDays: number; openFiles: boolean; reuseTab: boolean }
let config: Options = { dataDir: '~/.local/share/mermaid-view', keepDays: 90, openFiles: true, reuseTab: true }
// The project files the editor opens: Markdown documents and diagram files.
const DIAGRAM_FILE = /\.(md|markdown|mdx|mmd|mermaid)$/i
// Where pages were kept before the data folder became an option: moved once into it.
const FORMER_ROOT = '~/.cache/mermaid-view'
const POLL_MS = 1500
const NO_SERVER = 'The mermaid-view page server is not running (python3 missing?)'

// Module state: a reload starts without it (and the reload ended the server it started).
let port: number | undefined
let starting: Promise<number | undefined> | undefined
let polling = false
let warned = false // the editor failed to start, and the person was told why (once a module life)
let delivering = false // a note on its way into the prompt box
let lastPage: string | undefined // a URL or a file path
let project: Promise<ProjectInfo | undefined> | undefined // the session's project, registered with the editor
const openedFiles = new Set<string>() // project files opened this session (each opens once)

type ProjectInfo = { id: string; name: string; root: string }

// A code fence's opening line as CommonMark reads it: up to three spaces, a run of three or more
// ` or ~, then the info string (a ` fence's holds no `). Its closing line: up to three spaces, a run
// of the same character at least as long, then only spaces or tabs (editor/fences.py).
const OPENING = /^( {0,3})(`{3,}|~{3,})(.*)$/
const CLOSING = /^ {0,3}(`+|~+)[ \t]*$/

/**
 * The ```mermaid (or ~~~mermaid) blocks of Markdown text as CommonMark reads them, in order: the
 * index of each one's opening line and its source, the fence's indentation taken off its lines. A
 * block of another language hides what it holds; a block left open runs to the end of the text.
 */
function mermaidFences(text: string): { line: number; source: string }[] {
  const lines = text.split(/\r?\n/)
  const found: { line: number; source: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const [, indent = '', fence = '', info = ''] = OPENING.exec(lines[i] ?? '') ?? []
    if (!fence || (fence[0] === '`' && info.includes('`'))) continue
    let end = i + 1
    while (end < lines.length && !closes(lines[end] ?? '', fence)) end++
    if (/^[ \t]*mermaid\b/.test(info)) {
      const body = lines.slice(i + 1, end).map(l => l.slice(Math.min(indent.length, /^ */.exec(l)?.[0].length ?? 0)))
      found.push({ line: i, source: body.join('\n') })
    }
    i = end
  }
  return found
}

function closes(line: string, fence: string): boolean {
  const run = CLOSING.exec(line)?.[1] ?? ''
  return run[0] === fence[0] && run.length >= fence.length
}

/** The source of each ```mermaid block in text, in order. */
export function mermaidBlocks(text: string): string[] {
  return mermaidFences(text)
    .map(f => f.source.trim())
    .filter(Boolean)
}

const escapeHtml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** A static page of the diagrams, for when the page server cannot run. */
export function page(diagrams: readonly string[], title: string): string {
  const figures = diagrams
    .map((d, i) => `<figure><figcaption>${i + 1}</figcaption><pre class="mermaid">${escapeHtml(d)}</pre></figure>`)
    .join('\n')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 24px; background: Canvas; color: CanvasText; }
  figure { margin: 0 0 32px; overflow-x: auto; }
  figcaption { opacity: .6; font-size: 12px; margin-bottom: 8px; }
</style></head>
<body>
${figures}
<script type="module">
  import mermaid from '${MERMAID}'
  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' })
  await mermaid.run({ querySelector: 'pre.mermaid', suppressErrors: true })
</script>
</body></html>
`
}

/** A diagram's kind: the first word of its first line that is not a comment ("flowchart"). */
export function kindOf(diagram: string): string {
  const first = diagram.split('\n').find(l => l.trim() && !l.trim().startsWith('%%')) ?? ''
  return first.trim().split(/\s+/)[0] ?? ''
}

/**
 * A page's title: the answer's last line of prose before its first diagram (a heading or the
 * sentence that introduces it), without markdown; else the kind and the first node labels.
 */
export function titleFor(answer: string, diagrams: readonly string[]): string {
  const line = answer
    .split(/\r?\n/)
    .slice(0, mermaidFences(answer)[0]?.line ?? 0)
    .map(l =>
      l
        .replace(/^\s*(#+|>|[-*]|\d+\.)\s*/, '')
        .replace(/[*`_]/g, '')
        .trim(),
    )
    .filter(Boolean)
    .pop()
  if (line) return line.replace(/[：:]\s*$/, '').slice(0, 80)
  const first = diagrams[0] ?? ''
  const labels = [...first.matchAll(/\[\s*"([^"]+)"|\{\s*"([^"]+)"|\(\s*"([^"]+)"/g)]
    .map(m => m[1] ?? m[2] ?? m[3])
    .slice(0, 3)
  return [kindOf(first), labels.join('、')].filter(Boolean).join(' · ').slice(0, 80)
}

async function expandHome($: EngineInterface, path: string): Promise<string> {
  return path.startsWith('~') ? `${(await $.env.get('HOME')) ?? '/tmp'}${path.slice(1)}` : path
}

/** The data folder: pages, edits and their git history. */
function dataRoot($: EngineInterface): Promise<string> {
  return expandHome($, config.dataDir)
}

/** A JSON POST to the editor on port `p`; it rejects when the editor cannot be reached. */
function postJson($: EngineInterface, p: number, path: string, body: string) {
  return $.http.fetch(`http://127.0.0.1:${p}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

async function openInBrowser($: EngineInterface, target: string): Promise<boolean> {
  for (const opener of OPENERS) {
    const ran = await $.process.run([...opener, target], { timeoutMs: 10_000 }).catch(() => undefined)
    if (ran?.exitCode === 0) return true
  }
  return false
}

/**
 * Shows an editor page (its path, "/d/<id>") in a tab already open on the editor (editor/viewers.py
 * picks it): 'shown' when the tab switched to it, 'offered' when the tab has edits in progress and
 * offers it instead; undefined when no tab took it (or the editor cannot say): open one then.
 */
async function showInOpenTab($: EngineInterface, p: number, path: string): Promise<'shown' | 'offered' | undefined> {
  const res = await postJson($, p, '/api/show', JSON.stringify({ url: path })).catch(() => undefined)
  if (!res?.ok) return undefined
  try {
    const out = JSON.parse(res.text) as { shown?: unknown; offered?: unknown }
    return out.shown !== true ? undefined : out.offered === true ? 'offered' : 'shown'
  } catch {
    return undefined
  }
}

// Where the open tab is among many: its icon carries a red dot until it is seen, and the browser's
// tab search (Ctrl+Shift+A in Chrome and Edge) finds it by its title.
const FIND_TAB = 'red dot on its tab icon; Ctrl+Shift+A finds it'

/** The toast for what showInOpenTab did with `what` ("2 diagrams", a file's path). */
function inOpenTab(what: string, outcome: 'shown' | 'offered'): string {
  return outcome === 'shown'
    ? `Mermaid: showed ${what} in the open tab (${FIND_TAB})`
    : `Mermaid: ${what} waiting in the open tab, which has edits in progress (${FIND_TAB})`
}

/** Tells the person, once, that the editor did not start and why; the static page stands in. */
function warnNoEditor($: EngineInterface, why: string): void {
  if (warned) return
  warned = true
  $.ui.toast(`Mermaid: the editor did not start (${why.slice(0, 160)}); diagrams open as a static page`)
}

/** The page server's port, starting it the first time; undefined when it cannot run. */
function ensureServer($: EngineInterface): Promise<number | undefined> {
  if (port !== undefined) return Promise.resolve(port)
  starting ??= new Promise(resolve => {
    void (async () => {
      let out = ''
      let err = '' // the end of what it wrote to stderr: why it did not start, when it did not
      let listening = false
      try {
        const child = $.process.spawn({
          argv: [
            'python3',
            '-I',
            `${$.plugin.root}/editor/mermaid_view.py`,
            '--root',
            await dataRoot($),
            '--port',
            String(PORT),
            '--keep-days',
            String(config.keepDays),
            '--migrate-from',
            await expandHome($, FORMER_ROOT),
            '--exit-with-parent',
          ], // the server ends with Claude Code, not a server per session left behind
        })
        // The loop is the child's life: it runs on after resolving, until the server or the module ends.
        for await (const piece of child) {
          if (listening) continue
          if (piece.stream === 'stderr') {
            err = (err + piece.text).slice(-2048)
            continue
          }
          out = (out + piece.text).slice(-2048)
          const found = /PORT (\d+)/.exec(out)
          if (found) {
            listening = true
            port = Number(found[1])
            resolve(port)
            startPolling($)
          }
        }
        if (!listening) warnNoEditor($, err.trim().split('\n').pop() || 'it stopped before listening')
      } catch {
        // no python3: the static page stands in
        warnNoEditor($, 'python3 was not found')
      } finally {
        port = undefined
        starting = undefined
        resolve(undefined) // no effect once resolved with the port
      }
    })()
  })
  return starting
}

// A note sent from a page waits in the server's outbox: put the request in the prompt box.
function startPolling($: EngineInterface): void {
  if (polling) return
  polling = true
  $.clock.every(POLL_MS, () => void takeOutbox($))
}

type OutboxItem = {
  page?: string
  file?: string
  project?: string
  projectName?: string
  note?: string
  lang?: string // the page's language (editor/static/i18n.js): 'zh-Hant', else English
}

/** The request put in the prompt box for a note, in the language of the page that sent it. */
export function promptFor(item: OutboxItem): string {
  const zh = item.lang === 'zh-Hant'
  const text = item.note?.trim()
  if (item.file) {
    // The file's project by its id: it need not be the session's (the editor lists every project).
    const args = item.project ? `file: "${item.file}", project: "${item.project}"` : `file: "${item.file}"`
    return zh
      ? `我在 mermaid-view 修改了專案 ${item.projectName ?? ''} 的 ${item.file} 裡的圖${text ? `：${text}` : '。'}請用 ${TOOL_NAME}（${args}）讀回修改，比對差異並校正相關的說明。`
      : `I edited the diagrams in ${item.file} of project ${item.projectName ?? ''} in mermaid-view${text ? `: ${text}` : ''}. Use ${TOOL_NAME} (${args}) to read the edits back, compare the differences and correct the related text.`
  }
  return zh
    ? `我在 mermaid-view 修改了頁面 ${item.page} 的圖${text ? `：${text}` : '。'}請用 ${TOOL_NAME} 讀回修改，比對差異並校正。`
    : `I edited the diagrams of page ${item.page} in mermaid-view${text ? `: ${text}` : ''}. Use ${TOOL_NAME} to read the edits back, compare the differences and correct.`
}

// The next note stays the server's next until acknowledged filled: one the box refuses (a dialog
// holds the keys, no box) is tried again on the next poll, and the tab that sent it hears so.
async function takeOutbox($: EngineInterface): Promise<void> {
  if (port === undefined || delivering) return
  delivering = true // a poll still filling must not hand the same note to the box twice
  const p = port // the server that hands out the note hears whether it was filled
  try {
    const post = (path: string, body: string) => postJson($, p, `/api/outbox/${path}`, body).catch(() => undefined)
    const res = await post('take', '{}')
    if (!res?.ok) return
    const { item } = JSON.parse(res.text) as { item: (OutboxItem & { id: string }) | null }
    if (!item) return
    const filled = await $.prompt
      .fill({ text: promptFor(item), mode: 'append' })
      .then(r => r.isFilled)
      .catch(() => false)
    await post('ack', JSON.stringify({ id: item.id, filled }))
    if (filled) $.ui.toast('Mermaid: your edits are in the prompt box; press Enter to send')
  } finally {
    delivering = false
  }
}

// Where the answer was given: the project (its root, named by its last folder), the git branch
// and the session. Each part is "" when it cannot be told.
async function origin($: EngineInterface) {
  const root = await $.session.root().catch(() => '')
  const [ran, session] = await Promise.all([
    root
      ? $.process
          .run(['git', '-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 })
          .catch(() => undefined)
      : undefined,
    $.session.id().catch(() => ''),
  ])
  return {
    projectRoot: root,
    project: root.split('/').filter(Boolean).pop() ?? '',
    branch: ran?.exitCode === 0 ? ran.stdout.trim() : '',
    session,
  }
}

/** A new page of the editor holding the diagrams (the server writes and commits it); its id, or
 * undefined when the editor cannot take it. */
async function createPage(
  $: EngineInterface,
  p: number,
  diagrams: readonly string[],
  answer: string,
): Promise<string | undefined> {
  const body = JSON.stringify({ diagrams, title: titleFor(answer, diagrams), ...(await origin($)) })
  const res = await postJson($, p, '/api/pages', body).catch(() => undefined)
  if (!res?.ok) return undefined
  try {
    const { id } = JSON.parse(res.text) as { id?: unknown }
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

async function show($: EngineInterface, diagrams: readonly string[], answer = ''): Promise<void> {
  const p = await ensureServer($)
  const id = p === undefined ? undefined : await createPage($, p, diagrams, answer)
  const count = diagrams.length === 1 ? '1 diagram' : `${diagrams.length} diagrams`
  let target: string
  let outcome: 'shown' | 'offered' | undefined
  if (p !== undefined && id !== undefined) {
    target = `http://localhost:${p}/d/${id}`
    outcome = config.reuseTab ? await showInOpenTab($, p, `/d/${id}`) : undefined
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
    target = `${await dataRoot($)}/diagram-${stamp}.html`
    await $.fs.write(target, page(diagrams, `Mermaid ${stamp}`))
  }
  lastPage = target
  if (outcome) {
    $.ui.toast(inOpenTab(count, outcome))
    return
  }
  const opened = await openInBrowser($, target)
  $.ui.toast(opened ? `Mermaid: opened ${count} in the browser` : `Mermaid: ${count} at ${target}`)
}

/** The session's project, registered with the editor once; undefined without a project or editor. */
function sessionProject($: EngineInterface): Promise<ProjectInfo | undefined> {
  project ??= (async () => {
    const p = await ensureServer($)
    const root = await $.session.root().catch(() => '')
    if (p === undefined || !root) return undefined
    const res = await postJson($, p, '/api/projects', JSON.stringify({ root })).catch(() => undefined)
    return res?.ok ? (JSON.parse(res.text) as ProjectInfo) : undefined
  })()
  return project
}

/** The editor's own page for a session with nothing shown yet: the session's project files, else
 * its pages (the latest one); undefined when the editor cannot run. */
async function editorHome($: EngineInterface): Promise<string | undefined> {
  const info = await sessionProject($)
  const p = await ensureServer($)
  return p === undefined ? undefined : `http://localhost:${p}${info ? `/f/${info.id}` : '/d'}`
}

/**
 * What /mermaid shows: the last page, at the editor's port now (one that ended starts again, on
 * another port when its own is taken), or a static page's file as it is; with nothing shown yet,
 * the editor's own page. Undefined when the editor cannot run.
 */
async function lastTarget($: EngineInterface): Promise<string | undefined> {
  const page = lastPage && /^http:\/\/localhost:\d+(\/.*)$/.exec(lastPage)
  if (!page) return lastPage ?? editorHome($)
  const p = await ensureServer($)
  return p === undefined ? undefined : `http://localhost:${p}${page[1]}`
}

/** A path inside the project, relative to its root; undefined outside it. */
export function projectPath(root: string, path: string): string | undefined {
  const base = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(base) && path.length > base.length ? path.slice(base.length) : undefined
}

/**
 * Claude wrote a project file: when it holds diagrams, the editor keeps what Claude wrote (the
 * base its later edits compare with) and, the first time this session, opens it.
 */
async function noteWrite($: EngineInterface, path: string): Promise<void> {
  if (!DIAGRAM_FILE.test(path)) return
  const info = await sessionProject($)
  const rel = info && projectPath(info.root, path)
  if (!info || !rel || port === undefined) return
  const text = await $.fs.read(path)
  if (!/\.(mmd|mermaid)$/i.test(path) && !mermaidFences(text).length) return
  // Not caught: an editor that cannot be reached fails the note, which its caller lets pass.
  const res = await postJson(
    $,
    port,
    `/api/projects/${info.id}/seen?path=${encodeURIComponent(rel)}`,
    JSON.stringify({ text }),
  )
  if (!res.ok || !(JSON.parse(res.text) as { diagrams: number }).diagrams) return
  const pagePath = `/f/${info.id}?path=${encodeURIComponent(rel)}`
  const url = `http://localhost:${port}${pagePath}`
  lastPage = url
  if (!config.openFiles || openedFiles.has(rel)) return // an open page follows the file by itself
  openedFiles.add(rel)
  const outcome = config.reuseTab ? await showInOpenTab($, port, pagePath) : undefined
  if (outcome) {
    $.ui.toast(inOpenTab(rel, outcome))
    return
  }
  const opened = await openInBrowser($, url)
  $.ui.toast(opened ? `Mermaid: opened ${rel}` : `Mermaid: ${rel} at ${url}`)
}

/** The report of an editor reply asked for with report=1: the text the model reads, rendered by the
 * editor (editor/mcp_tools.py) for this mod's tools. */
function reportOf(text: string): string {
  return (JSON.parse(text) as { report: string }).report
}

async function readFileEdits($: EngineInterface, file: string, projectId: string): Promise<string> {
  if (projectId) {
    // A note from the editor names the file's project, which need not be the session's.
    const p = await ensureServer($)
    if (p === undefined) return `${NO_SERVER}, so no edits can be read.`
    return fileEdits($, p, projectId, file)
  }
  const info = await sessionProject($)
  if (!info || port === undefined)
    return 'The mermaid-view editor has no project for this session (python3 missing, or no project folder).'
  const rel = file.startsWith('/') ? projectPath(info.root, file) : file
  if (!rel) return `${file} is not inside the project ${info.root}.`
  return fileEdits($, port, info.id, rel)
}

async function fileEdits($: EngineInterface, p: number, projectId: string, rel: string): Promise<string> {
  const res = await $.http.fetch(
    `http://127.0.0.1:${p}/api/projects/${encodeURIComponent(projectId)}/file?${new URLSearchParams({ path: rel, report: '1' })}`,
  )
  if (!res.ok) return `No document or diagram file ${rel} in the project.`
  return reportOf(res.text)
}

async function readEdits($: EngineInterface, pageId: string | undefined): Promise<string> {
  const p = await ensureServer($)
  if (p === undefined) return `${NO_SERVER}, so no edits can be read.`
  const base = `http://127.0.0.1:${p}/api/pages`
  let id = pageId
  if (!id) {
    // This session's newest page: another session's, newer or not, is not the one the person means.
    const session = await $.session.id().catch(() => '')
    const list = await $.http.fetch(base)
    id = session
      ? (JSON.parse(list.text) as { pages: { id: string; session?: string }[] }).pages.find(p => p.session === session)
          ?.id
      : undefined
    if (!id) return `No mermaid-view page of this session yet; give a page id (find one with ${SEARCH_NAME}).`
  }
  const res = await $.http.fetch(`${base}/${encodeURIComponent(id)}?report=1`)
  if (!res.ok) return `No mermaid-view page "${id}".`
  return reportOf(res.text)
}

async function search($: EngineInterface, query: string, project: string): Promise<string> {
  const p = await ensureServer($)
  if (p === undefined) return `${NO_SERVER}, so pages cannot be searched.`
  // The project files are looked up alongside the pages, but awaited only once the pages are in,
  // so a failed page search answers first (and leaves the lookup's own failure unheard).
  const files = searchFiles($, p, query, project)
  files.catch(() => undefined)
  const params = new URLSearchParams({ q: query, project, report: '1' })
  const res = await $.http.fetch(`http://127.0.0.1:${p}/api/pages?${params}`)
  if (!res.ok) return `The search failed (${res.status}).`
  const pages = reportOf(res.text)
  const report = await files
  return report ? `${pages}\n\n${report}` : pages
}

/** The session's project files of a search, when it is not about another project; undefined when none match. */
async function searchFiles($: EngineInterface, p: number, query: string, project: string): Promise<string | undefined> {
  const info = await sessionProject($)
  if (!info || (project && project !== info.name)) return undefined
  const found = await $.http
    .fetch(`http://127.0.0.1:${p}/api/projects/${info.id}/files?${new URLSearchParams({ q: query, report: '1' })}`)
    .catch(() => undefined)
  if (!found?.ok) return undefined
  const { files, report } = JSON.parse(found.text) as { files: unknown[]; report: string }
  return files.length ? report : undefined
}

export const register: Register = (on, options) => {
  const given = options as Partial<Options> | undefined
  config = {
    dataDir: typeof given?.dataDir === 'string' && given.dataDir.trim() ? given.dataDir.trim() : config.dataDir,
    keepDays: typeof given?.keepDays === 'number' && given.keepDays >= 0 ? given.keepDays : config.keepDays,
    openFiles: typeof given?.openFiles === 'boolean' ? given.openFiles : config.openFiles,
    reuseTab: typeof given?.reuseTab === 'boolean' ? given.reuseTab : config.reuseTab,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mermaid',
      description: 'Open the Mermaid editor on the last diagrams, else on the project files',
    })
    await $.tool.register({
      name: TOOL,
      description:
        "Reads the person's edits to Mermaid diagrams made in the mermaid-view browser editor: those of an " +
        "earlier answer's page (per edited diagram a unified diff against the source you wrote, and the " +
        'edited source), or those of a project file, a Markdown document or .mmd file (per diagram what ' +
        'changed since you last wrote the file, else since the last commit). Use it when the person says ' +
        'they edited or adjusted a diagram, then compare and correct.',
      inputSchema: {
        type: 'object',
        properties: {
          page: {
            type: 'string',
            description: "The page id; this session's latest page when neither this nor file is given.",
          },
          file: {
            type: 'string',
            description: "A project file's path, relative to the project root or absolute, e.g. docs/architecture.md.",
          },
          project: {
            type: 'string',
            description:
              "With file: the id of the registered project the file belongs to, as the person's note names it (then the path is relative to that project's root); the session's project when omitted.",
          },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: SEARCH,
      description:
        'Finds Mermaid diagrams of earlier answers kept by mermaid-view, across sessions and projects: ' +
        'by words in their title, tags, project or source (every word must match), optionally within ' +
        'one project (the folder name of its root). Lists each page id with its project, branch, title ' +
        'and matching source lines, newest first. Use it when the person refers to an earlier diagram.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to find; empty lists the newest pages.' },
          project: { type: 'string', description: 'Only this project, e.g. "realtime-voice-agent".' },
        },
      },
      isDeferred: false,
    })
    // The editor and the project, started without holding up the session.
    void sessionProject($).catch(() => undefined)
    return next(e)
  })

  // Claude wrote a file: a project document or diagram file with diagrams opens in the editor. A
  // write the person refused, or one that failed, left the file as it was: it is not what Claude
  // wrote, and noting it would hide the person's own edits from diagram_edits.
  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && !result.isError) void noteWrite($, e.file_path).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e)) // never in the way of the write itself

  on('tool.call', { tool: SEARCH_NAME }, async ($, e) => {
    const query = e['query']
    const project = e['project']
    return {
      result: await search($, typeof query === 'string' ? query : '', typeof project === 'string' ? project : ''),
    }
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : { result: `mermaid-view: the search failed (${String(next.error?.message ?? next.error)}).` },
  )

  on('tool.call', { tool: TOOL_NAME }, async ($, e) => {
    const file = e['file']
    const project = e['project']
    if (typeof file === 'string' && file.trim()) {
      return { result: await readFileEdits($, file.trim(), typeof project === 'string' ? project.trim() : '') }
    }
    const pageId = e['page']
    return { result: await readEdits($, typeof pageId === 'string' ? pageId : undefined) }
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : { result: `mermaid-view: reading the edits failed (${String(next.error?.message ?? next.error)}).` },
  )

  on('command.run', { command: 'mermaid' }, async $ => {
    const target = await lastTarget($)
    if (!target) return { text: NO_SERVER }
    const p = port
    const origin = `http://localhost:${p}`
    const outcome =
      config.reuseTab && p !== undefined && target.startsWith(`${origin}/`)
        ? await showInOpenTab($, p, target.slice(origin.length))
        : undefined
    if (outcome === 'shown') return { text: `Showed ${target} in the open tab` }
    if (outcome === 'offered') return { text: `${target} is waiting in the open tab (it has edits in progress)` }
    const opened = await openInBrowser($, target)
    return { text: opened ? `Opened ${target}` : `Could not open a browser; the page is ${target}` }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // The main conversation's answers only: a subagent's report is not shown as written.
    if (e.agentId === undefined && e.reason === 'answer') {
      const diagrams = mermaidBlocks(e.answer)
      if (diagrams.length) void show($, diagrams, e.answer).catch(err => $.ui.toast(`Mermaid: ${String(err)}`))
    }
    return result
  })
}
