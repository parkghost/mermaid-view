// Sequence diagrams: participants (with aliases, names may hold spaces), messages, notes, the
// end-closed groups, and the drawing's participants, messages, notes and groups by the
// statement index Mermaid gives them (data-id "i<n>").

import { t } from './i18n.js'
import { colonAt, duplicates, mask, scan, symbolList } from './type-core.js'

// Every message arrow, longest first.
const ARROWS =
  /^(?:<<-->>|<<->>|-->>|->>|--\|[\\/]|--\\\\|--\/\/|-->|--x|--\)|->|-x|-\)|-\|[\\/]|-\\\\|-\/\/|\/\|--|\\\|--|\/\/--|\\\\--|\/\|-|\\\|-|\/\/-|\\\\-)/
const ARROW_SRC = ARROWS.source.slice(1)
const GROUPS = /^(loop|rect|opt|alt|par|par_over|critical|break)\b/i
const NOT_ACTOR =
  /^(participant|actor|create|destroy|box|loop|rect|opt|alt|else|par|par_over|and|critical|option|break|end|note|activate|deactivate|autonumber|title|links?|properties|details|accTitle|accDescr)\b/i
// A name (lazy) neither starts nor ends with a space, so no \s* next to it can split the same
// spaces another way: each regex here stays linear on a long line it does not match.
const NAME = '[^<>:,;@\\s](?:[^<>:,;@\\n]*?[^<>:,;@\\s])??'
// A message's sender or receiver, likewise.
const PEER = '[^:;\\s](?:[^:;]*?[^:;\\s])??'

// The line as the scanners read it: no comment (%% or #), no text after the message's ':'.
function readable(line) {
  const c = colonAt(line)
  return mask(line, c >= 0 ? c + 1 : -1, '#')
}

function symbols(lines) {
  const out = symbolList()
  lines.forEach((raw, i) => {
    const n = i + 1
    const line = readable(raw)
    const t = line.trim()
    if (!t || /^sequenceDiagram\b/.test(t)) return
    let m
    if (
      (m = scan(
        line,
        new RegExp(`^\\s*(?:create\\s+)?(?:participant|actor)\\s+(${NAME})(?=\\s*@\\{|\\s+as\\s|\\s*$)`, 'i'),
      )).length
    ) {
      return out.add(m[0], n, true)
    }
    for (const re of [
      new RegExp(`^\\s*(?:destroy|activate|deactivate)\\s+(${NAME})\\s*$`, 'i'),
      new RegExp(`^\\s*(?:links?|properties|details)\\s+(${NAME})\\s*:`, 'i'),
    ]) {
      if ((m = scan(line, re)).length) return out.add(m[0], n)
    }
    if (/^note\b/i.test(t)) {
      for (const g of [1, 2])
        for (const h of scan(
          line,
          new RegExp(`^\\s*note\\s+(?:left\\s+of|right\\s+of|over)\\s+(${NAME})(?:\\s*,\\s*(${NAME}))?\\s*:`, 'i'),
          g,
        ))
          out.add(h, n)
      return
    }
    if (NOT_ACTOR.test(t)) return
    // The lookahead first checks that a ':' comes before any ';': else no split of the line can match.
    const msg = new RegExp(
      `^(?=[^:;]*:)\\s*(${PEER})\\s*(?:\\(\\)\\s*)?(?:${ARROW_SRC})\\s*(?:(?:[+-]|\\(\\))\\s*)?(${PEER})\\s*:`,
    )
    for (const g of [1, 2]) for (const h of scan(line, msg, g)) out.add(h, n)
  })
  return out.list
}

/**
 * The statements Mermaid numbers, in its order (its messages list): autonumber, activate and
 * deactivate, notes, messages (and the activation a +/- or () adds), and each group's start,
 * else/and/option and end. A group's item is keyed by its end's index, as the drawing is.
 */
function items(lines) {
  const out = []
  const stack = [] // open groups: { line, box, middles: [] }
  let index = 0
  const take = (line, extra = 0) => {
    const i = index
    index += 1 + extra
    return i
  }
  lines.forEach((raw, i) => {
    const n = i + 1
    const line = readable(raw)
    const t = line.trim()
    if (!t || /^sequenceDiagram\b/.test(t)) return
    const word = t.split(/\s+/)[0].toLowerCase()
    if (word === 'box') return stack.push({ line: n, box: true, middles: [] })
    if (GROUPS.test(t)) {
      take(n)
      return stack.push({ line: n, box: false, middles: [] })
    }
    if (/^(else|and|option)\b/i.test(t)) {
      take(n)
      return stack[stack.length - 1]?.middles.push(n)
    }
    if (word === 'end') {
      const g = stack.pop()
      if (!g || g.box) return
      const at = take(n)
      return out.push({ key: `msg:${at}`, line: g.line, end: n, lights: [g.line, ...g.middles, n] })
    }
    if (word === 'autonumber' || word === 'activate' || word === 'deactivate') return void take(n)
    if (word === 'note') return out.push({ key: `msg:${take(n)}`, line: n, aside: true })
    if (NOT_ACTOR.test(t)) return
    const m = new RegExp(`^\\s*(${PEER})\\s*(?:(\\(\\))\\s*)?(?:${ARROW_SRC})\\s*([+-]|\\(\\))?`).exec(line)
    if (!m) return
    const extra = (m[2] ? 1 : 0) + (m[3] ? 1 : 0)
    out.push({ key: `msg:${take(n, extra)}`, line: n })
  })
  return out
}

export default {
  id: 'sequence',
  name: 'Sequence',
  header: /^sequenceDiagram\b/,
  looks: ['neo'],
  lexer: {
    keywords: [
      'participant',
      'actor',
      'as',
      'create',
      'destroy',
      'box',
      'loop',
      'rect',
      'opt',
      'alt',
      'else',
      'par',
      'par_over',
      'and',
      'critical',
      'option',
      'break',
      'end',
      'note',
      'Note',
      'over',
      'left',
      'right',
      'of',
      'activate',
      'deactivate',
      'autonumber',
      'off',
      'link',
      'links',
      'properties',
      'details',
      'title',
      'accTitle',
      'accDescr',
    ],
    caseInsensitive: true,
    arrows: new RegExp(`^(?:\\(\\))?(?:${ARROW_SRC})(?:[+-]|\\(\\))?`),
    id: /^[A-Za-z_][\w]*/,
    colon: 'text',
  },
  blocks: {
    open: /^(loop|rect|opt|alt|par|par_over|critical|break|box)\b/i,
    middle: /^(else|and|option)\b/i,
    close: /^end\b/i,
  },
  indent: 'depth',
  symbols,
  items,
  idPattern: /^[^<>:,;@\s+()-][^<>:,;@\n]*$/,
  idHint: t('A participant name cannot contain < > : , ; @ or start with - + ( )'),
  check(ctx) {
    const findings = duplicates(ctx.symbols, (name, line) =>
      t('Participant {name} is already declared on line {line}', { name, line }),
    )
    const declared = new Map()
    for (const s of ctx.symbols) if (s.def && !declared.has(s.name)) declared.set(s.name, s.line)
    // Declared after first being used: Mermaid placed it already, the declaration's order is lost.
    const firstUse = new Map()
    for (const s of ctx.symbols) if (!s.def && !firstUse.has(s.name)) firstUse.set(s.name, s.line)
    for (const [name, line] of declared) {
      const use = firstUse.get(name)
      if (use !== undefined && use < line && !/^\s*create\b/i.test(ctx.lines[line - 1])) {
        findings.push({
          line,
          severity: 'info',
          rule: 'declare-late',
          message: t(
            '{name} is already used on line {use}, so this declaration does not set its position: declare it before that',
            { name, use },
          ),
        })
      }
    }
    // '#' and ';' end a message's text (a comment, a new statement): the rest is lost.
    ctx.lines.forEach((raw, i) => {
      const c = colonAt(raw)
      if (c < 0) return
      const text = raw.slice(c + 1)
      if (/[#;]/.test(text.replace(/#\d+;|#\w+;/g, ''))) {
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'text-cut',
          message: t('A # or ; in the text cuts it short: write #35; or #59; instead'),
        })
      }
    })
    return findings
  },
  snippets: [
    [t('participant'), t('participant ${1:A} as ${2:name}')],
    [t('message ->>'), t('${1:A}->>${2:B}: ${3:message}')],
    [t('reply -->>'), t('${1:B}-->>${2:A}: ${3:reply}')],
    [t('Note'), t('Note right of ${1:A}: ${2:note}')],
    [t('loop'), t('loop ${1:condition}\n\t$0\nend')],
    [t('alt'), t('alt ${1:condition}\n\t$2\nelse ${3:otherwise}\n\t$0\nend')],
    [t('opt'), t('opt ${1:condition}\n\t$0\nend')],
    [t('par'), t('par ${1:task}\n\t$2\nand ${3:task}\n\t$0\nend')],
  ],
  starter:
    'sequenceDiagram\n\tparticipant ${1:A} as ${2:Alice}\n\tparticipant ${3:B} as ${4:Bob}\n\t${1:A}->>${3:B}: ${5:Hello}\n\t${3:B}-->>${1:A}: ${6:Hi}',
  link: {
    kinds: [
      { selector: '[data-et=participant][data-id], [data-et=life-line][data-id]', key: rec => `node:${rec.dataId}` },
      {
        selector: '[data-et=message][data-id], [data-et=note][data-id], [data-et=control-structure][data-id]',
        key: rec => `msg:${rec.dataId.replace(/^i/, '')}`,
      },
    ],
  },
}
