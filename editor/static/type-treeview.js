// Tree views: files and folders by indentation (the formatter leaves it alone); the drawing's
// labels, by their text.

import { t } from './i18n.js'
import { keyByText } from './type-core.js'

function items(lines) {
  const out = []
  lines.forEach((l, i) => {
    const t = l.trim()
    if (!t || /^treeView-beta\b/.test(t) || /^(title|accTitle|accDescr)\b/.test(t)) return
    const label = t
      .replace(/\s+(:::|icon\(|##).*$/, '')
      .replace(/^["'](.*)["']$/, '$1')
      .replace(/\/$/, '')
    out.push({ key: `node:${out.length}`, line: i + 1, label })
  })
  return out
}

export default {
  id: 'treeView',
  name: 'Tree view',
  header: /^treeView-beta\b/,
  lexer: { keywords: ['title', 'accTitle', 'accDescr', 'icon'], arrows: /^(?::::|##.*)/ },
  indent: 'keep',
  items,
  check(ctx) {
    const findings = []
    const widths = []
    ctx.lines.forEach((l, i) => {
      if (!l.trim() || i + 1 === ctx.header || /^\s*(title|accTitle|accDescr)\b/.test(l)) return
      const w = /^\s*/.exec(l)[0]
      if (/\t/.test(w) && / /.test(w))
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'mixed-indent',
          message: t('The indentation mixes tabs and spaces'),
        })
      // A dedent to a depth no line above has: it hangs under a node you may not expect.
      let popped = false
      while (widths.length && widths[widths.length - 1] > w.length) popped = widths.pop() !== undefined
      if (popped && widths.length && widths[widths.length - 1] < w.length)
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'dedent',
          message: t('This indentation matches no level above it'),
        })
      if (!widths.length || widths[widths.length - 1] < w.length) widths.push(w.length)
    })
    return findings
  },
  snippets: [
    [t('folder'), '${1:folder}/'],
    [t('file with description'), t('${1:file.ts} ## ${2:description}')],
  ],
  starter: 'treeView-beta\n\t${1:project}/\n\t\t${2:src}/\n\t\t\t${3:index.ts}\n\t\t${4:README.md}',
  link: { kinds: [{ selector: 'text.treeView-node-label', key: (rec, ctx) => keyByText(ctx.model.items, rec.text) }] },
}
