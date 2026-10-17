// Block diagrams: blocks (any id on a node line, `block:id`), nested `block ... end`, edges;
// the drawing's blocks (id: the block's id) and edges "<render>-<n>-<from>-<to>".

import { t } from './i18n.js'
import { mask, NODE, symbolList } from './type-core.js'

const KEY =
  /^(block|end|columns|space|classDef|class|style|linkStyle|default|interpolate|accTitle|accDescr|title|auto|right|left|up|down|x|y)$/
const LINK = /~~~+|[xo<]?(?:--+[-xo>]|==+[=xo>]|-?\.+-[xo>]?)|[xo<]?(?:--|==|-\.)/g

// The line with every bracket's contents, quoted text and comments blanked, and `:N` widths gone.
function bare(line) {
  const m = mask(line)
  let out = ''
  let depth = 0
  for (const ch of m) {
    if ('([{'.includes(ch)) depth++
    out += depth ? ' ' : ch
    if (')]}'.includes(ch)) depth = Math.max(0, depth - 1)
  }
  return out.replace(/:\d+\b/g, s => ' '.repeat(s.length)).replace(/<(?=\s)|(?<=\s)>/g, ' ')
}

function symbols(lines) {
  const out = symbolList()
  lines.forEach((l, i) => {
    const t = l.trim()
    if (!t || (/^block(-beta)?\s*$/.test(t) && i === 0)) return
    if (/^(classDef|columns|accTitle|accDescr|title|linkStyle)\b/.test(t)) return
    let line = bare(l)
    const composite = /^(\s*block:)([^\s:]+)/.exec(line)
    if (composite) {
      out.add(
        { name: composite[2], start: composite[1].length + 1, end: composite[1].length + 1 + composite[2].length },
        i + 1,
        true,
      )
      return
    }
    const m = /^(\s*(?:class|style)\s+)(\S+)/.exec(line)
    if (m) {
      let col = m[1].length
      for (const name of m[2].split(',')) {
        if (name) out.add({ name, start: col + 1, end: col + 1 + name.length }, i + 1)
        col += name.length + 1
      }
      return
    }
    line = line.replace(LINK, s => ' '.repeat(s.length))
    for (const m of line.matchAll(/[^\s([\]{}<>:=\-)]+/g)) {
      if (KEY.test(m[0]) || /^\d/.test(m[0])) continue
      out.add({ name: m[0], start: m.index + 1, end: m.index + 1 + m[0].length }, i + 1)
    }
  })
  const seen = new Set()
  for (const s of out.list) if (!seen.has(s.name)) seen.add(s.name) && (s.def = true)
  return out.list
}

// Edges: each `from LINK to` on a line, in order.
function items(lines) {
  const out = []
  lines.forEach((l, i) => {
    const line = bare(l)
    const parts = [...line.matchAll(/([^\s([\]{}<>:=\-)]+)|(~~~+|[xo<]?(?:--+[-xo>]|==+[=xo>]|-?\.+-[xo>]?))/g)]
    for (let k = 0; k + 2 < parts.length; k++) {
      if (parts[k][1] && parts[k + 1][2] && parts[k + 2][1])
        out.push({ key: `edge:${out.length}`, line: i + 1, from: parts[k][1], to: parts[k + 2][1] })
    }
  })
  return out
}

export default {
  id: 'block',
  name: 'Block',
  header: /^block(-beta)?\b/,
  looks: ['neo', 'handDrawn'],
  lexer: {
    keywords: [
      'block',
      'end',
      'columns',
      'space',
      'classDef',
      'class',
      'style',
      'linkStyle',
      'default',
      'interpolate',
      'auto',
      'accTitle',
      'accDescr',
    ],
    arrows: /^(?:~~~+|[xo<]?(?:--+[-xo>]|==+[=xo>]|-?\.+-[xo>]?)|[xo<]?(?:--|==|-\.))/,
    id: /^[^\s([\]{}<>:=\-)"%,;&@|]+/,
    numbers: true,
  },
  blocks: { open: /^block(:|\s*$)/, close: /^end\b/ },
  indent: 'depth',
  symbols,
  items,
  idPattern: /^[^\s([\]{}<>:=\-)"]+$/,
  idHint: t('A block ID cannot contain spaces, parentheses or symbols such as - and :'),
  check(ctx) {
    const findings = []
    // `style X` before X exists (or on several ids) fails when drawing.
    const firstAt = new Map()
    for (const s of ctx.symbols) {
      const styleLine = /^\s*style\s/.test(ctx.lines[s.line - 1])
      if (!styleLine && !firstAt.has(s.name)) firstAt.set(s.name, s.line)
      if (styleLine && !(firstAt.get(s.name) < s.line))
        findings.push({
          line: s.line,
          severity: 'error',
          rule: 'style-undeclared',
          message: t('Put this style after the line that defines {name}', { name: s.name }),
        })
    }
    ctx.lines.forEach((l, i) => {
      if (/^\s*style\s+\S+,/.test(l))
        findings.push({
          line: i + 1,
          severity: 'error',
          rule: 'style-list',
          message: t('style takes one block: write one style line per block'),
        })
      if (
        /[[({]\s*[^"\s[({)\]}][^"\])}]*[\])}]/.test(l.replace(/"[^"]*"/g, '""')) &&
        !/^\s*(classDef|class|style|columns)\b/.test(l) &&
        !/<\[/.test(l)
      ) {
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'label-quote',
          message: t('Put the block text in double quotes'),
        })
      }
    })
    return findings
  },
  snippets: [
    [t('Block id["text"]'), t('${1:id}["${2:text}"]')],
    [t('columns'), 'columns ${1:3}'],
    [t('block: … end'), 'block:${1:group}:${2:2}\n\t$0\nend'],
    [t('space'), 'space'],
    [t('Edge -->'), '${1:a} --> ${2:b}'],
  ],
  starter: 'block\n\tcolumns ${1:3}\n\t${2:a}["${3:A}"] ${4:b}["${5:B}"] ${6:c}["${7:C}"]\n\t${2:a} --> ${4:b}',
  link: {
    kinds: [
      { selector: NODE, key: (rec, ctx) => (ctx.model.names.includes(rec.id) ? `node:${rec.id}` : undefined) },
      { selector: '[data-id]', key: (rec, ctx) => edgeKey(rec.dataId, ctx) },
    ],
    resolve: target => target.closest('.edgeLabel')?.querySelector('[data-id]'),
  },
}

// "<render>-<n>-<from>-<to>" (a label's data-id lacks the render id): the edge with those ends.
function edgeKey(dataId, ctx) {
  const id = ctx.prefix && dataId.startsWith(`${ctx.prefix}-`) ? dataId.slice(ctx.prefix.length + 1) : dataId
  const m = /^\d+-([^-]+)-([^-]+)$/.exec(id)
  return m ? ctx.model.items.find(it => it.from === m[1] && it.to === m[2])?.key : undefined
}
