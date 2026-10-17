// Mind maps: the hierarchy is the indentation (the formatter leaves it alone); the drawing's
// nodes "node_<n>" in source order.

import { t } from './i18n.js'
import { NODE } from './type-core.js'

// Node lines, in order (a `::icon()` or `:::class` line decorates the node before it; the lines
// after one that opens a quoted text, up to the one closing it, are that text: id["`a\nb`"]).
function items(lines) {
  const out = []
  let quoted = false
  lines.forEach((l, i) => {
    const t = l.trim()
    const continued = quoted
    if ((l.match(/"/g)?.length ?? 0) % 2) quoted = !quoted
    if (continued || !t || /^mindmap\b/.test(t) || /^(::icon\(|:::)/.test(t)) return
    out.push({ key: `node:${out.length}`, line: i + 1 })
  })
  return out
}

export default {
  id: 'mindmap',
  name: 'Mindmap',
  header: /^mindmap\b/,
  looks: ['neo', 'handDrawn'],
  layouts: ['tidy-tree'],
  lexer: { keywords: ['mindmap'], arrows: /^(?:\(\(|\)\)|\{\{|\}\}|\(-|-\)|::icon|:::)/ },
  indent: 'keep',
  items,
  check(ctx) {
    // Only one root: a second line as little indented as the first node starts another root.
    const nodes = items(ctx.lines).map(it => ({ line: it.line, width: /^\s*/.exec(ctx.lines[it.line - 1])[0].length }))
    const root = nodes[0]
    return nodes
      .slice(1)
      .filter(x => x.width <= root.width)
      .map(x => ({
        line: x.line,
        severity: 'error',
        rule: 'one-root',
        message: t('A mindmap has a single root: indent this line more than the root'),
      }))
  },
  snippets: [
    [t('square [text]'), t('${1:id}[${2:text}]')],
    [t('rounded (text)'), t('${1:id}(${2:text})')],
    [t('circle ((text))'), t('${1:id}((${2:text}))')],
    [t('cloud )text('), t('${1:id})${2:text}(')],
    [t('hexagon {{text}}'), t('${1:id}{{${2:text}}}')],
    [t('icon ::icon()'), '::icon(${1:fa fa-book})'],
  ],
  starter: t('mindmap\n\t${1:root}((${2:Topic}))\n\t\t${3:Branch}\n\t\t\t${4:Detail}'),
  link: {
    kinds: [{ selector: NODE, key: rec => (/^node_(\d+)$/.test(rec.id) ? `node:${rec.id.slice(5)}` : undefined) }],
  },
}
