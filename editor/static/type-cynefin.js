// Cynefin frameworks: the five domains (a domain keyword opens its items), items "…", and
// transitions `a --> b`; the drawing's domain labels and items by their text.

import { t } from './i18n.js'
import { keyByText } from './type-core.js'

const DOMAINS = ['complex', 'complicated', 'clear', 'chaotic', 'confusion']

function items(lines) {
  const out = []
  lines.forEach((l, i) => {
    const t = l.trim()
    if (DOMAINS.includes(t.split(/\s+/)[0]) && !/-->/.test(t))
      out.push({ key: `domain:${t.split(/\s+/)[0]}`, line: i + 1, label: t.split(/\s+/)[0] })
    for (const m of t.matchAll(/"([^"]*)"|'([^']*)'/g))
      if (!/-->/.test(t)) out.push({ key: `item:${out.length}`, line: i + 1, label: m[1] ?? m[2] })
  })
  return out
}

export default {
  id: 'cynefin',
  name: 'Cynefin',
  header: /^cynefin-beta\b/,
  lexer: { keywords: [...DOMAINS, 'title', 'accTitle', 'accDescr'], arrows: /^-->/ },
  blocks: { sections: /^(complex|complicated|clear|chaotic|confusion)\s*$/ },
  indent: 'depth',
  items,
  check(ctx) {
    const findings = []
    const seen = new Map()
    ctx.lines.forEach((l, i) => {
      const w = l.trim()
      if (DOMAINS.includes(w)) {
        if (seen.has(w))
          findings.push({
            line: i + 1,
            severity: 'warning',
            rule: 'duplicate',
            message: t('{name} already appears on line {line}: the items of that earlier section are lost', {
              name: w,
              line: seen.get(w),
            }),
          })
        else seen.set(w, i + 1)
      }
      const move = /^\s*(\w+)\s*-->\s*(\w+)/.exec(l)
      if (move && move[1] === move[2])
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'self-loop',
          message: t('A transition to the same domain is not drawn'),
        })
      if (/^\s*[A-Z][a-z]+\s*$/.test(l) && DOMAINS.includes(l.trim().toLowerCase()))
        findings.push({
          line: i + 1,
          severity: 'error',
          rule: 'case',
          message: t('Write the domain name in lowercase'),
          fix: l.replace(l.trim(), l.trim().toLowerCase()),
        })
    })
    return findings
  },
  snippets: [
    [t('domain'), t('${1|complex,complicated,clear,chaotic,confusion|}\n\t"${2:item}"')],
    [
      t('Transition -->'),
      t(
        '${1|chaotic,complex,complicated,clear,confusion|} --> ${2|complex,complicated,clear,chaotic,confusion|} : "${3:reason}"',
      ),
    ],
  ],
  starter: t(
    'cynefin-beta\ntitle ${1:Title}\ncomplex\n\t"${2:Explore}"\nclear\n\t"${3:Follow}"\nchaotic\n\t"${4:Act first}"',
  ),
  link: {
    kinds: [
      { selector: 'text.cynefinDomainLabel', key: (rec, ctx) => keyByText(ctx.model.items, rec.text.toLowerCase()) },
      {
        selector: 'text.cynefinItemText',
        key: (rec, ctx) =>
          keyByText(
            ctx.model.items.filter(it => it.key.startsWith('item:')),
            rec.text,
          ),
      },
    ],
  },
}
