// Mermaid's measuring of labels, made to hold at every screen scale. Mermaid wraps an HTML label
// only when its measured width equals the wrapping width exactly; at a fractional scale (Windows at
// 175%) Chrome measures 120 as 120.0000153 or 200 as 200.0078125, the label stays on one line and
// its box cuts it off (mermaid-js/mermaid#7794). app.js draws through snappedSizes. Remove this
// module when Mermaid is upgraded to a release with the fix (mermaid-js/mermaid#8233).

// How close to a whole pixel a measure is taken for it: well above the error of a fractional
// scale, well below anything a label's text or layout tells apart.
const NEAR = 1 / 16

/** v, or the whole number it is within NEAR of. */
export function snapped(v) {
  const whole = Math.round(v)
  return Math.abs(v - whole) < NEAR ? whole : v
}

/**
 * What render() returns, with what an HTML element measures while it runs (getBoundingClientRect)
 * snapped to whole pixels; the elements measure as before once it settles, or fails.
 */
export async function snappedSizes(render, proto = globalThis.HTMLElement.prototype) {
  const had = Object.hasOwn(proto, 'getBoundingClientRect')
  const measure = proto.getBoundingClientRect
  proto.getBoundingClientRect = function () {
    const { x, y, width, height } = measure.call(this)
    const [w, h] = [snapped(width), snapped(height)]
    return {
      x,
      y,
      width: w,
      height: h,
      left: x,
      top: y,
      right: x + w,
      bottom: y + h,
      toJSON: () => ({ x, y, width: w, height: h }),
    }
  }
  try {
    return await render()
  } finally {
    if (had) proto.getBoundingClientRect = measure
    else delete proto.getBoundingClientRect // the inherited one (Element's) shows again
  }
}
