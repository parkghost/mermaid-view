// Class diagrams: class names (declared by `class`, or by a relation or a member line), the
// `{ }` bodies and namespaces, relations, notes; the drawing's classes "classId-<name>-<n>",
// relations "id_<a>_<b>_<n>" (n counts the relations from 1), notes "note<n>", namespaces.

import { t } from './i18n.js'
import { colonAt, directionText, mask, NODE, scan, symbolList } from './type-core.js'

const REL = '(?:<\\||\\|>|\\*|o|<|>|\\(\\))?(?:--|\\.\\.)(?:<\\||\\|>|\\*|o|<|>|\\(\\))?'
const NAME = '[A-Za-z_\\u00C0-\\uFFFF][\\w.\\u00C0-\\uFFFF-]*'
const RELATION = new RegExp(`^\\s*(${NAME})(?:~[^~]*~)?\\s*\\s*${REL}\\s*(${NAME})`)

// The line as scanned: quotes and the label after ':' blanked; and whether it is in a class body.
function readLines(lines) {
  let body = false
  return lines.map(raw => {
    const c = colonAt(raw)
    const m = mask(raw, c >= 0 && !raw.includes(':::') ? c : -1)
    const t = m.trim()
    const inBody = body
    if (inBody) {
      if (t.includes('}')) body = false
      return { line: m, body: true }
    }
    if (/^class\b/.test(t) && t.includes('{') && !t.includes('}')) body = true
    return { line: m, body: false }
  })
}

function symbols(lines) {
  const out = symbolList()
  readLines(lines).forEach(({ line, body }, i) => {
    const n = i + 1
    if (body) return
    const t = line.trim()
    if (!t || /^classDiagram/.test(t)) return
    let m
    if ((m = scan(line, new RegExp(`^\\s*class\\s+(${NAME})`))).length) return out.add(m[0], n, true)
    if ((m = scan(line, new RegExp(`^\\s*namespace\\s+(${NAME})`))).length) return out.add(m[0], n, true, 'namespace')
    if ((m = scan(line, new RegExp(`^\\s*<<[^>]*>>\\s*(${NAME})`))).length) return out.add(m[0], n)
    if ((m = scan(line, new RegExp(`^\\s*(?:note\\s+for|style|click|link|callback)\\s+(${NAME})`))).length)
      return out.add(m[0], n)
    if (/^(classDef|cssClass|direction|note|accTitle|accDescr|title)\b/.test(t)) return
    for (const g of [1, 2]) for (const h of scan(line, RELATION, g)) out.add(h, n)
    if (
      !RELATION.test(line) &&
      (m = scan(lines[i].slice(0, Math.max(0, colonAt(lines[i]))), new RegExp(`^\\s*(${NAME})\\s*$`))).length
    )
      out.add(m[0], n)
  })
  return out.list
}

// Relations (in order: the drawing numbers them from 1) and notes.
function items(lines) {
  const out = []
  let rel = 0
  let note = 0
  readLines(lines).forEach(({ line, body }, i) => {
    if (body) return
    const t = line.trim()
    if (/^note\b/.test(t)) out.push({ key: `note:${note++}`, line: i + 1, aside: true })
    else if (!/^(class|namespace|style|click|link|callback|classDef|cssClass)\b/.test(t) && RELATION.test(line)) {
      const m = RELATION.exec(line)
      out.push({ key: `rel:${++rel}`, line: i + 1, from: m[1], to: m[2] })
    }
  })
  return out
}

export default {
  id: 'class',
  name: 'Class',
  header: /^classDiagram(-v2)?\b/,
  looks: ['neo', 'handDrawn'],
  layouts: ['elk'],
  lexer: {
    keywords: [
      'class',
      'namespace',
      'classDef',
      'style',
      'cssClass',
      'click',
      'call',
      'callback',
      'link',
      'href',
      'note',
      'for',
      'direction',
      'TB',
      'BT',
      'LR',
      'RL',
      'accTitle',
      'accDescr',
      'title',
      '_self',
      '_blank',
      '_parent',
      '_top',
    ],
    arrows: new RegExp(`^${REL}`),
    colon: 'text',
  },
  blocks: { braces: true },
  indent: 'depth',
  symbols,
  items,
  idPattern: new RegExp(`^${NAME}$`),
  idHint: t('A class name may only use letters, digits, _, . and -, and cannot start with a digit'),
  check(ctx) {
    const findings = []
    const seen = new Map()
    for (const s of ctx.symbols) {
      if (!s.def || s.kind) continue
      const body = /\{/.test(ctx.lines[s.line - 1])
      const prev = seen.get(s.name)
      if (prev?.body && body) {
        findings.push({
          line: s.line,
          severity: 'warning',
          rule: 'duplicate',
          message: t('Class {name} already has a body on line {line}: the two are merged', {
            name: s.name,
            line: prev.line,
          }),
        })
      } else if (!prev) seen.set(s.name, { line: s.line, body })
    }
    // style, click, link, callback on a class that is never declared or used: Mermaid ignores them.
    const known = new Set(
      ctx.symbols.filter(s => !/^\s*(style|click|link|callback|note)\b/.test(ctx.lines[s.line - 1])).map(s => s.name),
    )
    for (const s of ctx.symbols) {
      if (!known.has(s.name))
        findings.push({
          line: s.line,
          severity: 'warning',
          rule: 'unknown-class',
          message: t('No class named {name}: this line has no effect', { name: s.name }),
        })
    }
    // `direction LR` anywhere on a line is read as a direction, even inside a label.
    findings.push(...directionText(ctx.lines))
    return findings
  },
  snippets: [
    [t('class { }'), 'class ${1:Name} {\n\t+${2:field}\n\t+${3:method}()\n}'],
    [t('Inheritance <|--'), '${1:Base} <|-- ${2:Derived}'],
    [t('Composition *--'), '${1:Whole} *-- ${2:Part}'],
    [t('Aggregation o--'), '${1:Whole} o-- ${2:Part}'],
    [t('Association -->'), t('${1:A} --> ${2:B} : ${3:label}')],
    [t('Dependency ..>'), '${1:A} ..> ${2:B}'],
    [t('namespace'), 'namespace ${1:Name} {\n\tclass ${2:A}\n}'],
    [t('note for'), t('note for ${1:Name} "${2:note}"')],
  ],
  starter: 'classDiagram\n\tclass ${1:Animal} {\n\t\t+String name\n\t\t+eat()\n\t}\n\t${1:Animal} <|-- ${2:Duck}',
  link: {
    kinds: [
      { selector: NODE, key: rec => nodeKey(rec.id) },
      { selector: '[data-id]', key: (rec, ctx) => relKey(rec.dataId, ctx) },
      { selector: 'g.cluster', key: rec => `node:${rec.id}` },
    ],
    resolve: target => target.closest('.edgeLabel')?.querySelector('[data-id]'),
  },
}

function nodeKey(id) {
  let m = /^classId-(.+)-\d+$/.exec(id)
  if (m) return `node:${m[1]}`
  m = /^note(\d+)$/.exec(id)
  return m ? `note:${m[1]}` : undefined
}

// "id_<from>_<to>_<n>": the n-th relation, if its ends agree; "edgeNote<n>": the note's line.
function relKey(dataId, ctx) {
  let m = /^edgeNote(\d+)$/.exec(dataId)
  if (m) return `note:${m[1]}`
  m = /^id_(.+)_(\d+)$/.exec(dataId)
  if (!m) return undefined
  const it = ctx.model.items.find(x => x.key === `rel:${m[2]}`)
  if (it && m[1] === `${it.from}_${it.to}`) return it.key
  return ctx.model.items.find(x => x.from !== undefined && m[1] === `${x.from}_${x.to}`)?.key
}
