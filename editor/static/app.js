// The mermaid-view page: each diagram of a document as a card with a zoomable view, a minimap
// and its source, linked both ways (a click in the diagram selects its source; the caret's line
// lights its elements). The source is checked (mermaid's parser), linted, formatted and fixed;
// edits save as they are made, and sending a note hands them to Claude Code.
//
// A document is a page kept from a conversation (/d/<id>) or a project's file (/f/<project>?path=):
// docs.js gives both the same shape. The page loads once; documents open in it (navigate), and a
// diagram Claude shows can open in this tab instead of a new one (the editor's events). An agent
// in the browser can use the page through WebMCP (webmcp.js).

import { editing, favicon, listening, notify, STALE, TYPING_GRACE } from './arrival.js'
import { checkReport, sourceLine } from './check.js'
import { linkDrawing } from './diagram-link.js'
import { ConflictError, FileDoc, PageDoc } from './docs.js'
import { copyImage, download, fileName, liveEditorUrl, MAX_SIDE, markdownBlock, pngOf } from './exporter.js'
import { loadConfigSchema } from './frontmatter.js'
import { inEnglish, LANGS, lang, list, t, translatePage } from './i18n.js'
import { iconPacks } from './icons.js'
import { esc, Library, projectOptions } from './library.js'
import { snappedSizes } from './measure.js'
import { fixAll, format, lint, TYPES, typeOf } from './mermaid-lang.js'
import { loadMonaco, MonacoSource } from './monaco-source.js'
import { store, stored } from './prefs.js'
import { splitter } from './splitter.js'
import { findType, loadReference } from './syntax-reference.js'
import { fitTo, isDarkTheme, LAYOUTS, LOOKS, layoutName, lookName, THEMES, takers, themeName } from './themes.js'
import { VersionPanel } from './versions.js'
import { Minimap, Viewport } from './viewport.js'
import { startWebMcp } from './webmcp.js'

// Mermaid and its two add-ons, awaited only by what draws or parses: the library and the page
// around the cards do not wait for them (static imports would hold the whole module, and with it
// the list of project files, until they came). They load once the library has listed its pages or
// files, or after LIST_FIRST ms: loading them sooner takes the page's thread from that list. From the
// CDN through the editor, which keeps them (/vendor/, editor/vendor.py).
const LIST_FIRST = 1000
let listed
const listShown = new Promise(resolve => {
  listed = resolve
  setTimeout(resolve, LIST_FIRST)
})
const mermaidReady = listShown
  .then(() =>
    Promise.all([
      import('/vendor/npm/mermaid@12.1.0/dist/mermaid.esm.min.mjs'),
      import('/vendor/npm/@mermaid-js/layout-tidy-tree@1.0.1/dist/mermaid-layout-tidy-tree.esm.min.mjs'),
      import('/vendor/npm/@mermaid-js/mermaid-zenuml@1.0.1/dist/mermaid-zenuml.esm.min.mjs'),
    ]),
  )
  .then(async ([{ default: mermaid }, { default: tidyTree }, { default: zenuml }]) => {
    mermaid.registerIconPacks(iconPacks())
    mermaid.registerLayoutLoaders(tidyTree) // its layout code loads the first time a mind map takes it
    await mermaid.registerExternalDiagrams([zenuml]) // ZenUML itself (3 MB) loads with the first ZenUML diagram
    return mermaid
  })

// The page's text in its language (i18n.js); a different choice reloads the page in it.
translatePage()
{
  const langSelect = document.getElementById('lang')
  langSelect.innerHTML = [['auto', t('Automatic')], ...Object.entries(LANGS)]
    .map(([value, name]) => `<option value="${value}">${name}</option>`)
    .join('')
  langSelect.value = stored('lang', 'auto')
  langSelect.title = LANGS[lang]
  langSelect.onchange = () => {
    store('lang', langSelect.value)
    location.reload()
  }
}

const dark = matchMedia('(prefers-color-scheme: dark)').matches
// A draw slower than this (ms) makes the next one wait for a longer pause in typing.
const SLOW_DRAW = 150
// The PNG sizes the export menu offers: times the drawing's size, or a width or height in pixels.
const PNG_SIZES = {
  'scale:1': t('{n}×', { n: 1 }),
  'scale:2': t('{n}×', { n: 2 }),
  'scale:3': t('{n}×', { n: 3 }),
  'scale:4': t('{n}×', { n: 4 }),
  width: t('Set width'),
  height: t('Set height'),
}
// useMaxWidth off: each diagram keeps its natural size (else its SVG shrinks to the box), and the
// view zooms it; vector text stays sharp at any zoom.
const natural = { useMaxWidth: false }
const redraws = [] // every card's draw of the document shown, run again when the theme or look changes

// The theme as mermaid's own designs it (no overrides), the look, the layout engine (always
// named: mermaid 12's default is ELK), and a canvas to match.
let currentConfig = {}
function applyTheme(choice, look, layout) {
  const theme = themeName(choice, dark)
  currentConfig = {
    startOnLoad: false,
    securityLevel: 'strict',
    theme,
    look: lookName(look),
    layout: layoutName(layout),
    flowchart: natural,
    sequence: natural,
    class: natural,
    state: natural,
    er: natural,
    gantt: natural,
    journey: natural,
    pie: natural,
    mindmap: natural,
    timeline: natural,
    requirement: natural,
    c4: natural,
    gitGraph: natural,
    quadrantChart: natural,
    xyChart: natural,
    sankey: natural,
    packet: natural,
    block: natural,
    architecture: natural,
    radar: natural,
    kanban: natural,
    treemap: natural,
  }
  void mermaidReady.then(mermaid => mermaid.initialize(currentConfig)) // the config chosen last, once loaded
  document.documentElement.dataset.canvas = isDarkTheme(theme) ? 'dark' : 'light'
}
// The theme, look and layout chosen last (the menus below show them too).
const chosen = { theme: stored('theme', 'auto'), look: stored('look', 'classic'), layout: stored('layout', 'dagre') }
applyTheme(chosen.theme, chosen.look, chosen.layout)

const $ = sel => document.querySelector(sel)
const status = text => {
  $('#status').textContent = text
}
let renderSeq = 0

// What a URL names: /d/<id> a page, /f/<project>?path= a project's file, / or /d the newest page.
function routeOf(url) {
  const u = new URL(url, location.href)
  const [route, id] = u.pathname.split('/').filter(Boolean)
  return { route, id, path: u.searchParams.get('path') }
}

// A request to the editor's server, a body (init's) as JSON.
const request = (path, init) => fetch(path, init && { ...init, headers: { 'Content-Type': 'application/json' } })

// Its answer's JSON; an error (its `status`, the answer's) when it is not ok.
async function api(path, init) {
  const res = await request(path, init)
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${await res.text()}`), { status: res.status })
  return res.json()
}

// `ms` may be a function: the wait is then asked for at each call.
function debounce(fn, ms) {
  let t
  const call = (...a) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...a), typeof ms === 'function' ? ms() : ms)
  }
  call.cancel = () => clearTimeout(t)
  return call
}

function renderDiff(pre, diff) {
  pre.textContent = ''
  for (const line of diff.split('\n')) {
    const span = document.createElement('span')
    span.textContent = line || ' '
    span.className = line.startsWith('@@')
      ? 'hunk'
      : line.startsWith('+') && !line.startsWith('+++')
        ? 'add'
        : line.startsWith('-') && !line.startsWith('---')
          ? 'del'
          : ''
    pre.append(span, span.className ? '' : '\n')
  }
}

// The parser's error as a finding on its line ("Parse error on line 12").
async function parseFinding(text) {
  const mermaid = await mermaidReady
  try {
    await mermaid.parse(text)
    return undefined
  } catch (err) {
    // Mermaid counts lines without front matter, directives and comments: the source's line instead.
    const said = String(err?.message || err)
    const line = sourceLine(text, Number(/line (\d+)/i.exec(said)?.[1] ?? 1))
    const message = said.replace(/line \d+/i, `line ${line}`)
    return { line, severity: 'error', rule: 'parse', message: message.split('\n').slice(0, 4).join('\n') }
  }
}

// Mermaid's config schema, for the lint of front matter (without it, front matter goes unchecked).
let configSchema = null
const configReady = loadConfigSchema().then(
  s => (configSchema = s),
  () => {},
)

// A source's findings: the parser's error, if any, and the linter's warnings; forAgent: in
// English, for a check an agent reads (MCP, WebMCP), whatever the page's language.
async function checkSource(text, forAgent = false) {
  const parsed = await parseFinding(text)
  await configReady
  const linted = forAgent ? inEnglish(() => lint(text, { config: configSchema })) : lint(text, { config: configSchema })
  return [...(parsed ? [parsed] : []), ...linted]
}

// Every drawing, one at a time: mermaid's settings are global, and each drawing sets its own first
// (the look and layout its type takes, themes.js; `extra` on top), so two cards never mix theirs.
let drawing = Promise.resolve()
function renderWith(id, text, extra = {}, type = typeOf(text)) {
  const run = drawing.then(async () => {
    const mermaid = await mermaidReady
    const { look, layout } = fitTo(type, currentConfig.look, currentConfig.layout)
    mermaid.initialize({ ...currentConfig, look, layout, ...extra })
    return snappedSizes(() => mermaid.render(id, text))
  })
  drawing = run.catch(() => {})
  return run
}

// A drawing for an image where a canvas that drew HTML labels cannot be read back (Safari):
// labels as SVG text, which leaves a label's icons (fa:fa-user) as text.
let exportSeq = 0
async function renderForImage(text) {
  const extra = { htmlLabels: false, flowchart: { ...currentConfig.flowchart, htmlLabels: false } }
  return (await renderWith(`x${++exportSeq}`, text, extra)).svg
}

// A diagram's card. Its listeners, timers and editor end with the document (signal).
function card(d, doc, signal) {
  const el = document.createElement('section')
  el.className = 'card'
  el.id = `card-${d.index}`
  el.innerHTML = `
    <div class="bar">
      <span class="name"></span>
      <span class="badge"></span>
      <span class="declined" hidden></span>
      <span class="conflict" hidden>${t('The file changed on disk')}
        <button data-a="take-disk" title="${t('Drop the edits not saved here and load the version on disk')}">${t('Load from disk')}</button>
        <button data-a="overwrite" title="${t('Write what is here over the version on disk')}">${t('Keep mine')}</button></span>
      <span class="spacer"></span>
      <button data-a="out" title="${t('Zoom out')}">−</button>
      <button data-a="in" title="${t('Zoom in')}">＋</button>
      <button data-a="fit" title="${t('Fit to the view (or double-click the diagram)')}">${t('Fit')}</button>
      <button data-a="actual" title="${t('Actual size')}">100%</button>
      <span class="sep"></span>
      <button data-a="source" title="${t('Show the source; a click on the diagram goes to its source')}">${t('Source')}</button>
      <button data-a="diff">${t('Diff')}</button>
      <button data-a="history" title="${t('Version history: compare, restore, name')}">${t('History')}</button>
      <span class="menu-wrap"><button data-a="export">${t('Export')} ▾</button>
        <span class="menu" hidden>
          <button data-x="mmd">${t('Source .mmd')}</button>
          <button data-x="svg">${t('Image SVG')}</button>
          <button data-x="png">${t('Image PNG')}</button>
          <button data-x="copy-png">${t('Copy image')}</button>
          <label class="png-size" title="${t('The size of PNG and copied images')}">${t('Size')}
            <select data-png>${Object.entries(PNG_SIZES)
              .map(([k, v]) => `<option value="${k}">${v}</option>`)
              .join('')}</select>
            <input data-png-px type="number" min="16" max="${MAX_SIDE}" step="1"> px</label>
          <button data-x="copy">${t('Copy Markdown')}</button>
          <button data-x="live" title="${t('Open in the Mermaid Live Editor in a new tab (the diagram rides after the # of the link, which is not sent to a server)')}">${t('Open in Mermaid Live')} ↗</button>
          ${doc.exportUrl ? `<button data-x="page">${t('Whole page .md')}</button>` : ''}
          ${doc.kind === 'page' ? `<button data-x="project">${t('Save to project…')}</button>` : ''}
        </span></span>
      <button data-a="revert">${t('Revert')}</button>
      <button data-a="full" title="${t('Full screen (Esc to leave)')}">⛶</button>
    </div>
    <div class="body">
      <div class="side">
        <div class="tools">
          <button data-a="undo" title="${t('Undo (Ctrl+Z)')}">↶</button>
          <button data-a="redo" title="${t('Redo (Ctrl+Shift+Z / Ctrl+Y)')}">↷</button>
          <button data-a="format" title="${t('Format (Shift+Alt+F)')}">${t('Format')}</button>
          <button data-a="fix" title="${t('Apply every lint finding that has an automatic fix')}">${t('Fix all')}</button>
          <label title="${t('Format when leaving the editor')}"><input type="checkbox" data-a="autofmt" checked> ${t('Auto format')}</label>
          <a class="docs" target="_blank" rel="noopener" hidden>${t('Syntax docs')}</a>
          <span class="check"></span>
        </div>
        <div class="editor"></div>
        <ul class="findings"></ul>
      </div>
      <div class="split" title="${t('Drag to resize; double-click to reset')}"></div>
      <div class="view">
        <div class="stage"></div>
        <div class="zoom"></div>
        <div class="mv-minimap" title="${t('Click or drag to move there')}"></div>
        <div class="error"></div>
      </div>
      <div class="versions" hidden></div>
    </div>
    <div class="to-project" hidden></div>
    <pre class="diff"></pre>`
  const q = s => el.querySelector(s)
  const body = q('.body')
  const editor = new MonacoSource(q('.editor'))
  const viewport = new Viewport(q('.view'), q('.stage'), q('.zoom'))
  const minimap = new Minimap(q('.mv-minimap'), viewport)
  const error = q('.error')
  const badge = q('.badge')
  const declined = q('.declined')
  const diffPre = q('pre.diff')
  const findingsList = q('.findings')
  const check = q('.check')
  let first = true
  let link = linkDrawing(document.createElementNS('http://www.w3.org/2000/svg', 'svg'), '', '') // the drawing <-> source map
  let lit = []
  let picking = false
  // The text as last saved (or taken from disk): anything else is unsaved. Whether the editor's
  // text is, kept as either changes: every key asks it of every card (reportBusy).
  let saved = d.text
  let unsaved = false
  const recheck = () => (unsaved = editor.value !== saved)
  const setSaved = text => {
    saved = text
    recheck()
  }
  const conflict = q('.conflict')
  q('.name').textContent = doc.name(d)
  q('[data-a=revert]').title = t('Back to {version}', { version: doc.baseName })

  const light = (doms, primaryDom) => {
    for (const x of lit) x.classList.remove('mv-hit', 'mv-related')
    lit = doms
    for (const x of doms) x.classList.add(x === primaryDom ? 'mv-hit' : 'mv-related')
  }

  const mark = (edited, diff) => {
    badge.textContent = doc.badge(edited)
    badge.classList.toggle('edited', edited)
    renderDiff(diffPre, diff || t('(no changes)'))
  }

  const showFindings = findings => {
    editor.setFindings(findings)
    const errors = findings.filter(f => f.severity === 'error').length
    const warnings = findings.filter(f => f.severity === 'warning').length
    check.textContent = errors
      ? `✗ ${errors === 1 ? t('1 error') : t('{n} errors', { n: errors })}`
      : warnings
        ? `⚠ ${warnings === 1 ? t('1 warning') : t('{n} warnings', { n: warnings })}`
        : `✓ ${t('No problems')}`
    check.className = `check ${errors ? 'error' : warnings ? 'warning' : 'ok'}`
    findingsList.innerHTML = ''
    for (const f of findings) {
      const li = document.createElement('li')
      li.className = f.severity
      li.textContent = t('Line {line}: {message}', { line: f.line, message: f.message })
      li.title = f.rule
      li.onclick = () => editor.goto(f.line)
      findingsList.append(li)
    }
  }

  // The official docs of the diagram's type, from the syntax reference.
  const docsLink = q('.docs')
  const showDocs = async type => {
    const entry = type.id ? findType(await loadReference().catch(() => ({ types: [] })), type.id) : undefined
    docsLink.hidden = !entry?.docs
    if (entry?.docs) {
      docsLink.href = entry.docs
      docsLink.title = t("{type}'s syntax (Mermaid's documentation)", { type: entry.name })
    }
  }

  let drawMs = 0 // how long the last draw took
  const draw = async () => {
    const started = performance.now()
    try {
      await drawNow()
    } finally {
      drawMs = performance.now() - started
    }
  }
  const drawNow = async () => {
    const text = editor.value
    const findings = await checkSource(text)
    showFindings(findings)
    const parsed = findings.find(f => f.rule === 'parse')
    if (parsed) {
      error.textContent = parsed.message
      error.style.display = 'block'
      return // keep the last good drawing
    }
    const id = `m${d.index}_${++renderSeq}`
    const type = typeOf(text)
    showDocs(type)
    const fit = fitTo(type, currentConfig.look, currentConfig.layout)
    declined.textContent = t('No {what}', { what: list(fit.declined) })
    declined.title = t('Mermaid does not draw this type so: drawn in the {look} look with the {layout} layout', {
      look: LOOKS[fit.look],
      layout: LAYOUTS[fit.layout],
    })
    declined.hidden = !fit.declined.length
    try {
      const { svg } = await renderWith(id, text, {}, type)
      viewport.stage.innerHTML = svg
      error.style.display = 'none'
      link = linkDrawing(viewport.svg, text, id, type)
      lit = []
      minimap.update()
      if (first) {
        first = false
        requestAnimationFrame(() => viewport.fit())
      } else viewport.apply()
    } catch (err) {
      document.getElementById(`d${id}`)?.remove() // mermaid's leftover on a failed render
      error.textContent = String(err?.message || err)
      error.style.display = 'block'
    }
  }

  // One save at a time, in order: each saves the text as it is when its turn comes. While the card
  // offers the disk's version or its own (a conflict), nothing is saved until the person picks.
  let saving = Promise.resolve()
  const persist = () =>
    (saving = saving.then(async () => {
      const text = editor.value
      if (text === saved || !conflict.hidden) return
      try {
        const result = await doc.save(d.index, text)
        setSaved(text)
        conflict.hidden = true
        mark(result.changed, result.diff)
        status(t('{name}: saved', { name: doc.name(d) }))
      } catch (err) {
        if (err instanceof ConflictError) {
          conflict.hidden = false // saving stops here until the person picks a side
          status(t('{name}: {error}; these edits are not saved yet', { name: doc.name(d), error: err.message }))
        } else status(t('Saving failed: {error}', { error: err.message }))
      }
      reportBusy()
    }))
  const save = debounce(persist, 600)

  // Diagram to source: a click lights the element it picks, and a node's connections (its edges and
  // the nodes at their other ends); while the source panel is open it also selects the element's
  // lines (the panel opens only from its button).
  viewport.onClick = target => {
    const hit = link.hit(target)
    if (!hit) return light([])
    const lines = body.classList.contains('with-source') && link.select(hit.key)
    if (lines) {
      editor.mark(lines.primary, lines.related)
      picking = true // the caret move below is this pick's, not the person's
      editor.goto(lines.primary)
      picking = false
    }
    light([hit.dom, ...link.neighbors(hit.key).flatMap(k => link.doms(k))], hit.dom)
  }

  // Source to diagram: the caret's line lights its elements.
  editor.onCaretLine(n => {
    if (picking) return
    const doms = link.keysAt(n).flatMap(k => link.doms(k))
    light(doms, doms[0])
    editor.mark(n, [])
  })

  redraws.push(draw)
  // The source panel's width, dragged on the split between it and the view (one width for all cards).
  splitter(q('.split'), {
    key: 'source-width',
    start: () => q('.side').getBoundingClientRect().width,
    apply: px => body.style.setProperty('--src-w', `${px}px`),
    min: 240,
    max: () => Math.max(240, body.clientWidth - 200),
    fallback: () => body.clientWidth * 0.42,
  })
  const versions = new VersionPanel(q('.versions'), {
    history: () => doc.history(d.index),
    version: commit => doc.version(d.index, commit),
    label: doc.label ? (commit, name) => doc.label(commit, name) : null,
    empty:
      doc.kind === 'page'
        ? t('No versions yet. An edit becomes a version about 5 seconds after it.')
        : t('This file has no commits yet.'),
    current: () => editor.value,
    restore: text => editor.replace(text),
    compare: (diff, caption) => {
      renderDiff(diffPre, `@@ ${caption}\n${diff}`)
      diffPre.classList.add('shown')
    },
  })
  // The drawing as SVG markup, as it is shown.
  const svgText = () => {
    const svg = viewport.svg
    if (!svg) throw new Error(t('No drawing yet'))
    return new XMLSerializer().serializeToString(svg)
  }
  // The PNG at the size chosen in the menu (kept for every card), on the canvas's color.
  const sizeSelect = q('[data-png]')
  const sizePx = q('[data-png-px]')
  const showSize = () => {
    sizePx.hidden = sizeSelect.value.startsWith('scale:')
    sizePx.value = stored(`png-${sizeSelect.value}`, sizeSelect.value === 'height' ? '1080' : '1920')
  }
  const syncSize = () => {
    sizeSelect.value = stored('png-size', 'scale:2')
    showSize()
  }
  syncSize()
  sizeSelect.onchange = () => (store('png-size', sizeSelect.value), showSize())
  sizePx.onchange = () => store(`png-${sizeSelect.value}`, sizePx.value)
  const png = async () => {
    const choice = sizeSelect.value
    const size = choice.startsWith('scale:') ? { scale: Number(choice.slice(6)) } : { [choice]: Number(sizePx.value) }
    const bg = getComputedStyle(viewport.view).getPropertyValue('--canvas').trim() || '#ffffff'
    // The drawing as shown, labels' icons and all; else one with SVG text labels.
    return pngOf(svgText(), size, bg).catch(async err => {
      if (err?.name !== 'SecurityError') throw err
      return pngOf(await renderForImage(editor.value), size, bg)
    })
  }
  const exportAs = async kind => {
    const title = t('{title}-diagram {n}', { title: doc.title, n: d.index + 1 })
    try {
      if (kind === 'mmd') download(fileName(title, '.mmd'), new Blob([editor.value], { type: 'text/plain' }))
      else if (kind === 'svg') download(fileName(title, '.svg'), new Blob([svgText()], { type: 'image/svg+xml' }))
      else if (kind === 'png') download(fileName(title, '.png'), await png())
      else if (kind === 'copy-png') {
        await copyImage(png())
        status(t('Image copied'))
        return
      } else if (kind === 'copy') {
        await navigator.clipboard.writeText(markdownBlock(editor.value))
        status(t('Markdown copied'))
        return
      } else if (kind === 'live') {
        // The tab opens now, while the click still allows it; its address follows once made.
        const tab = open('', '_blank')
        if (!tab) throw new Error(t('The browser blocked the new tab'))
        tab.opener = null
        const { look, layout } = fitTo(typeOf(editor.value), currentConfig.look, currentConfig.layout)
        tab.location.href = await liveEditorUrl(editor.value, { theme: currentConfig.theme, look, layout })
        return
      } else if (kind === 'page') location.href = doc.exportUrl
      else if (kind === 'project') return toProject(q('.to-project'), doc, d, () => editor.value)
      status(t('Exported'))
    } catch (err) {
      status(t('Export failed: {error}', { error: err.message }))
    }
  }
  const menu = q('.menu')
  q('.menu').addEventListener('click', e => {
    const kind = e.target.closest('[data-x]')?.dataset.x
    if (!kind) return
    menu.hidden = true
    exportAs(kind)
  })
  addEventListener(
    'click',
    e => {
      if (!e.target.closest('.menu-wrap')) menu.hidden = true
    },
    { signal },
  )

  // The view changes size as panels open, close or resize: keep the minimap's frame true.
  const resized = new ResizeObserver(() => minimap.place())
  resized.observe(q('.view'))
  editor.value = d.text
  recheck()
  mark(Boolean(d.diff), d.diff)
  // A diagram slow to draw (each draw holds the page) waits for a longer pause in typing, so the
  // keys typed meanwhile are not held up behind draws of every letter (as the Live Editor does).
  const redraw = debounce(draw, () => (drawMs > SLOW_DRAW ? 1000 : 250))
  editor.onInput(recheck) // first: the listeners after it read it
  editor.onInput(redraw)
  editor.onInput(save)
  editor.onInput(reportBusy)
  editor.onKeys(typed) // where the browser has EditContext, Monaco types through it: no input event comes
  // Format when leaving the editor (Shift+Alt+F formats at any time, as in VS Code).
  editor.onBlur(() => {
    if (q('[data-a=autofmt]').checked && !editor.findings.some(f => f.rule === 'parse')) {
      const formatted = format(editor.value)
      if (formatted !== editor.value) editor.replace(formatted)
    }
  })

  el.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.a
    if (a === 'in') viewport.zoomIn()
    else if (a === 'out') viewport.zoomOut()
    else if (a === 'fit') viewport.fit()
    else if (a === 'actual') viewport.actual()
    else if (a === 'source') {
      body.classList.toggle('with-source')
      requestAnimationFrame(() => viewport.fit())
    } else if (a === 'diff') diffPre.classList.toggle('shown')
    else if (a === 'revert') editor.replace(d.base)
    else if (a === 'overwrite') overwrite()
    else if (a === 'take-disk') navigate(location.href, { replace: true, discard: true })
    else if (a === 'history') versions.toggle()
    else if (a === 'export') {
      menu.hidden = !menu.hidden
      if (!menu.hidden) syncSize() // another card's menu may have changed the size
    } else if (a === 'undo') editor.editor.trigger('mermaid-view', 'undo', null)
    else if (a === 'redo') editor.editor.trigger('mermaid-view', 'redo', null)
    else if (a === 'format') editor.replace(format(editor.value))
    else if (a === 'fix') editor.replace(fixAll(editor.value, { config: configSchema }))
    else if (a === 'full') {
      el.classList.toggle('full')
      requestAnimationFrame(() => viewport.fit())
    }
  })
  addEventListener(
    'keydown',
    e => {
      if (e.key === 'Escape' && el.classList.contains('full')) {
        el.classList.remove('full')
        requestAnimationFrame(() => viewport.fit())
      }
    },
    { signal },
  )
  addEventListener(
    'resize',
    debounce(() => minimap.place(), 100),
    { signal },
  )

  // A conflict settled for this card's text: save it over the disk's version of its diagram. The
  // rest of the file comes in first (follow), and only while the file holds as many diagrams as
  // the page: else this card's index may name another diagram now.
  const overwrite = async () => {
    const file = await doc.fresh()
    if (file && !follow(doc, shown.cards, file)) {
      return status(
        t(
          '{name}: the file gained or lost diagrams, so this one cannot be written back by its place; copy your edits, then load from disk',
          { name: doc.name(d) },
        ),
      )
    }
    conflict.hidden = true
    setSaved(null)
    save()
  }
  // The file changed on disk (Claude, an editor, a checkout): text is this diagram there (null:
  // only the base changed, after a commit or checkout). Taken when nothing here is unsaved; edits
  // made on the diagram the disk still holds go on; edits made on one the disk no longer holds
  // stay, and the card offers the disk's version or its own.
  el.take = (text, base) => {
    d.base = base
    if (text !== null) {
      if (!el.unsaved() && !sameDiagram(text, saved)) {
        setSaved(text)
        editor.replace(text)
      } else if (sameDiagram(text, editor.value)) setSaved(editor.value) // the disk holds what is typed here
      if (!sameDiagram(text, saved)) conflict.hidden = false
      else if (!conflict.hidden) {
        conflict.hidden = true
        if (el.unsaved()) save()
      }
    }
    const diff = doc.diff(base, editor.value)
    mark(diff !== '', diff)
  }
  el.unsaved = () => unsaved
  // What an agent uses (webmcp.js), as the person would: the editor's text, one undoable edit
  // that saves as typing does, the drawing; each edit is drawn before its findings are told.
  el.index = d.index
  el.source = () => editor.value
  el.svgText = svgText
  el.setSource = async text => {
    editor.replace(text)
    redraw.cancel()
    await draw()
    return editor.findings
  }
  el.showConflict = () => (conflict.hidden = false)
  // Saves what is not saved yet, now; false when it could not be (the status says why).
  el.flush = async () => {
    save.cancel()
    await persist()
    return !el.unsaved()
  }
  signal.addEventListener('abort', () => {
    redraw.cancel()
    save.cancel()
    resized.disconnect()
    editor.dispose()
  })
  draw()
  return el
}

// The document on the page: its URL, its cards, and the signal that ends its listeners, timers
// and editors when another one opens.
let shown = null
let navigation = Promise.resolve()

/**
 * Opens the document of a URL in this page, without loading the page again: the one way from
 * document to document (links, [ ], back and forward, a diagram Claude shows). Unsaved edits are
 * saved first; when they cannot be, the page stays (the status says why). pop: the URL is the
 * history's already (back, forward); discard: unsaved edits are dropped (the document is gone, or
 * the disk's version is wanted).
 */
function navigate(url, { replace = false, pop = false, discard = false } = {}) {
  navigation = navigation.then(() => go(new URL(url, location.href).href, { replace, pop, discard }))
  return navigation
}

async function go(url, { replace, pop, discard }) {
  if (shown) {
    const saved = discard || (await Promise.all(shown.cards.map(c => c.flush()))).every(Boolean)
    if (!saved) {
      if (pop) history.pushState(null, '', shown.url) // the address back to what is shown
      return
    }
    shown.controller.abort()
    redraws.length = 0
  }
  if (!pop) history[replace || url === location.href ? 'replaceState' : 'pushState'](null, '', url)
  const controller = new AbortController()
  shown = { url, controller, signal: controller.signal, cards: [] }
  status('')
  $('#note').value = ''
  try {
    await showUrl(location.href, shown)
  } catch (err) {
    if (!shown.doc) {
      // Not loaded: the header must not act on the document shown before (delete, rename, send).
      pageActions(null, shown.signal)
      setTitle(BASE_TITLE)
    }
    $('#cards').innerHTML = `<div class="empty">${esc(t('Loading failed: {error}', { error: err.message }))}</div>`
  }
  shown.url = location.href // the newest page's, when the URL named none
  if (offered === shown.url) offer(null) // the diagram offered is the one shown now
  reportBusy()
}

async function showUrl(url, view) {
  const { route, id, path } = routeOf(url)
  if (route === 'f' && id) return loadDocument(path ? new FileDoc(api, id, path) : null, view, id)
  if (route === 'd' && id) return loadDocument(new PageDoc(api, id), view)
  const { pages } = await api('/api/pages')
  if (pages[0]) {
    history.replaceState(null, '', `/d/${pages[0].id}`)
    return showUrl(location.href, view)
  }
  pageActions(null, view.signal)
  setTitle(BASE_TITLE)
  showLibrary({ kind: 'page', diagrams: [] })
  $('#cards').innerHTML = `<div class="empty">${t('No diagrams yet.')}</div>`
}

// A document's cards; a project without a file chosen shows its files in the library only.
async function loadDocument(doc, view, projectId) {
  const cards = $('#cards')
  if (!doc) {
    pageActions(null, view.signal)
    setTitle(BASE_TITLE)
    showLibrary({ kind: 'file', projectId, diagrams: [] })
    cards.innerHTML = `<div class="empty">${t('Pick a file in the project files on the left.')}</div>`
    return
  }
  // A project's files are listed while the file is read (their list needs nothing of it); a page's
  // list, filtered by the page's project, once the page is read.
  const file = doc.kind === 'file'
  if (file) showLibrary({ kind: 'file', projectId: doc.projectId, path: doc.path, diagrams: [] })
  await doc.load()
  view.doc = doc
  setTitle(`${doc.title} · mermaid-view`)
  pageActions(doc, view.signal)
  const context = file
    ? { kind: 'file', projectId: doc.projectId, path: doc.path, diagrams: doc.diagrams }
    : { kind: 'page', id: doc.id, project: doc.page.project, diagrams: doc.diagrams }
  if (file) library.mark(context)
  else showLibrary(context)
  cards.innerHTML = `<div class="empty">${t('Loading the editor…')}</div>`
  await loadMonaco() // once; the browser caches it after
  cards.innerHTML = doc.diagrams.length ? '' : `<div class="empty">${t('This file has no Mermaid diagrams.')}</div>`
  cards.scrollTop = 0
  for (const d of doc.diagrams) {
    const el = card(d, doc, view.signal)
    view.cards.push(el)
    cards.append(el)
  }
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView()
  if (doc.kind === 'file') watchFile(doc, view)
}

// Whether two texts are one diagram as the file keeps it: \n line ends and one at the end (a save
// drops the others, and the file reads back with one).
const asKept = text => text.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')
const sameDiagram = (a, b) => asKept(a) === asKept(b)

// The file on disk into the cards showing it: its version is the one later saves are made on, and
// each card takes its diagram (card.take). False, and nothing taken, when the file holds another
// number of diagrams than the cards: an index may name another diagram now.
function follow(doc, cards, file) {
  if (file.diagrams.length !== cards.length) return false
  doc.adopt(file)
  file.diagrams.forEach((d, i) => cards[i].take(file.changed ? d.text : null, doc.baseOf(d)))
  return true
}

// A project file follows the disk: what Claude, an editor or a checkout writes shows here; a card
// with unsaved edits made on a diagram the disk no longer holds offers the disk's version or its own.
function watchFile(doc, { signal, cards }) {
  const tick = async () => {
    try {
      const file = await doc.fresh()
      if (!file || signal.aborted) return
      if (!follow(doc, cards, file)) {
        // Diagrams were added or removed: load the file again, unless that would lose edits here.
        if (anyUnsaved()) return cards.forEach(c => c.showConflict())
        return navigate(location.href, { replace: true })
      }
      status(
        file.changed
          ? t('The file changed on disk: loaded the new version')
          : t("The project's commit changed: compared again"),
      )
    } catch {
      // the server is gone or the file moved: keep what is shown
    }
  }
  const timer = setInterval(tick, 2000)
  signal.addEventListener('abort', () => clearInterval(timer))
}

// Save to project: a diagram of a conversation into a project, as a new .mmd file or a block at the
// end of a Markdown document.
async function toProject(box, doc, d, text) {
  box.hidden = !box.hidden
  if (box.hidden) return
  const { projects } = await api('/api/projects')
  if (!projects.length) {
    box.innerHTML = `<span class="tp-note">${t('No projects registered yet: use Claude Code in a project, or run mermaid_view.py --project DIR.')}</span>`
    return
  }
  const here = projects.find(p => p.root === doc.page.projectRoot) ?? projects[0]
  // Folder and file names are a repository's to choose (", <, > included): escaped like any text.
  box.innerHTML = `
    <select class="tp-project">${projectOptions(projects, p => (p === here ? ' selected' : ''))}</select>
    <select class="tp-mode"><option value="mmd">${t('A new .mmd file')}</option><option value="md">${t('Added to a Markdown document')}</option></select>
    <input class="tp-path" list="tp-files-${d.index}" size="40" spellcheck="false">
    <datalist id="tp-files-${d.index}"></datalist>
    <input class="tp-heading" placeholder="${t('Section heading (optional)')}" hidden>
    <button data-tp="save">${t('Save')}</button>
    <span class="tp-note"></span>`
  const q = sel => box.querySelector(sel)
  const project = () => projects.find(p => p.id === q('.tp-project').value)
  const fill = async () => {
    const md = q('.tp-mode').value === 'md'
    q('.tp-heading').hidden = !md
    const { files } = await api(`/api/projects/${project().id}/files`)
    q('datalist').innerHTML = files
      .filter(f => (f.kind === 'markdown') === md)
      .map(f => `<option value="${esc(f.path)}">`)
      .join('')
    q('.tp-path').value = md
      ? (files.find(f => f.kind === 'markdown')?.path ?? 'docs/diagrams.md')
      : `${project().diagramsDir}/${fileName(doc.title, '.mmd')}`
  }
  q('.tp-project').onchange = fill
  q('.tp-mode').onchange = fill
  q('[data-tp=save]').onclick = async () => {
    const path = q('.tp-path').value.trim()
    const res = await request(`/api/projects/${project().id}/file?path=${encodeURIComponent(path)}`, {
      method: 'POST',
      body: JSON.stringify({ text: text(), heading: q('.tp-heading').value }),
    })
    const out = await res.json().catch(() => ({}))
    q('.tp-note').innerHTML = res.ok
      ? `${t('Saved to')} <a href="/f/${esc(project().id)}?path=${encodeURIComponent(out.path)}#card-${esc(out.index)}">${esc(out.path)}</a>`
      : res.status === 409
        ? t('Not saved: the file exists already; pick another name (a .mmd never overwrites a file)')
        : esc(t('Not saved: {error}', { error: out.error ?? res.status }))
  }
  await fill()
}

// The page list: collapsed with ☰ (remembered), its width dragged on its edge.
function libraryPanel() {
  const root = document.documentElement
  const hidden = stored('library-hidden', '0') === '1'
  document.body.classList.toggle('lib-hidden', hidden)
  $('#toggle-lib').onclick = () => {
    const now = document.body.classList.toggle('lib-hidden')
    store('library-hidden', now ? '1' : '0')
  }
  splitter($('.lib-split'), {
    key: 'library-width',
    start: () => $('#library').getBoundingClientRect().width,
    apply: px => root.style.setProperty('--lib-w', `${px}px`),
    min: 180,
    max: () => Math.max(180, innerWidth * 0.5),
    fallback: () => 290,
  })
}

// The header's controls for the document: a page's title (edited in place), pin, tags and delete;
// a project file's path and project (it is renamed or deleted in the project, not here).
function pageActions(doc, signal) {
  const title = $('#title')
  const pin = $('#pin')
  const tags = $('#tags')
  const del = $('#delete')
  const isPage = doc?.kind === 'page'
  for (const el of [pin, tags, del]) el.hidden = !isPage
  title.readOnly = !isPage
  title.onchange = tags.onchange = null
  $('#send').disabled = !doc
  if (!isPage) {
    title.value = doc ? `${doc.project.name} / ${doc.path}` : ''
    title.placeholder = t('Project file')
    return
  }
  const page = doc.page
  const patch = async fields => {
    try {
      await api(`/api/pages/${doc.id}`, { method: 'PATCH', body: JSON.stringify(fields) })
      status(t('Updated'))
    } catch (err) {
      status(t('Updating failed: {error}', { error: err.message }))
    }
  }
  title.value = page.title || ''
  title.placeholder = doc.id
  title.onchange = () => patch({ title: title.value })
  const showPin = on => {
    pin.textContent = on ? `★ ${t('Pinned')}` : `☆ ${t('Pin')}`
    pin.classList.toggle('on', on)
  }
  let pinned = page.pinned
  showPin(pinned)
  pin.onclick = () => {
    pinned = !pinned
    showPin(pinned)
    patch({ pinned })
  }
  tags.value = (page.tags ?? []).join(', ')
  tags.onchange = () => patch({ tags: tags.value.split(/[,，\s]+/).filter(Boolean) })
  // Delete asks twice, in place (no dialog): a second press within three seconds deletes.
  let armed
  const disarm = () => {
    clearTimeout(armed)
    armed = undefined
    del.textContent = t('Delete')
    del.classList.remove('armed')
  }
  disarm()
  signal.addEventListener('abort', disarm)
  del.onclick = async () => {
    if (!armed) {
      del.textContent = t('Click again to delete')
      del.classList.add('armed')
      armed = setTimeout(disarm, 3000)
      return
    }
    clearTimeout(armed)
    try {
      await api(`/api/pages/${doc.id}`, { method: 'DELETE' })
      navigate('/d', { replace: true, discard: true })
    } catch (err) {
      status(t('Deleting failed: {error}', { error: err.message }))
    }
  }
}

// The theme and look menus: a change restyles every diagram at once.
const options = (entries, title = () => '') =>
  Object.entries(entries)
    .map(([value, label]) => `<option value="${value}" title="${title(value)}">${label}</option>`)
    .join('')
// A look or layout only some types take says which (themes.js); the others draw as before.
const takenBy = names => (names.length === TYPES.length ? '' : t('For: {types}', { types: list(names) }))
const themeSelect = $('#theme')
const lookSelect = $('#look')
const layoutSelect = $('#layout')
themeSelect.innerHTML = options(THEMES)
lookSelect.innerHTML = options(LOOKS, look => takenBy(takers(TYPES, look)))
layoutSelect.innerHTML = options(LAYOUTS, layout => takenBy(takers(TYPES, undefined, layout)))
themeSelect.value = chosen.theme
lookSelect.value = chosen.look
layoutSelect.value = chosen.layout
const restyle = () => {
  store('theme', themeSelect.value)
  store('look', lookSelect.value)
  store('layout', layoutSelect.value)
  applyTheme(themeSelect.value, lookSelect.value, layoutSelect.value)
  for (const draw of redraws) draw()
}
for (const select of [themeSelect, lookSelect, layoutSelect]) select.onchange = restyle

// The notes this tab sent and not yet delivered, by id: their text, to give back if one is dropped.
// The mod puts a note in Claude Code's prompt box when the box takes it (event `note` below).
const notes = new Map()
$('#send').addEventListener('click', async () => {
  const doc = shown?.doc
  if (!doc) return
  const note = $('#note').value
  try {
    const { id } = await doc.send(note)
    notes.set(id, note)
    $('#note').value = '' // sent: no longer work in progress here (arrival.js)
    reportBusy()
    status(t('Sent to Claude Code; waiting for its prompt box to take it…'))
  } catch (err) {
    status(t('Sending failed: {error}', { error: err.message }))
  }
})

// The tab's title and icon: the document's title, led by a mark, and a red dot on the icon while a
// diagram Claude showed here waits to be seen (a page cannot bring its tab to the front; the dot
// still shows when the tab strip is too crowded for titles). Steady, not blinking: a background
// tab's timers are slowed down.
const BASE_TITLE = document.title
const NEW_MARK = `● ${t('New')} `
let titleText = BASE_TITLE
let marked = false
const showTitle = () => (document.title = (marked ? NEW_MARK : '') + titleText)
function setTitle(text) {
  titleText = text
  showTitle()
}
function mark(on) {
  marked = on
  showTitle()
  $('#favicon').href = favicon(on)
}
$('#favicon').href = favicon()

// Notifications are the one way a page may bring its tab to the front (a click on one). The page
// never asks on its own: the person turns them on here, once.
function showNotifyButton() {
  const N = globalThis.Notification
  $('#notify-on').hidden = !(typeof N === 'function' && N.permission === 'default')
}
$('#notify-on').addEventListener('click', async () => {
  const permission = await Notification.requestPermission()
  showNotifyButton()
  status(
    permission === 'granted'
      ? t(
          'Notifications on: a new diagram in a background tab notifies you; a click on the notification brings you back here',
        )
      : t('Notifications off: a new diagram in a background tab shows only as a red dot on its tab icon'),
  )
})
showNotifyButton()

// This tab as a viewer of the editor (viewers.py): the next diagram Claude shows comes, as an
// event `show`, to the tab already open instead of a new tab. A tab with work in progress
// (arrival.js) keeps it and offers the diagram instead; a tab out of view marks its title and,
// where allowed, notifies. Hidden and unused for STALE, it closes its stream (arrival.js listening)
// until it is back in view. Without EventSource the tab is no viewer: diagrams open new tabs.
const viewer = crypto.randomUUID()
const report = state => api(`/api/viewers/${viewer}`, { method: 'POST', body: JSON.stringify(state) }).catch(() => {})
const visible = () => document.visibilityState === 'visible'
const inUse = () => visible() && document.hasFocus()
let typedAt = -Infinity
let usedAt = Date.now() // the person's last use (focused or brought into view): a page just opened is the most recent
let busy = false
let settling // the check once typing settles: busy ends without another event
const anyUnsaved = () => shown?.cards.some(c => c.unsaved()) ?? false
const isEditing = () => editing({ unsaved: anyUnsaved(), note: $('#note').value, typedAt })
function reportBusy() {
  const now = isEditing()
  clearTimeout(settling)
  if (now) settling = setTimeout(reportBusy, TYPING_GRACE)
  if (now === busy) return
  busy = now
  report({ busy })
}
// The person typed: in a field of the page (an input event), or in a card's source (its editor's
// keys: where the browser has EditContext, Monaco types through it and no input event comes).
function typed() {
  typedAt = Date.now()
  reportBusy()
}
document.addEventListener('input', typed, true)

const relist = () => library.refresh().catch(() => {}) // the server is gone, or the list not up yet

// A diagram offered and not opened yet (its URL), behind the header's button to open it.
let offered = null
function offer(url) {
  offered = url && new URL(url, location.href).href
  $('#arrival').hidden = !offered
}
$('#arrival-open').addEventListener('click', () => offered && navigate(offered))
$('#arrival-close').addEventListener('click', () => offer(null))

// The stream's events, each a [name, handler]; listen() opens the stream with them.
const streamEvents = []
const onEvent = (name, handler) => streamEvents.push([name, handler])
let events = null // the open stream (it reconnects by itself), or null while let go
let resumed = false // the stream was let go and opens again: what was announced meanwhile is missed
function listen() {
  if (events || typeof EventSource !== 'function') return
  events = new EventSource(`/api/events?viewer=${viewer}`)
  for (const [name, handler] of streamEvents) events.addEventListener(name, handler)
}
function letGo() {
  if (!events || listening({ visible: visible(), usedAt })) return
  events.close()
  events = null
  resumed = true
}
// A new stream (opened, or reconnected after the server restarted or the machine slept) is a new
// viewer to the server: it hears how long this tab has been unused, as reconnecting is no use.
onEvent('open', () => {
  report({ busy, visible: visible(), idle: inUse() ? 0 : (Date.now() - usedAt) / 1000 })
  if (resumed) relist()
  resumed = false
})
onEvent('show', e => {
  const { url } = JSON.parse(e.data)
  const keep = isEditing()
  if (!inUse()) {
    mark(true)
    notify(
      globalThis.Notification,
      keep ? t('A new diagram: open it in the tab') : t('A new diagram is shown in the tab'),
    )
  }
  if (!keep) return navigate(url)
  offer(url)
  relist()
  status(t('Claude sent a new diagram; this tab has edits in progress, so it stayed'))
})
onEvent('added', relist) // shown in another tab: listed here
// A page changed elsewhere (an agent through the editor's MCP tools): shown here, it loads again in
// place; with unsaved edits here it stays as it is (they save over it).
onEvent('changed', e => {
  const url = new URL(JSON.parse(e.data).url, location.href)
  if (!shown || url.pathname !== location.pathname) return
  if (anyUnsaved())
    return status(t('This page was changed elsewhere; it has edits not saved here, so it did not reload'))
  navigate(location.href, { replace: true }).then(() => status(t('This page was changed elsewhere and reloaded')))
})
// A note this tab sent: in the prompt box, still waiting for it (a dialog is up in Claude Code; the
// mod tries again), or dropped: after ten minutes, or pushed out by newer notes (its text comes back
// to the note field if empty).
onEvent('note', e => {
  const { id, state } = JSON.parse(e.data)
  if (!notes.has(id)) return
  if (state === 'waiting')
    return status(
      t(
        "Not delivered yet: Claude Code's prompt box cannot take it now (a dialog may be open); it goes in once it can",
      ),
    )
  const note = notes.get(id)
  notes.delete(id)
  if (state === 'delivered') return status(t("In Claude Code's prompt box: press Enter to send"))
  if (state !== 'dropped') return
  if (note && !$('#note').value) {
    $('#note').value = note
    reportBusy()
  }
  status(
    t('Not delivered: Claude Code did not take it (ten minutes went by, or too many waited after it); send it again'),
  )
})
// The editor's MCP server cannot run Mermaid's parser: it hands sources to a tab to check
// (checks.py). Nothing on the page changes; the reports go back under the check's id.
onEvent('check', async e => {
  const { id, sources, type } = JSON.parse(e.data)
  const reports = []
  for (const source of sources) reports.push(checkReport(source, await checkSource(source, true), type))
  api(`/api/checks/${id}`, { method: 'POST', body: JSON.stringify({ viewer, reports }) }).catch(() => {})
})
let stale // the check, once the tab has been hidden for STALE, whether to let its stream go
const back = () => {
  usedAt = Date.now()
  mark(false)
  clearTimeout(stale)
  listen()
  report({ busy, visible: true, idle: 0 })
}
// Hidden: in view until now, so in use until now; its stream goes once it stays hidden for STALE.
const away = () => {
  usedAt = Date.now()
  clearTimeout(stale)
  stale = setTimeout(letGo, STALE + 1000)
  report({ busy, visible: false, idle: 0 })
}
addEventListener('focus', back)
document.addEventListener('visibilitychange', () => (visible() ? back() : away()))
listen()

// A link to a document opens it here; a modified or middle click still opens a new tab.
document.addEventListener('click', e => {
  const a = e.target.closest('a[href]')
  if (
    !a ||
    e.defaultPrevented ||
    e.button !== 0 ||
    e.metaKey ||
    e.ctrlKey ||
    e.shiftKey ||
    e.altKey ||
    a.target ||
    a.hasAttribute('download')
  )
    return
  const url = new URL(a.href)
  if (url.origin !== location.origin || !/^\/[df](\/|$)/.test(url.pathname)) return
  e.preventDefault()
  navigate(url.href)
})
addEventListener('popstate', () => navigate(location.href, { pop: true }))

const library = new Library($('#library'), api, url => navigate(url))
/** The library on what the page shows; Mermaid starts loading once its first list is in. */
function showLibrary(context) {
  const shown = library.show(context)
  shown.then(listed, listed)
  return shown
}
libraryPanel()
navigate(location.href, { replace: true })

// The page for an agent in the browser (WebMCP), when the browser has one: the document shown
// when a tool is called, its cards' editors, navigate and the library.
const cardAt = index => shown?.cards.find(c => c.index === index)
startWebMcp({
  current: () => {
    const doc = shown?.doc
    if (!doc) return null
    const where = doc.kind === 'page' ? { id: doc.id } : { projectId: doc.projectId, path: doc.path }
    return {
      kind: doc.kind,
      ...where,
      title: doc.title,
      url: location.href,
      diagrams: shown.cards.map(c => ({ index: c.index, source: c.source() })),
    }
  },
  findings: index => checkSource(cardAt(index).source(), true),
  setSource: async (index, text) => {
    await cardAt(index).setSource(text)
    return checkSource(text, true)
  },
  fix: async index => {
    const text = format(fixAll(cardAt(index).source(), { config: configSchema }))
    await cardAt(index).setSource(text)
    return checkSource(text, true)
  },
  open: url => navigate(url),
  search: query => library.find(query),
  exportText: (index, kind) => (kind === 'svg' ? cardAt(index).svgText() : cardAt(index).source()),
  check: source => checkSource(source, true),
  reference: () => loadReference(),
  base: () => location.href,
})
