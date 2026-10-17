// Venn diagrams: sets (`set A["label"]:size`), unions of declared sets, text nodes, styles;
// the drawing's sets and unions (data-venn-sets) and text nodes by their label.

import { t } from './i18n.js'
import { duplicates, keyByText, scan, scanList, symbolList } from './type-core.js'

const ID = '[A-Za-z_][\\w-]*'

function symbols(lines) {
  const out = symbolList()
  lines.forEach((l, i) => {
    const n = i + 1
    const masked = l.replace(/\[[^\]]*\]|"[^"]*"/g, s => ' '.repeat(s.length))
    let m
    if ((m = scan(masked, new RegExp(`^\\s*set\\s+(${ID})`))).length) return out.add(m[0], n, true, 'set')
    if (/^\s*union\s/.test(masked))
      return scanList(masked, /^\s*union\s+([^\s:]+)/).forEach(h => out.add(h, n, false, 'set'))
    if (/^\s*text\s/.test(masked)) {
      const list = /^\s*text\s+(\S+)\s+\S/.test(masked) ? scanList(masked, /^\s*text\s+(\S+)\s+\S/) : []
      list.forEach(h => out.add(h, n, false, 'set'))
      const id = scan(masked, new RegExp(`(${ID})\\s*$`))[0]
      if (id && !list.some(h => h.start === id.start)) out.add(id, n, true, 'text')
      return
    }
    if (/^\s*style\s/.test(masked)) scanList(masked, /^\s*style\s+(\S+)/).forEach(h => out.add(h, n))
  })
  return out.list
}

function items(lines) {
  const out = []
  lines.forEach((l, i) => {
    const m = /^\s*(set|union|text)\s+([^\s[:]+)(?:\s+([^\s[:]+))?\s*(?:\[\s*"?([^"\]]*)"?\s*\])?/.exec(l)
    if (!m) return
    if (m[1] === 'text') return out.push({ key: `text:${out.length}`, line: i + 1, label: m[4] ?? m[3] ?? m[2] })
    out.push({
      key: `sets:${m[2]
        .split(',')
        .map(s => s.trim())
        .sort()
        .join('_')}`,
      line: i + 1,
    })
  })
  return out
}

export default {
  id: 'venn',
  name: 'Venn',
  header: /^venn-beta\b/,
  looks: ['handDrawn'],
  lexer: { keywords: ['set', 'union', 'text', 'style', 'title'], caseInsensitive: true, numbers: true },
  indent: 'keep',
  symbols,
  items,
  idPattern: new RegExp(`^${ID}$`),
  check(ctx) {
    const findings = duplicates(
      ctx.symbols,
      (name, line) => t('Set {name} is already declared on line {line}', { name, line }),
      'set',
    )
    const sets = new Map()
    for (const s of ctx.symbols) if (s.def && s.kind === 'set' && !sets.has(s.name)) sets.set(s.name, s.line)
    for (const s of ctx.symbols) {
      if (s.def || s.kind !== 'set') continue
      const at = sets.get(s.name)
      if (at === undefined || at > s.line)
        findings.push({
          line: s.line,
          severity: /^\s*union/.test(ctx.lines[s.line - 1]) ? 'error' : 'warning',
          rule: 'undeclared',
          message: t('Declare {name} with set before using it', { name: s.name }),
        })
    }
    ctx.lines.forEach((l, i) => {
      if (/^\s*acc(Title|Descr)\b/.test(l))
        findings.push({
          line: i + 1,
          severity: 'error',
          rule: 'no-acc',
          message: t('Venn diagrams do not support accTitle or accDescr'),
        })
    })
    return findings
  },
  snippets: [
    [t('set'), t('set ${1:A}["${2:name}"]')],
    [t('union'), t('union ${1:A},${2:B}["${3:name}"]')],
    [t('text'), t('text ${1:id}["${2:text}"]')],
  ],
  starter: t('venn-beta\n\tset ${1:A}["${2:A}"]\n\tset ${3:B}["${4:B}"]\n\tunion ${1:A},${3:B}["${5:Both}"]'),
  link: {
    kinds: [
      {
        selector: 'g.venn-area',
        info: el => ({ sets: el.dataset.vennSets ?? '' }),
        key: (rec, ctx) => vennKey(rec.sets, ctx),
      },
      { selector: 'g.venn-text-area', key: (rec, ctx) => keyByText(ctx.model.items, rec.text) },
    ],
  },
}

const vennKey = (sets, ctx) => {
  const key = `sets:${sets.split('_').sort().join('_')}`
  return ctx.model.items.some(it => it.key === key) ? key : undefined
}
