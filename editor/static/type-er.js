// Entity relationship diagrams: entity names (declared by a `{ }` block, a bare line or a
// relation), attribute blocks, subgraph ... end, relations; the drawing's entities
// "entity-<name>-<n>" and relations "id_entity-<a>-<i>_entity-<b>-<j>_<k>" (k counts from 0).

import { t } from './i18n.js'
import { colonAt, commentAt, directionText, mask, NODE, scan, scanList, symbolList } from './type-core.js'

const NAME = '[\\p{L}\\p{N}_*.-]+'
const CARD = '(?:\\|o|\\|\\||\\}o|\\}\\||o\\||o\\{|\\|\\{|u)'
const REL = `${CARD}(?:--|\\.\\.|\\.-|-\\.)${CARD}`
const WORDS =
  '(?:(?:one|zero|only|or|more|many|many\\(0\\)|many\\(1\\)|1\\+?|0\\+)\\s+)+(?:optionally\\s+)?to(?:\\s+(?:one|zero|only|or|more|many|many\\(0\\)|many\\(1\\)|1\\+?|0\\+))+'
// Cardinalities hold braces (`o{`): blanked before braces are counted.
const unrel = line => line.replace(new RegExp(REL, 'g'), r => ' '.repeat(r.length))
const RELATION = new RegExp(`^\\s*(${NAME})\\s*(?:${REL}|\\s${WORDS})\\s*(${NAME})\\s*:`, 'u')

// Lines as scanned: quotes and the role after ':' blanked; attribute lines inside `{ }` dropped.
function readLines(lines) {
  let body = false
  return lines.map(raw => {
    const c = colonAt(raw, { classes: true })
    const m = mask(raw, c >= 0 ? c + 1 : -1)
    const b = unrel(m)
    if (body) {
      if (b.includes('}')) body = false
      return ''
    }
    if (b.includes('{') && !b.includes('}')) body = true
    return b.includes('{') ? m.slice(0, b.indexOf('{')) : m
  })
}

function symbols(lines) {
  const out = symbolList()
  readLines(lines).forEach((line, i) => {
    const n = i + 1
    const t = line.trim()
    if (!t || /^erDiagram/.test(t)) return
    let m
    if ((m = scan(line, new RegExp(`^\\s*subgraph\\s+(${NAME})`, 'u'))).length)
      return out.add(m[0], n, true, 'subgraph')
    if (/^(end|direction|classDef|accTitle|accDescr|title)\b/.test(t)) return
    if (/^(class|style)\s/.test(t)) {
      for (const h of scanList(line, /^\s*(?:class|style)\s+(\S+)/)) out.add(h, n)
      return
    }
    if (RELATION.test(line)) {
      for (const g of [1, 2]) for (const h of scan(line, RELATION, g)) out.add(h, n)
      return
    }
    // An entity on its own: NAME, NAME[alias], NAME:::cls, NAME { (attributes follow). Each
    // optional part takes its own leading spaces: adjacent \s* would backtrack on long lines.
    if ((m = scan(line, new RegExp(`^\\s*(${NAME})(?:\\s*\\[[^\\]]*\\])?(?:\\s*:::\\s*\\S+)?\\s*$`, 'u'))).length)
      out.add(m[0], n, true)
  })
  return out.list
}

function items(lines) {
  const out = []
  let k = 0
  readLines(lines).forEach((line, i) => {
    const m = RELATION.exec(line)
    if (m) out.push({ key: `rel:${k++}`, line: i + 1 })
  })
  return out
}

export default {
  id: 'er',
  name: 'Entity relationship',
  header: /^erDiagram\b/,
  looks: ['neo', 'handDrawn'],
  layouts: ['elk'],
  lexer: {
    keywords: [
      'subgraph',
      'end',
      'style',
      'classDef',
      'class',
      'direction',
      'TB',
      'BT',
      'LR',
      'RL',
      'accTitle',
      'accDescr',
      'PK',
      'FK',
      'UK',
      'to',
      'optionally',
      'one',
      'only',
      'zero',
      'or',
      'more',
      'many',
    ],
    caseInsensitive: true,
    arrows: new RegExp(`^${REL}`),
    colon: 'text',
  },
  blocks: { braces: true, open: /^subgraph\b/i, close: /^end\b/i, mask: unrel },
  indent: 'depth',
  symbols,
  items,
  idPattern: /^[\p{L}_][\p{L}\p{N}_*.-]*$/u,
  idHint: t('An entity name may only use letters, digits, _, -, . and *'),
  check(ctx) {
    const findings = []
    // Trailing %% comments are a parse error here (only whole-line comments are allowed).
    ctx.lines.forEach((l, i) => {
      const c = commentAt(l)
      if (c > 0 && l.slice(0, c).trim()) {
        findings.push({
          line: i + 1,
          severity: 'error',
          rule: 'trailing-comment',
          message: t('A %% comment must be on its own line in an ER diagram: a trailing one breaks parsing'),
          fix: l.slice(0, c).trimEnd(),
        })
      }
    })
    findings.push(...directionText(ctx.lines))
    // class/style naming an entity that appears nowhere else: Mermaid ignores it.
    const known = new Set(ctx.symbols.filter(s => !/^\s*(class|style)\s/.test(ctx.lines[s.line - 1])).map(s => s.name))
    for (const s of ctx.symbols)
      if (!known.has(s.name))
        findings.push({
          line: s.line,
          severity: 'warning',
          rule: 'unknown-entity',
          message: t('No entity named {name}: this line has no effect', { name: s.name }),
        })
    return findings
  },
  snippets: [
    [t('Relation ||--o{'), '${1:A} ||--o{ ${2:B} : ${3:has}'],
    [t('One to one ||--||'), '${1:A} ||--|| ${2:B} : ${3:is}'],
    [t('Many to many }o--o{'), '${1:A} }o--o{ ${2:B} : ${3:relates}'],
    [t('Entity attributes { }'), '${1:ENTITY} {\n\t${2:string} ${3:name} PK\n}'],
    [t('subgraph'), t('subgraph ${1:id} [${2:title}]\n\t$0\nend')],
  ],
  starter: 'erDiagram\n\t${1:CUSTOMER} ||--o{ ${2:ORDER} : ${3:places}\n\t${1:CUSTOMER} {\n\t\tstring name PK\n\t}',
  link: {
    kinds: [
      {
        selector: NODE,
        key: rec => (/^entity-(.+)-\d+$/.exec(rec.id) ? `node:${/^entity-(.+)-\d+$/.exec(rec.id)[1]}` : undefined),
      },
      {
        selector: '[data-id]',
        key: rec => (/^id_entity-.+_(\d+)$/.exec(rec.dataId) ? `rel:${/_(\d+)$/.exec(rec.dataId)[1]}` : undefined),
      },
      { selector: 'g.cluster', key: rec => `node:${rec.id}` },
    ],
    resolve: target => target.closest('.edgeLabel')?.querySelector('[data-id]'),
  },
}
