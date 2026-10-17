// Quadrant charts: axes, quadrant labels, points (`name: [x, y]`) and classes (`classDef c`,
// `point:::c`); the drawing's quadrants (in order 1..4) and points (by name).

import { t } from './i18n.js'
import { colonAt, scan, symbolList, undeclared } from './type-core.js'

// The name neither starts nor ends with a space: no \s* beside it splits the same spaces again.
const POINT = /^\s*([^:\s](?:[^:\n]*?[^:\s])?)\s*(?::::\s*[\w-]+\s*)?:\s*\[/

function symbols(lines) {
  const out = symbolList()
  lines.forEach((l, i) => {
    let m
    if ((m = scan(l, /^\s*classDef\s+([\w-]+)/)).length) out.add(m[0], i + 1, true)
    for (const h of scan(l, /:::\s*([\w-]+)/)) out.add(h, i + 1)
  })
  return out.list
}

function items(lines) {
  const out = []
  lines.forEach((l, i) => {
    const q = /^\s*quadrant-([1-4])\b/.exec(l)
    if (q) out.push({ key: `quadrant:${Number(q[1]) - 1}`, line: i + 1 })
    const p = POINT.exec(l)
    if (p && !/^\s*(x-axis|y-axis|title|quadrant-|classDef)/.test(l))
      out.push({ key: `point:${p[1].replace(/^"|"$/g, '')}`, line: i + 1 })
  })
  return out
}

export default {
  id: 'quadrant',
  name: 'Quadrant chart',
  header: /^quadrantChart\b/,
  lexer: {
    keywords: [
      'title',
      'x-axis',
      'y-axis',
      'quadrant-1',
      'quadrant-2',
      'quadrant-3',
      'quadrant-4',
      'classDef',
      'radius',
      'color',
      'stroke-color',
      'stroke-width',
      'accTitle',
      'accDescr',
    ],
    caseInsensitive: true,
    arrows: /^(?:-{2,}>|:::)/,
    numbers: true,
    id: /^[A-Za-z_][\w-]*/,
  },
  indent: 'depth',
  symbols,
  items,
  idPattern: /^[A-Za-z_][\w-]*$/,
  check(ctx) {
    const findings = undeclared(ctx.symbols, name => t('No classDef {name}', { name }))
    ctx.lines.forEach((l, i) => {
      // Number() ignores the spaces around each value.
      const m = /:\s*\[([^,\]]*),([^\]]*)\]/.exec(l)
      if (m && colonAt(l) >= 0 && [m[1], m[2]].some(v => !(Number(v) >= 0 && Number(v) <= 1)))
        findings.push({
          line: i + 1,
          severity: 'error',
          rule: 'range',
          message: t('Coordinates must be between 0 and 1'),
        })
    })
    return findings
  },
  snippets: [
    [t('point name: [x, y]'), t('${1:name}: [${2:0.5}, ${3:0.5}]')],
    [t('x-axis'), t('x-axis ${1:Low} --> ${2:High}')],
    [t('y-axis'), t('y-axis ${1:Low} --> ${2:High}')],
  ],
  starter: t(
    'quadrantChart\n\ttitle ${1:Title}\n\tx-axis ${2:Low} --> ${3:High}\n\ty-axis ${4:Low} --> ${5:High}\n\tquadrant-1 ${6:Expand}\n\tquadrant-2 ${7:Promote}\n\tquadrant-3 ${8:Re-evaluate}\n\tquadrant-4 ${9:Improve}\n\t${10:A}: [0.3, 0.6]',
  ),
  link: {
    kinds: [
      { selector: 'g.quadrant', key: rec => `quadrant:${rec.nth}` },
      { selector: 'g.data-point', key: rec => `point:${rec.text}` },
    ],
  },
}
