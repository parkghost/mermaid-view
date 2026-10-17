// Wardley maps: components and anchors (the name is the id, it may hold spaces), links
// `A -> B`, `evolve`, pipelines `{ }`; the drawing's nodes by their name.

import { t } from './i18n.js'
import { duplicates, keyByText, scan, symbolList } from './type-core.js'

const NAME = '[A-Za-z](?:[\\w()&]|-(?!>))*(?:[ \\t]+[A-Za-z(](?:[\\w()&]|-(?!>))*)*'
const LINK = new RegExp(
  `^\\s*(${NAME}|"[^"]*")\\s*(?:\\+'[^']*'<>|\\+'[^']*'<|\\+'[^']*'>|\\+<>|\\+<|\\+>|-\\.->|-->|->|>)\\s*(${NAME}|"[^"]*")`,
)
const unquote = h => (h.name.startsWith('"') ? { name: h.name.slice(1, -1), start: h.start + 1, end: h.end - 1 } : h)

function symbols(lines) {
  const out = symbolList()
  lines.forEach((l, i) => {
    const n = i + 1
    const line = l.replace(/\[[^\]]*\]|;.*$/g, s => ' '.repeat(s.length))
    // Statements that name no component: the evolution stages (`evolution A -> B`), notes, markers.
    if (/^\s*(evolution|size|note|annotations?|accelerator|deaccelerator)\b/.test(line)) return
    let m
    if ((m = scan(line, new RegExp(`^\\s*(?:component|anchor)\\s+(${NAME}|"[^"]*")`))).length)
      return out.add(unquote(m[0]), n, true)
    if ((m = scan(line, new RegExp(`^\\s*(?:evolve|pipeline)\\s+(${NAME}|"[^"]*")`))).length)
      return out.add(unquote(m[0]), n)
    if (LINK.test(line)) [1, 2].forEach(g => scan(line, LINK, g).forEach(h => out.add(unquote(h), n)))
  })
  // The scanned names stop before trailing words that are keywords (`label`, `(build)`, `inertia`, `(inertia)`).
  const trailing = /(?:\s+(?:inertia|label|\((?:build|buy|outsource|market|inertia)\)))+$/
  return out.list
    .map(s => ({ ...s, name: s.name.replace(trailing, '') }))
    .map(s => ({ ...s, end: s.start + s.name.length }))
}

function items(lines) {
  return symbols(lines)
    .filter(s => s.def)
    .map(s => ({ key: `node:${s.name}`, line: s.line, label: s.name }))
}

export default {
  id: 'wardley',
  name: 'Wardley map',
  header: /^wardley-beta\b/,
  lexer: {
    keywords: [
      'size',
      'evolution',
      'anchor',
      'component',
      'label',
      'inertia',
      'evolve',
      'pipeline',
      'note',
      'annotations',
      'annotation',
      'accelerator',
      'deaccelerator',
      'build',
      'buy',
      'outsource',
      'market',
      'title',
      'accTitle',
      'accDescr',
    ],
    arrows: /^(?:\+'[^']*'<>|\+'[^']*'<|\+'[^']*'>|\+<>|\+<|\+>|-\.->|-->|->|>)/,
    numbers: true,
  },
  blocks: { braces: true },
  indent: 'depth',
  symbols,
  items,
  idPattern: new RegExp(`^${NAME}$`),
  idHint: t('A name must start with a letter'),
  check(ctx) {
    const findings = duplicates(ctx.symbols, (name, line) =>
      t('{name} is already declared on line {line}: this one replaces it', { name, line }),
    )
    const declared = new Set(ctx.symbols.filter(s => s.def).map(s => s.name))
    for (const s of ctx.symbols)
      if (!s.def && !declared.has(s.name))
        findings.push({
          line: s.line,
          severity: 'warning',
          rule: 'undeclared',
          message: t('No component {name}: this line is not drawn', { name: s.name }),
        })
    ctx.lines.forEach((l, i) => {
      if (
        /^\s*(component|anchor)\b.*\[\s*\d+\s*,|\[\s*[\d.]+\s*,\s*\d+\s*\]/.test(l) &&
        /\[\s*\d+\s*[,\]]|,\s*\d+\s*\]/.test(l) &&
        !/^\s*(size|label)\b/.test(l) &&
        !/\blabel\s*\[/.test(l)
      ) {
        findings.push({
          line: i + 1,
          severity: 'error',
          rule: 'decimal',
          message: t('Write coordinates as decimals (e.g. 0.5 or 50.0)'),
        })
      }
    })
    return findings
  },
  snippets: [
    [t('component'), 'component ${1:Name} [${2:0.5}, ${3:0.5}]'],
    [t('anchor'), 'anchor ${1:User} [${2:0.95}, ${3:0.6}]'],
    [t('link ->'), '${1:A} -> ${2:B}'],
    [t('evolve'), 'evolve ${1:Name} ${2:0.8}'],
  ],
  starter:
    'wardley-beta\ntitle ${1:Map}\nanchor ${2:User} [0.95, 0.60]\ncomponent ${3:Service} [0.60, 0.40]\n${2:User} -> ${3:Service}',
  link: { kinds: [{ selector: 'g.wardley-node', key: (rec, ctx) => keyByText(ctx.model.items, rec.text) }] },
}
