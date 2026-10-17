// The link between a rendered diagram and its source, for any type: which drawn elements stand
// for which source element (the type's descriptor says, in link.kinds), so that a click in the
// drawing selects the element's lines and the caret's line lights its elements.

import { linkModel, typeOf } from './mermaid-lang.js'

/**
 * A drawn element as the descriptors read it: its id (the render's id taken off), data-id,
 * classes, text, its index among the elements of its kind, and what the kind's info() adds.
 */
export function recordOf(el, nth, prefix, kind) {
  const strip = id => (prefix && id.startsWith(`${prefix}-`) ? id.slice(prefix.length + 1) : id)
  return {
    id: strip(el.id || ''),
    dataId: el.getAttribute('data-id') ?? '',
    cls: [...el.classList],
    text: (el.textContent ?? '').trim().replace(/\s+/g, ' '),
    nth,
    ...(kind.info?.(el) ?? {}),
  }
}

/** The source element key of a drawn element's record, for the kind (an index in link.kinds) it was found by. */
export function keyOfRecord(text, rec, prefix = '', model = linkModel(text), desc = typeOf(text)) {
  return desc.link?.kinds[rec.kind]?.key(rec, { model, prefix })
}

/**
 * Links a rendered drawing (svg) to its source: hit(target) the element a click is on
 * ({ key, dom }), doms(key) its drawn elements, select(key) its source lines, keysAt(line) the
 * elements a line names, neighbors(key) the edges and nodes a node is connected by. `prefix` is the render's id (Mermaid 12 leads DOM ids with it).
 */
export function linkDrawing(svg, text, prefix, desc = typeOf(text)) {
  const model = linkModel(text, desc)
  const byEl = new Map()
  const byKey = new Map()
  for (const [k, kind] of (desc.link?.kinds ?? []).entries()) {
    ;[...svg.querySelectorAll(kind.selector)].forEach((el, nth) => {
      if (byEl.has(el)) return
      const key = keyOfRecord(text, { ...recordOf(el, nth, prefix, kind), kind: k }, prefix, model, desc)
      if (!key) return
      byEl.set(el, key)
      byKey.set(key, [...(byKey.get(key) ?? []), el])
    })
  }
  return {
    hit(target) {
      for (let x = target; x && x !== svg; x = x.parentElement) if (byEl.has(x)) return { key: byEl.get(x), dom: x }
      const r = desc.link?.resolve?.(target)
      return r && byEl.has(r) ? { key: byEl.get(r), dom: r } : undefined
    },
    doms: key => byKey.get(key) ?? [],
    select: key => model.select(key),
    keysAt: n => model.keysAt(n),
    neighbors: key => model.neighbors?.(key) ?? [],
  }
}
