// A diagram Claude shows arrives in this tab (the editor's event `show`): whether the tab may
// switch to it, or must offer it and keep what the person is working on; how the tab stands out
// among many (a dot on its icon, a notification where the person allowed them); and whether a tab
// out of view keeps listening for diagrams at all.

// How long after the last keystroke the person still counts as typing here.
export const TYPING_GRACE = 5000

// How long a hidden tab may go unused and still take a diagram: viewers.py's STALE, in ms.
export const STALE = 30 * 60 * 1000

/**
 * Whether the tab has work in progress a switch would interrupt: unsaved edits, a note for Claude
 * not yet sent (a switch clears it), or typing within TYPING_GRACE.
 */
export function editing({ unsaved = false, note = '', typedAt = -Infinity, now = Date.now() } = {}) {
  return unsaved || note.trim() !== '' || now - typedAt < TYPING_GRACE
}

/**
 * A system notification of a new diagram, when the browser has them and the person allowed them
 * for this page: it never asks (a prompt out of nowhere). A click brings the tab back and runs
 * onClick. Returns whether one was shown.
 */
export function notify(Notification, body, onClick = () => {}) {
  if (typeof Notification !== 'function' || Notification.permission !== 'granted') return false
  try {
    const n = new Notification('mermaid-view', { body, tag: 'mermaid-view-new' })
    n.onclick = () => {
      globalThis.focus?.()
      onClick()
      n.close()
    }
    return true
  } catch {
    return false // some browsers allow notifications from a service worker only
  }
}

/**
 * Whether the tab keeps its event stream open. A tab hidden and unused for STALE is passed over for
 * new diagrams anyway, so it lets its stream go: the browser keeps only six connections to the
 * editor, and every stream holds one of them for as long as it is open.
 */
export function listening({ visible, usedAt, now = Date.now() }) {
  return visible || now - usedAt < STALE
}

/**
 * The tab's icon as a data URL: a small diagram; with `marked`, a red dot on it, which still shows
 * when the tab strip is too crowded for titles.
 */
export function favicon(marked = false) {
  const dot = marked ? '<circle cx="21" cy="11" r="10.5" fill="#e5383b" stroke="#fff" stroke-width="2"/>' : ''
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<rect x="1" y="1" width="30" height="30" rx="7" fill="#0a66d8"/>' +
    '<path d="M11 10v6h10v6M11 16v6" fill="none" stroke="#fff" stroke-width="2"/>' +
    '<rect x="6" y="6" width="10" height="6" rx="1.5" fill="#fff"/>' +
    '<rect x="6" y="20" width="10" height="6" rx="1.5" fill="#fff"/>' +
    '<rect x="16" y="20" width="10" height="6" rx="1.5" fill="#fff"/>' +
    dot +
    '</svg>'
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
