// Packet diagrams: fields `start-end: "label"` or `+bits: "label"`; the drawing's blocks (a field
// that crosses a row is drawn in pieces), found by the bit each piece starts at.

import { t } from './i18n.js'

const ROW = /^\s*(?:(\d+)(?:-(\d+))?|\+(\d+))\s*:/

// Every field with its bit range, in order.
function items(lines) {
  const out = []
  let next = 0
  lines.forEach((l, i) => {
    const m = ROW.exec(l)
    if (!m) return
    const start = m[3] !== undefined ? next : Number(m[1])
    const end = m[3] !== undefined ? next + Number(m[3]) - 1 : m[2] !== undefined ? Number(m[2]) : start
    next = end + 1
    out.push({ key: `field:${out.length}`, line: i + 1, start, end })
  })
  return out
}

export default {
  id: 'packet',
  name: 'Packet',
  header: /^packet(-beta)?\b/,
  lexer: { keywords: ['title', 'accTitle', 'accDescr'], numbers: true },
  indent: 'depth',
  items,
  check(ctx) {
    const findings = []
    let next = 0
    for (const it of items(ctx.lines)) {
      if (it.end < it.start)
        findings.push({
          line: it.line,
          severity: 'error',
          rule: 'range',
          message: t('The end bit is lower than the start bit'),
        })
      else if (it.start !== next)
        findings.push({
          line: it.line,
          severity: 'error',
          rule: 'gap',
          message: t('This field should start at bit {next} (no gaps or overlaps)', { next }),
        })
      next = it.end + 1
    }
    return findings
  },
  snippets: [
    [t('field start-end'), t('${1:0}-${2:15}: "${3:name}"')],
    [t('field +bits'), t('+${1:8}: "${2:name}"')],
  ],
  starter: t('packet\n\ttitle ${1:Packet}\n\t0-15: "${2:Source Port}"\n\t16-31: "${3:Destination Port}"'),
  link: {
    kinds: [
      {
        selector: 'rect.packetBlock',
        // The piece's first bit: the start number drawn after it.
        info: el => {
          for (let x = el.nextElementSibling; x && !x.matches('rect.packetBlock'); x = x.nextElementSibling) {
            if (x.matches('text.packetByte.start')) return { bit: Number(x.textContent) }
          }
          return {}
        },
        key: (rec, ctx) => ctx.model.items.find(it => rec.bit >= it.start && rec.bit <= it.end)?.key,
      },
    ],
  },
}
