// A diagram's history, newest first: for a page, every saved version (a commit of the editor's
// data folder); for a project file, the project's commits that changed it. Each is comparable
// with the source now and restorable; a page's versions can also be named.

import { t } from './i18n.js'
import { esc } from './library.js'
import { lineDiff } from './mermaid-lang.js'

const at = seconds => {
  const d = new Date(seconds * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** A line diff as unified-style text (for the diff view). */
export function diffText(from, to) {
  return lineDiff(from, to)
    .map(l => l.op + l.text)
    .join('\n')
}

export class VersionPanel {
  /**
   * @param box the panel element
   * @param o { history: () => { enabled, commits }, version: commit => text, label?: (commit, name) => void,
   *   current: () => text, restore: text => void, compare: (diffText, caption) => void, empty: string }
   */
  constructor(box, o) {
    Object.assign(this, { box, o })
    box.classList.add('versions')
    box.addEventListener('click', e => this.#act(e))
  }

  async open() {
    this.box.hidden = false
    this.box.innerHTML = `<div class="v-head">${t('Version history')}<button data-v="close" title="${t('Close')}">✕</button></div><div class="v-empty">${t('Loading…')}</div>`
    const { enabled, commits } = await this.o.history()
    this.commits = commits
    const list = !enabled
      ? `<div class="v-empty">${t('This computer has no git: version history is off.')}</div>`
      : !commits.length
        ? `<div class="v-empty">${this.o.empty}</div>`
        : commits
            .map(
              (c, i) => `<div class="v-row" data-i="${i}">
                <div class="v-time">${at(c.time)}${i === 0 ? ` <span class="v-now">${t('Latest')}</span>` : ''}${i === commits.length - 1 ? ` <span class="v-first">${t('Original')}</span>` : ''}</div>
                ${c.label ? `<div class="v-label">🏷 ${esc(c.label)}</div>` : ''}
                <div class="v-msg">${esc(c.message)}</div>
                <div class="v-acts">
                  <button data-v="compare">${t('Compare')}</button>
                  <button data-v="restore">${t('Restore this version')}</button>
                  ${this.o.label ? `<button data-v="name">${c.label ? t('Rename') : t('Name')}</button>` : ''}
                </div>
              </div>`,
            )
            .join('')
    this.box.innerHTML = `<div class="v-head">${t('Version history')}<button data-v="close" title="${t('Close')}">✕</button></div><div class="v-list">${list}</div>`
  }

  close() {
    this.box.hidden = true
  }

  toggle() {
    if (this.box.hidden) this.open()
    else this.close()
  }

  async #version(c) {
    return this.o.version(c.commit)
  }

  async #act(e) {
    const action = e.target.closest('[data-v]')?.dataset.v
    if (action === 'close') return this.close()
    const row = e.target.closest('.v-row')
    const c = row && this.commits[Number(row.dataset.i)]
    if (!c || !action) return
    if (action === 'compare') {
      this.o.compare(
        diffText(await this.#version(c), this.o.current()),
        t('Compared with the version of {when} (- then, + now)', { when: at(c.time) }),
      )
    } else if (action === 'restore') {
      this.o.restore(await this.#version(c)) // one undoable edit; saving it makes a new version
    } else if (action === 'name' && this.o.label) {
      // An inline field, not a dialog: Enter names, Escape leaves it.
      const input = document.createElement('input')
      input.className = 'v-input'
      input.value = c.label
      input.placeholder = t('Version name (empty removes it)')
      row.querySelector('.v-acts').replaceWith(input)
      input.focus()
      input.addEventListener('keydown', async ev => {
        if (ev.key === 'Escape') return this.open()
        if (ev.key !== 'Enter') return
        await this.o.label(c.commit, input.value)
        this.open()
      })
    }
  }
}
