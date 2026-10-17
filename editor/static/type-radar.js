// Radar charts: axes (`axis a["A"], b`), curves (`curve c["C"]{1, 2}` or `{ a: 1 }` naming
// axes); the drawing's axes (in order), curves "radarCurve-<k>" and legend entries.

import { t } from './i18n.js'
import { duplicates, scan, symbolList } from './type-core.js'

const ID = '[\\w](?:[-\\w]*\\w)?'

// Axes are declared by `axis` lists; curves (`curve a["A"]{...}, b{...}`, the body may span lines)
// by `curve` lists, their `{ name: value }` entries naming axes. Options (`max 5`, `ticks 4`,
// `graticule polygon`, `showLegend true`) name nothing.
function symbols(lines) {
  const out = symbolList()
  let depth = 0 // inside a curve's { }
  lines.forEach((l, i) => {
    const n = i + 1
    const masked = l.replace(/"[^"]*"/g, s => ' '.repeat(s.length))
    if (!depth && /^\s*axis\b/.test(masked)) {
      for (const h of scan(masked, new RegExp(`(?:axis|,)\\s*(${ID})`))) out.add(h, n, true, 'axis')
      return
    }
    if (!depth && !/^\s*curve\b/.test(masked)) return
    // The curve list's own text (names) and its bodies (entries), split by brace depth.
    let outside = ''
    let inside = ''
    for (const ch of masked.split('')) {
      if (ch === '}') depth = Math.max(0, depth - 1)
      const body = depth > 0 || ch === '{'
      outside += body ? ' ' : ch
      inside += body ? ch : ' '
      if (ch === '{') depth++
    }
    for (const h of scan(outside, new RegExp(`(?:^\\s*curve\\s+|,\\s*)(${ID})`))) out.add(h, n, true, 'curve')
    for (const h of scan(inside, new RegExp(`(?:[{,]|^)\\s*(${ID})\\s*(?::\\s*|\\s+)(?=[-\\d.])`)))
      out.add(h, n, false, 'axis')
  })
  return out.list
}

// Curves in order (a line may declare several).
function items(lines, syms) {
  return syms.filter(s => s.def && s.kind === 'curve').map((s, k) => ({ key: `curve:${k}`, line: s.line }))
}

export default {
  id: 'radar',
  name: 'Radar',
  header: /^radar-beta\b/,
  lexer: {
    keywords: [
      'axis',
      'curve',
      'showLegend',
      'ticks',
      'max',
      'min',
      'graticule',
      'circle',
      'polygon',
      'true',
      'false',
      'title',
      'accTitle',
      'accDescr',
    ],
    numbers: true,
  },
  blocks: { braces: true },
  indent: 'depth',
  symbols,
  items,
  idPattern: /^[\w](?:[-\w]*\w)?$/,
  check(ctx) {
    // Axes and curves are named apart: a curve may share an axis's name.
    const findings = ['axis', 'curve'].flatMap(kind =>
      duplicates(ctx.symbols, (name, line) => t('{name} is already declared on line {line}', { name, line }), kind),
    )
    const axes = new Set(ctx.symbols.filter(s => s.def && s.kind === 'axis').map(s => s.name))
    for (const s of ctx.symbols)
      if (!s.def && !axes.has(s.name))
        findings.push({
          line: s.line,
          severity: 'warning',
          rule: 'undeclared',
          message: t('No axis {name}: this value is skipped', { name: s.name }),
        })
    return findings
  },
  snippets: [
    [t('axis'), 'axis ${1:a}["${2:A}"], ${3:b}["${4:B}"], ${5:c}["${6:C}"]'],
    [t('curve'), t('curve ${1:x}["${2:name}"]{${3:1, 2, 3}}')],
  ],
  starter: t(
    'radar-beta\n\ttitle ${1:Skills}\n\taxis ${2:a}["A"], ${3:b}["B"], ${4:c}["C"]\n\tcurve ${5:x}["${6:X}"]{${7:1, 2, 3}}',
  ),
  link: {
    kinds: [
      {
        selector: '[class^="radarCurve-"], [class^="radarLegendBox-"]',
        key: rec => `curve:${/-(\d+)$/.exec(rec.cls[0])?.[1]}`,
      },
      { selector: 'text.radarLegendText', key: rec => `curve:${rec.nth}` },
      { selector: 'text.radarAxisLabel, line.radarAxisLine', key: (rec, ctx) => axisKey(rec.nth, ctx) },
    ],
  },
}

// The nth axis, in declared order.
function axisKey(nth, ctx) {
  const axes = [...new Set(ctx.model.syms.filter(s => s.def && s.kind === 'axis').map(s => s.name))]
  return axes[nth] !== undefined ? `node:${axes[nth]}` : undefined
}
