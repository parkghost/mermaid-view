// Zoom and pan of a rendered diagram, and its minimap.
//
// The wheel zooms about the pointer, a drag pans, a double click fits. A press that does not
// move is a click: onClick receives its target. The minimap shows the whole diagram and the
// part in view; a press or drag on it brings that part into view.

export const MAX_ZOOM = 30
export const MIN_ZOOM = 0.05
const FIT_MAX = 4 // fitting fills the view, but blows a small diagram up no further
const CLICK_SLOP = 4 // pixels a press may move and still be a click

export class Viewport {
  constructor(view, stage, label) {
    Object.assign(this, { view, stage, label })
    this.t = { x: 0, y: 0, k: 1 }
    this.listeners = []
    this.onClick = () => {}
    this.#bind()
  }

  get svg() {
    return this.stage.querySelector('svg')
  }

  /** The diagram's own size, unzoomed. */
  get size() {
    const svg = this.svg
    if (!svg) return { w: 0, h: 0 }
    const r = svg.getBoundingClientRect()
    return { w: r.width / this.t.k, h: r.height / this.t.k }
  }

  onChange(fn) {
    this.listeners.push(fn)
  }

  apply() {
    const { x, y, k } = this.t
    this.stage.style.transform = `translate(${x}px, ${y}px) scale(${k})`
    this.label.textContent = `${Math.round(k * 100)}%`
    for (const fn of this.listeners) fn()
  }

  zoomAt(factor, cx, cy) {
    const t = this.t
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.k * factor))
    t.x = cx - (cx - t.x) * (k / t.k)
    t.y = cy - (cy - t.y) * (k / t.k)
    t.k = k
    this.apply()
  }

  fit() {
    const { w, h } = this.size
    if (!w || !h) return
    const v = this.view
    const k = Math.min(FIT_MAX, (v.clientWidth - 24) / w, (v.clientHeight - 24) / h)
    this.t.k = k > 0 ? k : 1
    this.t.x = (v.clientWidth - w * this.t.k) / 2
    this.t.y = (v.clientHeight - h * this.t.k) / 2
    this.apply()
  }

  /** Brings the diagram's point (x, y), in its own units, to the middle of the view. */
  centerOn(x, y) {
    this.t.x = this.view.clientWidth / 2 - x * this.t.k
    this.t.y = this.view.clientHeight / 2 - y * this.t.k
    this.apply()
  }

  /** Brings an element of the diagram into view, zoomed in to at least `minK`. */
  reveal(el, minK = 1) {
    const svg = this.svg
    if (!svg || !el) return
    const s = svg.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (this.t.k < minK) this.t.k = minK
    this.centerOn(
      ((r.left + r.right) / 2 - s.left) / (s.width / this.size.w),
      ((r.top + r.bottom) / 2 - s.top) / (s.height / this.size.h),
    )
  }

  zoomIn() {
    this.zoomAt(1.25, this.view.clientWidth / 2, this.view.clientHeight / 2)
  }

  zoomOut() {
    this.zoomAt(0.8, this.view.clientWidth / 2, this.view.clientHeight / 2)
  }

  actual() {
    Object.assign(this.t, { k: 1, x: 12, y: 12 })
    this.apply()
  }

  #bind() {
    const { view } = this
    view.addEventListener(
      'wheel',
      e => {
        e.preventDefault()
        const r = view.getBoundingClientRect()
        this.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top)
      },
      { passive: false },
    )
    let drag
    view.addEventListener('pointerdown', e => {
      if (e.target.closest('.mv-minimap')) return
      e.preventDefault() // a press here pans or picks; it never starts a text selection
      drag = { x: e.clientX - this.t.x, y: e.clientY - this.t.y, sx: e.clientX, sy: e.clientY, moved: false }
      view.setPointerCapture(e.pointerId)
    })
    view.addEventListener('pointermove', e => {
      if (!drag) return
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > CLICK_SLOP) {
        drag.moved = true
        view.classList.add('dragging')
      }
      if (!drag.moved) return
      this.t.x = e.clientX - drag.x
      this.t.y = e.clientY - drag.y
      this.apply()
    })
    const end = e => {
      if (drag && !drag.moved && e.type === 'pointerup') {
        // Capture retargets the event to the view: find what lies under the pointer.
        const under = document.elementFromPoint(e.clientX, e.clientY)
        if (under) this.onClick(under)
      }
      drag = undefined
      view.classList.remove('dragging')
    }
    view.addEventListener('pointerup', end)
    view.addEventListener('pointercancel', end)
    view.addEventListener('dblclick', () => this.fit())
  }
}

/** The minimap of a viewport: an image of the whole diagram and a frame around the part in view. */
export class Minimap {
  constructor(box, viewport) {
    Object.assign(this, { box, viewport })
    box.innerHTML = '<img alt=""><div class="frame"></div>'
    this.img = box.querySelector('img')
    this.frame = box.querySelector('.frame')
    viewport.onChange(() => this.place())
    this.#bind()
  }

  /** Redraws the image from the diagram as rendered now. */
  update() {
    const svg = this.viewport.svg
    if (!svg) return
    const { w, h } = this.viewport.size
    const copy = svg.cloneNode(true)
    copy.setAttribute('width', w)
    copy.setAttribute('height', h)
    copy.querySelectorAll('.mv-hit, .mv-related').forEach(el => el.classList.remove('mv-hit', 'mv-related'))
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }))
    this.img.onload = () => {
      URL.revokeObjectURL(url)
      this.place()
    }
    this.img.src = url
    this.ratio = w / h
  }

  // The image fills the box's width or height; the frame is the view in diagram units, scaled.
  #scale() {
    const { w } = this.viewport.size
    return w ? this.img.clientWidth / w : 0
  }

  place() {
    const s = this.#scale()
    if (!s) return
    const { view, t } = this.viewport
    const f = this.frame.style
    f.left = `${this.img.offsetLeft + (-t.x / t.k) * s}px`
    f.top = `${this.img.offsetTop + (-t.y / t.k) * s}px`
    f.width = `${(view.clientWidth / t.k) * s}px`
    f.height = `${(view.clientHeight / t.k) * s}px`
  }

  #bind() {
    let dragging = false
    const go = e => {
      const s = this.#scale()
      if (!s) return
      const r = this.img.getBoundingClientRect()
      this.viewport.centerOn((e.clientX - r.left) / s, (e.clientY - r.top) / s)
    }
    this.box.addEventListener('pointerdown', e => {
      e.stopPropagation()
      e.preventDefault()
      dragging = true
      this.box.setPointerCapture(e.pointerId)
      go(e)
    })
    this.box.addEventListener('pointermove', e => dragging && go(e))
    this.box.addEventListener('pointerup', () => (dragging = false))
    this.box.addEventListener('pointercancel', () => (dragging = false))
    this.box.addEventListener('wheel', e => e.stopPropagation(), { passive: true })
  }
}
