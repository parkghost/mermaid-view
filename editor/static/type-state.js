// State diagrams: state ids (declared by `state`, or by a transition or `id : text`), composite
// `{ }` states, multi-line notes (`note ... end note`), transitions; the drawing's states
// "state-<id>-<n>", composites (data-id <id>), transitions "edge<n>" in source order.

import { t } from './i18n.js'
import { colonAt, directionText, mask, NODE, scan, scanList, symbolList } from './type-core.js'

const ID = '[^:\\s{}\\-"\\[\\],;]+'
const TRANSITION = new RegExp(`^\\s*(\\[\\*\\]|${ID})\\s*-->\\s*(\\[\\*\\]|${ID})`)

// Lines as scanned: no quotes, no text after ':' (outside `:::`), no multi-line note bodies.
function readLines(lines) {
  let note = false
  return lines.map(raw => {
    const t = raw.trim()
    if (note) {
      if (/^end\s+note\b/i.test(t)) note = false
      return ''
    }
    const c = colonAt(raw, { classes: true })
    if (/^note\s+(left|right)\s+of\b/i.test(t) && c < 0) note = true
    return mask(raw, c, '#')
  })
}

function symbols(lines) {
  const out = symbolList()
  readLines(lines).forEach((line, i) => {
    const n = i + 1
    const t = line.trim()
    if (!t || /^stateDiagram/.test(t)) return
    let m
    if ((m = scan(line, new RegExp(`^\\s*state\\s+(?:\\s+as\\s+)?(${ID})`, 'i'))).length) {
      const alias = scan(line, new RegExp(`\\bas\\s+(${ID})`, 'i'))
      return out.add(alias[0] ?? m[0], n, true)
    }
    if ((m = scan(line, new RegExp(`^\\s*note\\s+(?:left|right)\\s+of\\s+(${ID})`, 'i'))).length)
      return out.add(m[0], n)
    if (/^note\b/i.test(t)) return
    if (/^(class|style)\s/.test(t)) {
      // `class a,b cls`, `style a,b ...`: the listed states.
      for (const h of scanList(line, /^\s*(?:class|style)\s+(\S+)/)) out.add(h, n)
      return
    }
    if ((m = scan(line, /^\s*click\s+(\S+)/)).length) return out.add(m[0], n)
    if (/^(classDef|direction|hide|scale|accTitle|accDescr|--)\b|^--/.test(t)) return
    const tr = TRANSITION.exec(line)
    if (tr) {
      for (const g of [1, 2]) for (const h of scan(line, TRANSITION, g)) if (h.name !== '[*]') out.add(h, n)
      return
    }
    if ((m = scan(line, new RegExp(`^\\s*(${ID})(?:\\s*:::\\s*\\w+)?\\s*$`))).length) out.add(m[0], n)
  })
  return out.list
}

// Transitions, in the order the drawing numbers them (edge0, edge1, ...).
function items(lines) {
  const out = []
  let k = 0
  readLines(lines).forEach((line, i) => {
    if (TRANSITION.test(line)) out.push({ key: `edge:${k++}`, line: i + 1 })
    const note = /^\s*note\s+(?:left|right)\s+of\s+(\S+)/i.exec(line)
    if (note) {
      const end = lines.findIndex(
        (l, j) => j >= i && (/:/.test(mask(lines[i])) ? j === i : /^\s*end\s+note\b/i.test(l)),
      )
      out.push({ key: `note:${note[1]}`, line: i + 1, end: end < 0 ? i + 1 : end + 1, aside: true })
    }
  })
  return out
}

export default {
  id: 'state',
  name: 'State',
  header: /^stateDiagram(-v2)?\b/,
  looks: ['neo', 'handDrawn'],
  layouts: ['elk'],
  lexer: {
    keywords: [
      'state',
      'as',
      'note',
      'left',
      'right',
      'of',
      'end',
      'classDef',
      'class',
      'style',
      'click',
      'href',
      'hide',
      'empty',
      'description',
      'scale',
      'width',
      'direction',
      'TB',
      'BT',
      'LR',
      'RL',
      'accTitle',
      'accDescr',
    ],
    caseInsensitive: true,
    arrows: /^(?:-->|--)/,
    colon: 'text',
  },
  blocks: { braces: true, raw: { open: /^note\s+(left|right)\s+of\b/i, close: /^end\s+note\b/i } },
  indent: 'depth',
  symbols,
  items,
  idPattern: /^[A-Za-z_][\w.]*$/,
  idHint: t('A state ID cannot contain spaces, - or :, and cannot start with a digit'),
  check(ctx) {
    const findings = directionText(ctx.lines)
    ctx.lines.forEach((l, i) => {
      if (
        /^\s*--\s*$/.test(l) &&
        !(
          ctx.structure.ranges.some(r => r.start < i + 1 && r.end > i + 1) ||
          ctx.structure.unclosed.some(o => o.line < i + 1)
        )
      ) {
        findings.push({
          line: i + 1,
          severity: 'error',
          rule: 'divider',
          message: t('A -- divider is only allowed inside a composite state { }'),
        })
      }
    })
    const declared = new Map()
    for (const s of ctx.symbols) {
      if (!s.def) continue
      const braces = /\{\s*$/.test(ctx.lines[s.line - 1])
      if (braces && declared.get(s.name))
        findings.push({
          line: s.line,
          severity: 'warning',
          rule: 'duplicate',
          message: t('Composite state {name} already has a body on line {line}', {
            name: s.name,
            line: declared.get(s.name),
          }),
        })
      if (braces) declared.set(s.name, s.line)
    }
    return findings
  },
  snippets: [
    [t('transition -->'), t('${1:A} --> ${2:B} : ${3:event}')],
    [t('start [*] -->'), '[*] --> ${1:A}'],
    [t('end --> [*]'), '${1:A} --> [*]'],
    [t('state description state "…" as'), t('state "${1:description}" as ${2:Id}')],
    [t('composite state { }'), 'state ${1:Name} {\n\t[*] --> ${2:A}\n}'],
    [t('choice <<choice>>'), 'state ${1:check} <<choice>>'],
    [t('note'), t('note right of ${1:A} : ${2:note}')],
  ],
  starter: 'stateDiagram-v2\n\t[*] --> ${1:Still}\n\t${1:Still} --> ${2:Moving} : ${3:push}\n\t${2:Moving} --> [*]',
  link: {
    kinds: [
      { selector: `${NODE}, g.statediagram-cluster`, key: (rec, ctx) => stateKey(rec, ctx) },
      { selector: '[data-id]', key: rec => (/^edge\d+$/.test(rec.dataId) ? `edge:${rec.dataId.slice(4)}` : undefined) },
    ],
    resolve: target => target.closest('.edgeLabel')?.querySelector('[data-id]'),
  },
}

// "state-<id>-<n>" (or a composite's data-id); a note "state-<id>----note-<n>" is its note.
function stateKey(rec, ctx) {
  const note = /^state-(.+)----note-\d+$/.exec(rec.id)
  if (note) return `note:${note[1]}`
  const id = rec.dataId || /^state-(.+)-\d+$/.exec(rec.id)?.[1]
  return id && ctx.model.names.includes(id) ? `node:${id}` : undefined
}
