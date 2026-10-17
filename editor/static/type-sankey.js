// Sankey diagrams: CSV rows `source,target,value`; node names are the source and target fields
// (rename changes every row). The drawing's nodes in order of first appearance, links by row.

import { t } from './i18n.js'
import { symbolList } from './type-core.js'

// The fields of a CSV row with their 0-based columns (quoted fields keep their quotes).
function fields(line) {
  const out = []
  const re = /\s*("(?:[^"]|"")*"|[^,]*)\s*(,|$)/g
  let m
  while ((m = re.exec(line)) && m[0] !== '') {
    const start = m.index + m[0].indexOf(m[1])
    out.push({ text: m[1], col: start })
    if (!m[2]) break
  }
  return out
}

function symbols(lines) {
  const out = symbolList()
  lines.forEach((l, i) => {
    const t = l.trim()
    if (!t || /^sankey/.test(t)) return
    for (const f of fields(l).slice(0, 2)) {
      const quoted = f.text.startsWith('"')
      const name = quoted ? f.text.slice(1, -1) : f.text.trim()
      if (name)
        out.add({ name, start: f.col + (quoted ? 2 : 1), end: f.col + (quoted ? 2 : 1) + name.length }, i + 1, false)
    }
  })
  // A node is declared where it first appears.
  const seen = new Set()
  for (const s of out.list) if (!seen.has(s.name)) seen.add(s.name) && (s.def = true)
  return out.list
}

function items(lines) {
  const out = []
  lines.forEach((l, i) => {
    if (l.trim() && !/^\s*sankey/.test(l)) out.push({ key: `link:${out.length}`, line: i + 1 })
  })
  return out
}

export default {
  id: 'sankey',
  name: 'Sankey',
  header: /^sankey(-beta)?\b/,
  lexer: { keywords: [], numbers: true, id: /^[^,"\s][^,"]*?(?=\s*(,|$))/ },
  indent: 'keep',
  symbols,
  items,
  idPattern: /^[^,"\n]*[^,"\s]$/,
  idHint: t('A node name cannot contain commas or quotes'),
  check(ctx) {
    const findings = []
    ctx.lines.forEach((l, i) => {
      if (!l.trim() || i + 1 === ctx.header) return
      const f = fields(l)
      if (f.length !== 3)
        findings.push({
          line: i + 1,
          severity: 'error',
          rule: 'fields',
          message: t('Each line needs three fields (source,target,value), and this one has {count}', {
            count: f.length,
          }),
        })
      else if (Number.isNaN(parseFloat(f[2].text.replace(/"/g, ''))))
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'value',
          message: t('The third field (the value) is not a number'),
        })
    })
    return findings
  },
  snippets: [[t('flow source,target,value'), t('${1:source},${2:target},${3:10}')]],
  starter: 'sankey\n${1:A},${2:B},${3:10}\n${2:B},${4:C},${5:5}',
  link: {
    kinds: [
      {
        selector: 'g.nodes > g.node',
        key: (rec, ctx) => (ctx.model.names[rec.nth] !== undefined ? `node:${ctx.model.names[rec.nth]}` : undefined),
      },
      { selector: 'g.links > g.link', key: rec => `link:${rec.nth}` },
    ],
  },
}
