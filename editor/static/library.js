// The library sidebar, two tabs:
//   Conversations: every kept page, grouped by project and then by session, newest first; searched by words
//     (title, tags, project, diagram source) and filtered to this project, to edited pages or to
//     pinned ones. [ and ] step to the previous and next page in the list.
//   Project files: a project's documents and .mmd files that hold diagrams, by folder, searched by path
//     and source.

import { t } from './i18n.js'
/** Text for HTML markup, in an element or an attribute's double quotes. */
export const esc = s =>
  String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

// "2026-10-11T07-09-36-825" (UTC, the page id's form) as local "10/11 15:09".
export function when(stamp) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)/.exec(stamp ?? '')
  if (!m) return ''
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]))
  const pad = n => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A <select>'s options for projects; attrs(project) adds to an option's attributes. */
export const projectOptions = (projects, attrs) =>
  projects.map(p => `<option value="${esc(p.id)}"${attrs(p)}>${esc(p.name)}</option>`).join('')

/** A project's files by folder: [{ folder, files }], folders in path order. */
export function byFolder(files) {
  const folders = new Map()
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const folder = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
    if (!folders.has(folder)) folders.set(folder, [])
    folders.get(folder).push(f)
  }
  return [...folders]
    .map(([folder, list]) => ({ folder, files: list }))
    .sort((a, b) => (a.folder === '' ? -1 : b.folder === '' ? 1 : a.folder.localeCompare(b.folder)))
}

/** Pages grouped: [{ project, sessions: [{ session, pages }] }], groups in the order of their newest page. */
export function group(pages) {
  const projects = new Map()
  for (const p of pages) {
    const project = p.project || ''
    if (!projects.has(project)) projects.set(project, new Map())
    const sessions = projects.get(project)
    const session = p.session || ''
    if (!sessions.has(session)) sessions.set(session, [])
    sessions.get(session).push(p)
  }
  return [...projects].map(([project, sessions]) => ({
    project,
    sessions: [...sessions].map(([session, list]) => ({ session, pages: list })),
  }))
}

export class Library {
  /**
   * @param root the sidebar element
   * @param api (path) => JSON
   * @param go (url) => void: opens a page or file ([ and ])
   */
  constructor(root, api, go = url => (location.href = url)) {
    Object.assign(this, { root, api, go })
    this.current = { kind: 'page', diagrams: [] }
    this.filters = { here: false, edited: false, pinned: false }
    this.pages = []
    this.files = []
    this.tab = 'pages'
    this.projectId = ''
    root.innerHTML = `
      <div class="lib-tabs">
        <button data-tab="pages">${t('Conversations')}</button>
        <button data-tab="files">${t('Project files')}</button>
      </div>
      <div class="lib-head">
        <select class="lib-project" hidden></select>
        <input class="lib-search" type="search" placeholder="${t('Search titles, nodes, source…')}">
        <div class="chips">
          <button data-f="here" title="${t("Only this page's project")}">${t('This project')}</button>
          <button data-f="edited">${t('Edited')}</button>
          <button data-f="pinned">${t('Pinned')}</button>
        </div>
      </div>
      <nav class="lib-list"></nav>
      <div class="lib-foot">
        <span>[ ] ${t('Switch pages')}</span>
        <a href="/api/export.zip" title="${t('Every page in one zip')}">${t('Export all')}</a>
        <label class="lib-import" title="${t('Import an exported zip; pages already here are not overwritten')}">${t('Import')}<input type="file" accept=".zip,application/zip" hidden></label>
      </div>`
    this.list = root.querySelector('.lib-list')
    const search = root.querySelector('.lib-search')
    this.search = search
    root.querySelector('.lib-tabs').addEventListener('click', e => {
      const tab = e.target.closest('[data-tab]')?.dataset.tab
      if (tab && tab !== this.tab) {
        this.#switchTo(tab)
        this.refresh(search.value)
      }
    })
    root.querySelector('.lib-project').addEventListener('change', e => {
      this.projectId = e.target.value
      this.refresh(search.value)
    })
    let typing // the refresh once typing pauses
    search.addEventListener('input', () => {
      clearTimeout(typing)
      typing = setTimeout(() => this.refresh(search.value), 200)
    })
    root.querySelector('.chips').addEventListener('click', e => {
      const f = e.target.closest('[data-f]')?.dataset.f
      if (!f) return
      this.filters[f] = !this.filters[f]
      e.target.classList.toggle('on', this.filters[f])
      this.refresh(search.value)
    })
    this.list.addEventListener('click', e => {
      const diagram = e.target.closest('[data-diagram]')
      if (diagram) {
        document.getElementById(`card-${diagram.dataset.diagram}`)?.scrollIntoView({ behavior: 'smooth' })
        e.preventDefault()
      }
    })
    addEventListener('keydown', e => {
      // Not while typing: in a field, or in a card's source (where the browser has EditContext,
      // Monaco types through a div of its own, not a textarea).
      if (
        e.target.closest('input, textarea, select, [contenteditable], .monaco-editor') ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return
      if (e.key === '[' || e.key === ']') this.step(e.key === ']' ? 1 : -1)
    })
    this.query = ''
    root.querySelector('.lib-import input').addEventListener('change', async e => {
      const file = e.target.files?.[0]
      if (!file) return
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      })
      const result = await res.json().catch(() => ({}))
      const note = document.querySelector('#status')
      const malformed = result.malformed?.length ? t(', {n} malformed', { n: result.malformed.length }) : ''
      if (note)
        note.textContent = res.ok
          ? t('Imported {added} pages, skipped {skipped} (already here){malformed}', {
              added: result.added.length,
              skipped: result.skipped.length,
              malformed,
            })
          : t('Import failed: {error}', { error: result.error ?? res.status })
      e.target.value = ''
      this.refresh()
    })
  }

  /**
   * What the page shows now, its entry lit: { kind: 'page', id, project, diagrams } or
   * { kind: 'file', projectId, path, diagrams } (id or path missing: nothing chosen yet).
   * The search and the filters stay as they were.
   */
  show(current) {
    this.current = current
    this.#switchTo(current.kind === 'file' ? 'files' : 'pages')
    if (current.projectId) this.projectId = current.projectId
    return this.refresh()
  }

  // The projects are listed again as the files tab opens, else kept while it stays open.
  #projects = null
  #switchTo(tab) {
    if (tab !== this.tab) this.#projects = null
    this.tab = tab
  }

  /** Searches as typing in the search box does; what the list then shows: { pages } or { files }. */
  async find(query) {
    this.search.value = query
    await this.refresh(query)
    return this.tab === 'files' ? { projectId: this.projectId, files: this.files } : { pages: this.pages }
  }

  async refresh(query = this.query) {
    this.query = query
    for (const b of this.root.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === this.tab)
    const files = this.tab === 'files'
    this.root.querySelector('.chips').hidden = files
    this.root.querySelector('.lib-project').hidden = !files
    this.search.placeholder = files ? t('Search paths, nodes, source…') : t('Search titles, nodes, source…')
    if (files) return this.refreshFiles(query)
    const params = new URLSearchParams({ q: query })
    if (this.filters.here) params.set('project', this.current.project || '')
    const { pages } = await this.api(`/api/pages?${params}`)
    this.pages = pages.filter(p => (!this.filters.edited || p.edited) && (!this.filters.pinned || p.pinned))
    this.render()
  }

  async refreshFiles(query) {
    // A project not in the list kept (none yet, or one opened since) lists them again.
    if (!this.#projects?.some(p => p.id === this.projectId)) this.#projects = (await this.api('/api/projects')).projects
    const projects = this.#projects
    const select = this.root.querySelector('.lib-project')
    if (!projects.length) {
      select.innerHTML = ''
      this.list.innerHTML = `<div class="lib-empty">${t('No projects registered yet. Use Claude Code in a project, or run')}<br><code>mermaid_view.py --project ${t('DIR')}</code></div>`
      return
    }
    if (!projects.some(p => p.id === this.projectId)) this.projectId = projects[0].id
    select.innerHTML = projectOptions(projects, p => ` title="${esc(p.root)}"`)
    select.value = this.projectId
    const params = new URLSearchParams({ q: query })
    const { files } = await this.api(`/api/projects/${this.projectId}/files?${params}`)
    this.files = files
    this.renderFiles()
  }

  renderFiles() {
    if (!this.files.length) {
      this.list.innerHTML = `<div class="lib-empty">${this.query ? t('No matching files') : t('No file of this project holds Mermaid diagrams')}</div>`
      return
    }
    const here = this.current.kind === 'file' && this.current.projectId === this.projectId ? this.current.path : null
    const item = f => {
      const active = f.path === here
      const name = f.path.slice(f.path.lastIndexOf('/') + 1)
      const hits = (f.matches ?? [])
        .map(m => `<div class="hit">${t('Line {line}:', { line: m.line })} ${esc(m.text)}</div>`)
        .join('')
      const cards = active ? this.#diagramLinks() : ''
      return `<a class="page${active ? ' active' : ''}" href="/f/${esc(this.projectId)}?path=${encodeURIComponent(f.path)}">
          <div class="title">${f.kind === 'diagram' ? '◇ ' : ''}${esc(name)}</div>
          <div class="meta">${t('{n} ×', { n: f.count })} ${esc(f.kinds.join(' / '))}</div>${hits}
        </a>${cards}`
    }
    this.list.innerHTML = byFolder(this.files)
      .map(
        g => `<details open class="project"><summary>${esc(g.folder || t('(root)'))}<span class="count">${g.files.length}</span></summary>
          ${g.files.map(item).join('')}</details>`,
      )
      .join('')
    this.list.querySelector('.page.active')?.scrollIntoView({ block: 'nearest' })
  }

  // Under the entry shown, a link to each of its diagrams' cards when it has more than one.
  #diagramLinks() {
    const { diagrams } = this.current
    return diagrams.length > 1
      ? diagrams
          .map((_, i) => `<a href="#" class="sub" data-diagram="${i}">${t('Diagram {n}', { n: i + 1 })}</a>`)
          .join('')
      : ''
  }

  // The previous or next page (or file) in the list as shown.
  step(by) {
    if (this.tab === 'files') {
      const shown = byFolder(this.files).flatMap(g => g.files)
      const i = shown.findIndex(f => this.current.kind === 'file' && f.path === this.current.path)
      const next = shown[i < 0 ? 0 : i + by]
      if (next) this.go(`/f/${this.projectId}?path=${encodeURIComponent(next.path)}`)
      return
    }
    const i = this.pages.findIndex(p => p.id === this.current.id)
    const next = this.pages[i < 0 ? 0 : i + by]
    if (next) this.go(`/d/${next.id}`)
  }

  render() {
    if (!this.pages.length) {
      this.list.innerHTML = `<div class="lib-empty">${this.query ? t('No matching diagrams') : t('No pages')}</div>`
      return
    }
    const item = p => {
      const active = p.id === this.current.id
      const flags = `${p.pinned ? `<span class="pin" title="${t('Pinned')}">★</span>` : ''}${p.edited ? `<span class="dot" title="${t('Edited')}">●</span>` : ''}`
      const tags = p.tags.map(tag => `<span class="tag">#${esc(tag)}</span>`).join('')
      const hits = (p.matches ?? [])
        .map(
          m =>
            `<div class="hit">${t('Diagram {n} · line {line}', { n: m.diagram + 1, line: m.line })}: ${esc(m.text)}</div>`,
        )
        .join('')
      const cards = active ? this.#diagramLinks() : ''
      return `<a class="page${active ? ' active' : ''}" href="/d/${esc(p.id)}">
          <div class="title">${flags}${esc(p.title || p.id)}</div>
          <div class="meta">${when(p.created)} · ${t('{n} ×', { n: p.count })} ${esc(p.kinds.join(' / '))}${p.branch ? ` · ${esc(p.branch)}` : ''}</div>
          ${tags ? `<div class="tags">${tags}</div>` : ''}${hits}
        </a>${cards}`
    }
    this.list.innerHTML = group(this.pages)
      .map(
        g => `<details open class="project"><summary>${esc(g.project || t('No project'))}<span class="count">${g.sessions.reduce((n, s) => n + s.pages.length, 0)}</span></summary>
          ${g.sessions
            .map(
              s => `<details open class="session"><summary>${s.session ? t('Conversation {when}', { when: when(s.pages.at(-1).created) }) : t('Other')}<span class="count">${s.pages.length}</span></summary>
                ${s.pages.map(item).join('')}</details>`,
            )
            .join('')}</details>`,
      )
      .join('')
    this.list.querySelector('.page.active')?.scrollIntoView({ block: 'nearest' })
  }
}
