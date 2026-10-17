// Kanban boards: columns and their items by indentation (the formatter leaves it alone), ids
// `id[text]`; the drawing's columns and items (id: the item's id).

import { t } from './i18n.js'
import { duplicates, NODE, scan, symbolList } from './type-core.js'

function symbols(lines) {
  const out = symbolList()
  lines.forEach((l, i) => {
    const h = scan(l, /^\s*([^()[\]\n{}@\s]+)\s*\[/)[0]
    if (h) out.add(h, i + 1, true)
  })
  return out.list
}

export default {
  id: 'kanban',
  name: 'Kanban',
  header: /^kanban\b/,
  looks: ['neo', 'handDrawn'],
  lexer: { keywords: ['kanban', 'assigned', 'ticket', 'priority', 'label', 'shape'], arrows: /^(?:@\{|::icon|:::)/ },
  indent: 'keep',
  symbols,
  idPattern: /^[^()[\]\n{}@\s]+$/,
  idHint: t('An ID cannot contain spaces, parentheses or @'),
  check(ctx) {
    const findings = duplicates(ctx.symbols, (name, line) =>
      t('Id {name} is already used on line {line}', { name, line }),
    )
    // The first node's indentation is the column level; an item less indented is an error.
    const nodes = ctx.lines.map((l, i) => ({ l, n: i + 1 })).filter(x => x.l.trim() && x.n !== ctx.header)
    const base = nodes.length ? /^\s*/.exec(nodes[0].l)[0].length : 0
    for (const x of nodes) {
      if (/^\s*/.exec(x.l)[0].length < base)
        findings.push({
          line: x.n,
          severity: 'error',
          rule: 'indent',
          message: t('This line is indented less than the first column'),
        })
      const p = /priority\s*:\s*['"]?([^'",}]+)/.exec(x.l)
      if (p && !['Very High', 'High', 'Low', 'Very Low'].includes(p[1].trim()))
        findings.push({
          line: x.n,
          severity: 'warning',
          rule: 'priority',
          message: t("priority must be 'Very High', 'High', 'Low' or 'Very Low'"),
        })
    }
    return findings
  },
  snippets: [
    [t('column'), t('${1:todo}[${2:To do}]')],
    [t('item'), t('${1:id}[${2:Task}]')],
    [
      t('item with data @{ }'),
      t("${1:id}[${2:Task}]@{ assigned: '${3:me}', priority: '${4|Very High,High,Low,Very Low|}' }"),
    ],
  ],
  starter: t('kanban\n\t${1:todo}[${2:To do}]\n\t\t${3:t1}[${4:Task}]\n\t${5:done}[${6:Done}]'),
  link: {
    kinds: [
      {
        selector: `${NODE}, g.cluster`,
        key: (rec, ctx) => (ctx.model.names.includes(rec.id) ? `node:${rec.id}` : undefined),
      },
    ],
  },
}
