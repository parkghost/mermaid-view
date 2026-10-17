// C4 diagrams: aliases (the first argument of an element or boundary macro), boundaries `{ }`,
// relations Rel*(from, to, ...); the drawing's elements (id: the alias) and relations in order.

import { t } from './i18n.js'
import { duplicates, mask, NODE, scan, symbolList, undeclared } from './type-core.js'

const ELEMENTS = [
  'Person',
  'Person_Ext',
  'System',
  'SystemDb',
  'SystemQueue',
  'System_Ext',
  'SystemDb_Ext',
  'SystemQueue_Ext',
  'Container',
  'ContainerDb',
  'ContainerQueue',
  'Container_Ext',
  'ContainerDb_Ext',
  'ContainerQueue_Ext',
  'Component',
  'ComponentDb',
  'ComponentQueue',
  'Component_Ext',
  'ComponentDb_Ext',
  'ComponentQueue_Ext',
]
const BOUNDARIES = [
  'Boundary',
  'Enterprise_Boundary',
  'System_Boundary',
  'Container_Boundary',
  'Deployment_Node',
  'Node',
  'Node_L',
  'Node_R',
]
const RELS = [
  'Rel',
  'BiRel',
  'Rel_Up',
  'Rel_U',
  'Rel_Down',
  'Rel_D',
  'Rel_Left',
  'Rel_L',
  'Rel_Right',
  'Rel_R',
  'Rel_Back',
]
const ALIAS = '[^,()\\s"]+'
const DECL = new RegExp(`^\\s*(?:${[...ELEMENTS, ...BOUNDARIES].join('|')})\\s*\\(\\s*(${ALIAS})`)
const REL = new RegExp(`^\\s*(?:${RELS.join('|')})\\s*\\(\\s*(${ALIAS})\\s*,\\s*(${ALIAS})`)
const REL_INDEX = new RegExp(`^\\s*RelIndex\\s*\\(\\s*[^,]*,\\s*(${ALIAS})\\s*,\\s*(${ALIAS})`)
const UPDATE = new RegExp(`^\\s*(?:UpdateElementStyle|UpdateRelStyle)\\s*\\(\\s*(${ALIAS})(?:\\s*,\\s*(${ALIAS}))?`)

function symbols(lines) {
  const out = symbolList()
  lines.forEach((raw, i) => {
    const n = i + 1
    const line = mask(raw)
    let m
    if ((m = scan(line, DECL)).length) return out.add(m[0], n, true)
    for (const re of [REL, REL_INDEX]) {
      if (re.test(line)) {
        for (const g of [1, 2]) for (const h of scan(line, re, g)) out.add(h, n)
        return
      }
    }
    if (/^\s*UpdateElementStyle\b/.test(line)) return scan(line, UPDATE, 1).forEach(h => out.add(h, n))
    if (/^\s*UpdateRelStyle\b/.test(line)) for (const g of [1, 2]) scan(line, UPDATE, g).forEach(h => out.add(h, n))
  })
  return out.list
}

// Relations in order (the drawing draws one line or path for each).
function items(lines) {
  const out = []
  let k = 0
  lines.forEach((raw, i) => {
    const line = mask(raw)
    if (REL.test(line) || REL_INDEX.test(line)) out.push({ key: `rel:${k++}`, line: i + 1 })
  })
  return out
}

export default {
  id: 'c4',
  name: 'C4',
  header: /^C4(Context|Container|Component|Dynamic|Deployment)\b/,
  looks: ['neo', 'handDrawn'],
  lexer: {
    keywords: [
      ...ELEMENTS,
      ...BOUNDARIES,
      ...RELS,
      'RelIndex',
      'UpdateElementStyle',
      'UpdateRelStyle',
      'UpdateLayoutConfig',
      'title',
      'accTitle',
      'accDescr',
      'accDescription',
    ],
    id: /^[A-Za-z_][\w]*/,
  },
  blocks: { braces: true },
  indent: 'depth',
  symbols,
  items,
  idPattern: /^[^,()\s"]+$/,
  idHint: t('An alias cannot contain spaces, commas, parentheses or quotes'),
  check(ctx) {
    const findings = [
      ...duplicates(ctx.symbols, (name, line) => t('Alias {name} is already used on line {line}', { name, line })),
      ...undeclared(ctx.symbols, name => t('Alias {name} is not declared', { name })),
    ]
    const pairs = new Map()
    ctx.lines.forEach((l, i) => {
      const line = mask(l)
      if (/^\s*direction\b/.test(line))
        findings.push({
          line: i + 1,
          severity: 'error',
          rule: 'no-direction',
          message: t('C4 diagrams do not support direction'),
        })
      const rel = REL.exec(line)
      if (!rel) return
      // Fewer than three arguments (no label): Mermaid drops the relation without a word.
      if ((l.slice(l.indexOf('(')).match(/,/g)?.length ?? 0) < 2)
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'rel-label',
          message: t('A relation needs a label (its third argument), or it is not drawn'),
        })
      const key = `${rel[1]}>${rel[2]}`
      if (pairs.has(key))
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'duplicate-rel',
          message: t('A relation from {from} to {to} already exists on line {line}: this one replaces it', {
            from: rel[1],
            to: rel[2],
            line: pairs.get(key),
          }),
        })
      else pairs.set(key, i + 1)
    })
    return findings
  },
  snippets: [
    [t('Person'), t('Person(${1:alias}, "${2:name}", "${3:description}")')],
    [t('System'), t('System(${1:alias}, "${2:name}", "${3:description}")')],
    [t('Container'), t('Container(${1:alias}, "${2:name}", "${3:technology}", "${4:description}")')],
    [t('Boundary { }'), t('System_Boundary(${1:alias}, "${2:name}") {\n\t$0\n}')],
    [t('Rel'), t('Rel(${1:from}, ${2:to}, "${3:label}")')],
  ],
  starter:
    'C4Context\n\ttitle ${1:System Context}\n\tPerson(${2:user}, "${3:User}")\n\tSystem(${4:sys}, "${5:System}")\n\tRel(${2:user}, ${4:sys}, "${6:Uses}")',
  link: {
    kinds: [
      { selector: NODE, key: (rec, ctx) => (ctx.model.names.includes(rec.id) ? `node:${rec.id}` : undefined) },
      { selector: 'svg > g > line, svg > g > path', key: rec => `rel:${rec.nth}` },
    ],
  },
}
