// A drag handle that sets a panel's width, kept in this browser. A double click resets it.

import { store, stored } from './prefs.js'

const load = key => Number(stored(key)) || undefined
const save = (key, value) => store(key, String(Math.round(value)))

/**
 * Makes `handle` resize a panel: `apply(px)` sets its width, `start()` reads the width as a drag
 * begins; the width stays within [min, max()] pixels. `onEnd` runs once a drag or reset settles.
 */
export function splitter(handle, { key, start, apply, min, max, fallback, onEnd = () => {} }) {
  const clamp = px => Math.min(max(), Math.max(min, px))
  const stored = load(key)
  // On the next frame: the panel may not be laid out yet, and max() reads its container's size.
  if (stored) requestAnimationFrame(() => apply(clamp(stored)))
  handle.addEventListener('pointerdown', e => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = start()
    try {
      handle.setPointerCapture(e.pointerId) // keeps the drag when the pointer outruns the handle
    } catch {
      // a pointer the browser no longer tracks: the drag still works over the handle
    }
    document.body.classList.add('resizing')
    const move = ev => apply(clamp(w0 + ev.clientX - x0))
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing')
      save(key, start())
      onEnd()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  })
  handle.addEventListener('dblclick', () => {
    apply(clamp(fallback()))
    save(key, start())
    onEnd()
  })
}
