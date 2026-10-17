// Ishikawa (fishbone) diagrams: the effect, then causes by indentation (the formatter leaves it
// alone); every line is a label. The drawing's head and bones, by their text.

import { t } from './i18n.js'
import { keyByText } from './type-core.js'

function items(lines) {
  const out = []
  lines.forEach((l, i) => {
    const t = l.trim()
    if (t && !/^ishikawa(-beta)?\b/i.test(t)) out.push({ key: `node:${out.length}`, line: i + 1, label: t })
  })
  return out
}

export default {
  id: 'ishikawa',
  name: 'Ishikawa',
  header: /^ishikawa(-beta)?\b/i,
  looks: ['handDrawn'],
  lexer: { keywords: [] },
  tokenize: line => (line ? [{ type: line.trim() ? 'label' : 'space', text: line }] : []),
  indent: 'keep',
  items,
  check(ctx) {
    const findings = []
    ctx.lines.forEach((l, i) => {
      if (/^\s*(title|accTitle|accDescr)\b/.test(l))
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'no-title',
          message: t('Ishikawa diagrams have no title or accTitle: this line becomes a node'),
        })
      if (/\S.*%%/.test(l))
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'inline-comment',
          message: t('A trailing %% becomes part of the text: put comments on their own line'),
        })
      if ((/^\s*\t/.test(l) && /^ +/.test(l)) || /^\t+ +|^ +\t/.test(l))
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'mixed-indent',
          message: t('The indentation mixes tabs and spaces'),
        })
    })
    return findings
  },
  snippets: [[t('cause'), t('${1:cause}')]],
  starter: t('ishikawa-beta\n\t${1:Effect}\n\t${2:Cause}\n\t\t${3:Detail}'),
  link: {
    kinds: [
      {
        selector: 'g.ishikawa-head-group, g.ishikawa-label-group, g.ishikawa-sub-group',
        key: (rec, ctx) => keyByText(ctx.model.items, rec.text),
      },
    ],
  },
}
