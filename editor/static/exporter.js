// A diagram out of the page: its source (.mmd), its drawing (SVG, PNG) or a Markdown block.

/** A file name from a title: the characters file systems refuse become dashes. */
export function fileName(title, suffix) {
  const base =
    String(title || 'diagram')
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'diagram'
  return `${base}${suffix}`
}

/** Has the browser save a blob under a name. */
export function download(name, blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * The fence a block of these lines needs: ```, or one longer than every line that Markdown would
 * read as closing it (up to three spaces, a run of `, then only spaces or tabs), so that the block
 * ends where it should and reads back the same.
 */
function fenceFor(lines) {
  const longest = lines.reduce((n, line) => Math.max(n, /^ {0,3}(`+)[ \t]*$/.exec(line)?.[1].length ?? 0), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

export function markdownBlock(source) {
  const body = source.replace(/\n+$/, '')
  const fence = fenceFor(body.split('\n'))
  return `${fence}mermaid\n${body}\n${fence}\n`
}

/** An SVG's markup with its natural size in pixels, from its viewBox. */
export function sizedSvg(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const svg = doc.documentElement
  const box = svg.viewBox?.baseVal
  const w = box?.width || parseFloat(svg.getAttribute('width')) || 800
  const h = box?.height || parseFloat(svg.getAttribute('height')) || 600
  svg.setAttribute('width', String(w))
  svg.setAttribute('height', String(h))
  svg.removeAttribute('style') // mermaid's max-width
  return { text: new XMLSerializer().serializeToString(svg), w, h }
}

// The longest side a canvas is drawn at: browsers give a larger canvas no image (Safari's limit
// is 16384, Chrome's 32767).
export const MAX_SIDE = 16384

/**
 * A PNG's size in pixels for a `w` by `h` drawing: `scale` times it, or a set `width` or `height`
 * with the other side in proportion; within MAX_SIDE, keeping the proportion.
 */
export function pngSize(w, h, { scale, width, height }) {
  const k = width > 0 ? width / w : height > 0 ? height / h : scale > 0 ? scale : 2
  const fit = Math.min(k, MAX_SIDE / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * fit)), height: Math.max(1, Math.round(h * fit)) }
}

/**
 * A PNG of an SVG at `size` (see pngSize), on `background`. The SVG goes in as a data: URL: a
 * canvas that drew HTML labels (foreignObject) from a blob: URL cannot be read back in Chrome.
 * Where it cannot be read back all the same (Safari), this fails with a SecurityError.
 */
export async function pngOf(svgText, size, background) {
  const { text, w, h } = sizedSvg(svgText)
  const px = pngSize(w, h, size)
  const img = new Image()
  img.decoding = 'sync'
  await new Promise((resolve, reject) => {
    img.onload = resolve
    img.onerror = () => reject(new Error('the drawing could not be read as an image'))
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
  })
  const canvas = document.createElement('canvas')
  canvas.width = px.width
  canvas.height = px.height
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return await new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('the image could not be made'))), 'image/png'),
  )
}

/**
 * Puts an image on the clipboard. `blob` may be a promise: the clipboard is asked at once, while
 * the click that asked for it still counts (Safari refuses a write after an await).
 */
export function copyImage(blob, clipboard = navigator.clipboard) {
  return clipboard.write([new ClipboardItem({ 'image/png': Promise.resolve(blob) })])
}

/**
 * A link that opens a diagram in the Mermaid Live Editor, drawn with `config` (theme, look,
 * layout). The diagram rides in the link's #fragment (the Live Editor's pako: state: its JSON
 * deflated, base64url), which the browser never sends to a server.
 */
export async function liveEditorUrl(code, config = {}) {
  const state = JSON.stringify({
    code,
    mermaid: JSON.stringify(config, null, 2),
    grid: true,
    panZoom: true,
    rough: false,
    updateDiagram: true,
  })
  const zipped = new Blob([state]).stream().pipeThrough(new CompressionStream('deflate'))
  const bytes = new Uint8Array(await new Response(zipped).arrayBuffer())
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  const base64url = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `https://mermaid.live/edit#pako:${base64url}`
}
