// Pie charts: `"label" : value` slices; the drawing's slices (those of at least 1%, in order),
// their percentages and the legend (every slice, in order).

import { t } from './i18n.js'

const SLICE = /^\s*("[^"]*"|'[^']*')\s*:\s*(-?\d+(?:\.\d+)?)/

// The slices, first of each label only (Mermaid drops a repeated one), with their drawn index.
function items(lines) {
  const seen = new Set()
  const out = []
  lines.forEach((l, i) => {
    const m = SLICE.exec(l)
    if (!m || seen.has(m[1])) return
    seen.add(m[1])
    out.push({ key: `slice:${out.length}`, line: i + 1, value: Number(m[2]) })
  })
  const sum = out.reduce((a, b) => a + b.value, 0)
  let drawn = 0
  for (const it of out)
    if (sum && (it.value / sum) * 100 >= 1 && ((it.value / sum) * 100).toFixed(0) !== '0') it.drawn = drawn++
  return out
}

export default {
  id: 'pie',
  name: 'Pie',
  header: /^pie\b/,
  lexer: { keywords: ['showData', 'title', 'accTitle', 'accDescr'], numbers: true },
  indent: 'depth',
  items,
  check(ctx) {
    const findings = []
    const seen = new Map()
    ctx.lines.forEach((l, i) => {
      const m = SLICE.exec(l)
      if (!m) return
      if (seen.has(m[1]))
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'duplicate',
          message: t('{label} already appears on line {line}: this slice is skipped', {
            label: m[1],
            line: seen.get(m[1]),
          }),
        })
      else seen.set(m[1], i + 1)
      if (Number(m[2]) < 0)
        findings.push({ line: i + 1, severity: 'error', rule: 'negative', message: t('Pie values cannot be negative') })
    })
    return findings
  },
  snippets: [[t('slice "label" : value'), t('"${1:label}" : ${2:10}')]],
  starter: t('pie title ${1:Title}\n\t"${2:A}" : ${3:40}\n\t"${4:B}" : ${5:60}'),
  link: {
    kinds: [
      { selector: 'path.pieCircle', key: (rec, ctx) => ctx.model.items.find(x => x.drawn === rec.nth)?.key },
      { selector: 'text.slice', key: (rec, ctx) => ctx.model.items.find(x => x.drawn === rec.nth)?.key },
      { selector: 'g.legend', key: rec => `slice:${rec.nth}` },
    ],
  },
}
