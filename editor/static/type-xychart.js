// XY charts: axes and bar/line plots; the drawing's plots "bar-plot-<k>" / "line-plot-<k>"
// (k counts the plots in order).

import { t } from './i18n.js'

function items(lines) {
  const out = []
  lines.forEach((l, i) => {
    if (/^\s*(bar|line)\b/.test(l)) out.push({ key: `plot:${out.length}`, line: i + 1 })
  })
  return out
}

export default {
  id: 'xychart',
  name: 'XY chart',
  header: /^xychart(-beta)?\b/i,
  lexer: {
    keywords: ['vertical', 'horizontal', 'title', 'x-axis', 'y-axis', 'line', 'bar', 'accTitle', 'accDescr'],
    caseInsensitive: true,
    arrows: /^-->/,
    numbers: true,
  },
  indent: 'depth',
  items,
  check(ctx) {
    const findings = []
    const cats = ctx.lines.map(l => /^\s*x-axis\b.*\[([^\]]*)\]/.exec(l)).find(Boolean)
    const n = cats ? cats[1].split(',').filter(x => x.trim()).length : 0
    ctx.lines.forEach((l, i) => {
      const m = /^\s*(bar|line)\b.*\[([^\]]*)\]/.exec(l)
      if (m && n && m[2].split(',').filter(x => x.trim()).length !== n)
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'length',
          message: t('{values} values, but the x-axis has {categories} categories', {
            values: m[2].split(',').filter(x => x.trim()).length,
            categories: n,
          }),
        })
    })
    if (!items(ctx.lines).length && ctx.header)
      findings.push({
        line: ctx.header,
        severity: 'error',
        rule: 'no-plot',
        message: t('Add at least one bar or line'),
      })
    return findings
  },
  snippets: [
    [t('bar'), 'bar [${1:1, 2, 3}]'],
    [t('line'), 'line [${1:1, 2, 3}]'],
    [t('x-axis categories'), 'x-axis [${1:a, b, c}]'],
    [t('y-axis range'), t('y-axis "${1:value}" ${2:0} --> ${3:100}')],
  ],
  starter: t(
    'xychart\n\ttitle "${1:Sales}"\n\tx-axis [${2:jan, feb, mar}]\n\ty-axis "${3:Amount}" 0 --> 100\n\tbar [${4:30, 60, 90}]',
  ),
  link: {
    kinds: [
      {
        selector: '[class*="-plot-"]',
        key: rec =>
          /(?:bar|line)-plot-(\d+)/.exec(rec.cls.join(' '))
            ? `plot:${/(?:bar|line)-plot-(\d+)/.exec(rec.cls.join(' '))[1]}`
            : undefined,
      },
    ],
  },
}
