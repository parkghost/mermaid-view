// The documents a page of the editor works on, behind one shape the cards use:
//   a PageDoc: diagrams Claude wrote in a conversation, kept by the editor (its own git history);
//   a FileDoc: a project's Markdown document or .mmd file, edited in place (the project's git).
//
// Both give: title, kind, diagrams [{ index, text, base, line }], save(index, text) ->
// { changed, diff }, history(index), version(index, commit), label (or null), send(note),
// and the words the page shows for them.

import { lang, t } from './i18n.js'
import { diffText } from './versions.js'

export class ConflictError extends Error {
  constructor() {
    super(t('The file changed on disk'))
  }
}

export class PageDoc {
  kind = 'page'
  baseName = t("Claude's original")

  constructor(api, id) {
    Object.assign(this, { api, id })
  }

  async load() {
    this.page = await this.api(`/api/pages/${this.id}`)
    this.title = this.page.title || this.id
    this.diagrams = this.page.diagrams.map(d => ({
      index: d.index,
      text: d.edited ?? d.original,
      base: d.original,
      diff: d.diff,
      line: 0,
    }))
    return this
  }

  name(d) {
    return t('Diagram {n}', { n: d.index + 1 })
  }

  badge(changed) {
    return changed ? t('Edited') : t('Original')
  }

  async save(index, text) {
    const saved = await this.api(`/api/pages/${this.id}/${index}`, { method: 'PUT', body: JSON.stringify({ text }) })
    return { changed: saved.edited !== null, diff: saved.diff }
  }

  history(index) {
    return this.api(`/api/pages/${this.id}/${index}/history`)
  }

  async version(index, commit) {
    return (await this.api(`/api/pages/${this.id}/${index}/version/${commit}`)).text
  }

  label(commit, name) {
    return this.api(`/api/pages/${this.id}/label`, { method: 'POST', body: JSON.stringify({ commit, name }) })
  }

  send(note) {
    return this.api(`/api/pages/${this.id}/send`, { method: 'POST', body: JSON.stringify({ note, lang }) })
  }

  get exportUrl() {
    return `/api/pages/${this.id}/export.md?lang=${encodeURIComponent(lang)}`
  }
}

export class FileDoc {
  kind = 'file'
  label = null // a project's commits are named by its own git, not here
  // Every diagram's save carries the file's one version, so they go one at a time, each on the
  // version the one before it left; and a read of the file while one is on its way may be older
  // than it (fresh() then has nothing to say).
  #saving = Promise.resolve()
  #pending = 0
  #version // the file's version the next save is made on

  constructor(api, projectId, path) {
    Object.assign(this, { api, projectId, path })
    this.base = `/api/projects/${projectId}`
    this.q = `path=${encodeURIComponent(path)}`
  }

  async load() {
    this.file = await this.api(`${this.base}/file?${this.q}`)
    this.#version = this.file.version
    this.title = this.path
    this.project = this.file.project
    this.baseName = this.file.tracked ? t('the last commit (HEAD)') : t('what Claude last wrote')
    this.diagrams = this.file.diagrams.map(d => {
      const base = this.baseOf(d)
      return { index: d.index, text: d.text, base, line: d.line, diff: this.diff(base, d.text) }
    })
    return this
  }

  /** What a diagram of the file (as the server reads it) is compared with: the last commit; in a
   * file git does not track yet, what Claude last wrote, else itself as read. */
  baseOf(d) {
    return d.head ?? d.seen ?? (this.file.tracked ? '' : d.text)
  }

  name(d) {
    return this.file.kind === 'markdown'
      ? t('Diagram {n} · line {line}', { n: d.index + 1, line: d.line })
      : t('Diagram')
  }

  badge(changed) {
    if (!this.file.tracked) return t('Not in git')
    return changed ? t('Uncommitted changes') : t('Same as HEAD')
  }

  /** A diagram's diff from its base, as the card shows it: '' when they do not differ. */
  diff(base, text) {
    return base.trim() === text.trim() ? '' : `--- ${this.baseName}\n+++ ${t('now')}\n${diffText(base, text)}`
  }

  async save(index, text) {
    this.#pending++
    const run = this.#saving.then(() => this.#put(index, text))
    this.#saving = run.catch(() => {})
    try {
      return await run
    } finally {
      this.#pending--
    }
  }

  async #put(index, text) {
    const body = JSON.stringify({ index, text, version: this.#version })
    try {
      this.#version = (await this.api(`${this.base}/file?${this.q}`, { method: 'PUT', body })).version
    } catch (err) {
      throw err.status === 409 ? new ConflictError() : err
    }
    const d = this.diagrams[index]
    d.text = text
    const diff = this.diff(d.base, text)
    return { changed: diff !== '', diff }
  }

  /** The file as it is on disk now; null when neither it nor the commit checked out changed
   * since this page last saved or took it, or when a save went in meanwhile (this read may be
   * older than it). `changed`: its text did (not just the commit). */
  async fresh() {
    if (this.#pending) return null
    const asked = this.#version
    const have = `&version=${encodeURIComponent(asked)}&head=${encodeURIComponent(this.file.head)}`
    const file = await this.api(`${this.base}/file?${this.q}${have}`)
    if (file.unchanged || this.#pending || this.#version !== asked) return null // unchanged: the server saw both still hold
    if (file.version === this.#version && file.head === this.file.head) return null
    return { ...file, changed: file.version !== this.#version }
  }

  /** Takes the disk's version as the one edits continue from (after a conflict or a reload). */
  adopt(file) {
    this.#version = file.version
    this.file.head = file.head
    this.file.tracked = file.tracked
  }

  async history() {
    const { enabled, commits } = await this.api(`${this.base}/history?${this.q}`)
    return { enabled, commits: commits.map(c => ({ ...c, label: '', message: `${c.message}（${c.author}）` })) }
  }

  async version(index, commit) {
    return (await this.api(`${this.base}/version?${this.q}&index=${index}&commit=${commit}`)).text
  }

  send(note) {
    return this.api(`${this.base}/send?${this.q}`, { method: 'POST', body: JSON.stringify({ note, lang }) })
  }

  get exportUrl() {
    return null
  }
}
