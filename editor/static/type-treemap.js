// Treemaps: the hierarchy is the indentation (the formatter leaves it alone); sections
// `"Name"` and leaves `"Name": value`; the drawing's sections and leaves by their names.

import { t } from './i18n.js'
import { scan, symbolList, undeclared } from './type-core.js'

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
    const m = /^\s*("([^"]*)"|'([^']*)')/.exec(l)
    if (m && !out.some(it => it.name === (m[2] ?? m[3])))
      out.push({ key: `item:${m[2] ?? m[3]}`, name: m[2] ?? m[3], line: i + 1 })
  })
  return out
}

export default {
  id: 'treemap',
  name: 'Treemap',
  header: /^treemap(-beta)?\b/,
  lexer: { keywords: ['classDef', 'title', 'accTitle', 'accDescr'], arrows: /^:::/, numbers: true },
  indent: 'keep',
  symbols,
  items,
  idPattern: /^[A-Za-z_][\w-]*$/,
  check(ctx) {
    return undeclared(ctx.symbols, name => t('No classDef {name}', { name }))
  },
  snippets: [
    [t('section "name"'), t('"${1:name}"')],
    [t('leaf "name": value'), t('"${1:name}": ${2:10}')],
  ],
  starter: 'treemap\n"${1:Section}"\n\t"${2:Leaf A}": ${3:10}\n\t"${4:Leaf B}": ${5:20}',
  link: {
    kinds: [
      {
        selector: 'g.treemapSection, g.treemapNode',
        info: el => ({ label: el.querySelector('.treemapSectionLabel, .treemapLabel')?.textContent ?? '' }),
        key: rec => (rec.label ? `item:${rec.label}` : undefined),
      },
    ],
  },
}
