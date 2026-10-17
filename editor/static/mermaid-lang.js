// Mermaid source tools for the editor: tokens for highlighting, a formatter, a linter, folding,
// the named elements of a diagram (occurrences, rename, definition) and the source lines of a
// drawn element. Pure functions, no DOM (tested with node --test). What differs by diagram type
// lives in that type's descriptor (type-*.js); this module only runs them.

import { configFindings } from './frontmatter.js'
import { t } from './i18n.js'
import { mask } from './type-core.js'
import { GENERIC, opensDirective, typeOf, typeOfHeader } from './types.js'

export { elementOfDomId, idsOnLine, KEYWORDS, nodeIds, sourceLines, subgraphIndex, tokenize } from './type-flowchart.js'
export { TYPES, typeOf } from './types.js'

import { tokenize as flowTokens } from './type-flowchart.js'

const INDENT = '    '

/**
 * The block structure of a source, by its type's descriptor:
 *   header     the diagram keyword's line (1-based), 0 when none
 *   verbatim   lines kept as written: front matter, directives over several lines, multi-line
 *              accDescr and raw regions (notes)
 *   depth      Map line -> nesting depth the line is written at (body lines start at 1)
 *   ranges     [{ start, end }] of balanced blocks; unclosed, unopened: the unbalanced lines
 */
export function structure(text, desc = typeOf(text)) {
  const lines = text.split('\n')
  const blocks = desc.blocks ?? {}
  const verbatim = new Set()
  const depth = new Map()
  const ranges = []
  const unopened = []
  const open = [] // [{ line, kind: 'end' | 'brace' | 'section' }]
  let header = 0
  let front = false
  let directive = false // inside a %%{ … }%% directive over several lines
  let acc = false
  let raw = null // the close pattern of a raw region being read
  let level = 1
  const closeTop = (kind, n) => {
    // A section ends where its enclosing block ends.
    while (open.length && open[open.length - 1].kind === 'section' && kind !== 'section') endSection(n - 1)
    const top = open[open.length - 1]
    if (!top || top.kind !== kind) {
      unopened.push({ line: n, kind })
      return false
    }
    open.pop()
    ranges.push({ start: top.line, end: n })
    level = Math.max(1, level - 1)
    return true
  }
  const endSection = last => {
    const top = open.pop()
    let end = last
    while (end > top.line && !lines[end - 1]?.trim()) end--
    if (end > top.line) ranges.push({ start: top.line, end })
    level = Math.max(1, level - 1)
  }
  lines.forEach((rawLine, i) => {
    const n = i + 1
    const t = rawLine.trim()
    if (i === 0 && t === '---') {
      front = true
      verbatim.add(n)
      return
    }
    if (front) {
      verbatim.add(n)
      if (t === '---') {
        front = false
        if (n > 2) ranges.push({ start: 1, end: n })
      }
      return
    }
    if (acc || raw) {
      verbatim.add(n)
      if (acc && t.includes('}')) acc = false
      if (raw?.test(t)) {
        raw = null
        verbatim.delete(n)
        closeTop('raw', n)
        depth.set(n, level)
      }
      return
    }
    if (directive || opensDirective(t)) {
      verbatim.add(n)
      directive = directive ? !t.includes('}%%') : true
      return
    }
    if (!t || t.startsWith('%%')) {
      depth.set(n, level)
      return
    }
    if (!header) {
      header = n
      depth.set(n, 0)
      return
    }
    if (/^accDescr\s*\{/.test(t)) {
      depth.set(n, level)
      if (!t.includes('}')) acc = true
      return
    }
    const masked = (blocks.mask ? blocks.mask(mask(t)) : mask(t)).trim()
    if (blocks.raw?.open.test(t) && !/:/.test(mask(t))) {
      depth.set(n, level)
      open.push({ line: n, kind: 'raw' })
      level++
      raw = blocks.raw.close
      return
    }
    if (blocks.sections?.test(t)) {
      if (open.length && open[open.length - 1].kind === 'section') endSection(n - 1)
      depth.set(n, level)
      open.push({ line: n, kind: 'section' })
      level++
      return
    }
    let opens = 0
    let closesFirst = false
    let rest = 0
    if (blocks.close?.test(t)) closesFirst = 'end'
    else if (blocks.braces && masked.startsWith('}')) closesFirst = 'brace'
    if (blocks.braces) {
      const b = (masked.match(/\{/g)?.length ?? 0) - (masked.match(/\}/g)?.length ?? 0)
      rest = closesFirst === 'brace' ? b + 1 : b
    }
    if (blocks.open?.test(t)) opens++
    if (closesFirst) closeTop(closesFirst, n)
    if (blocks.middle?.test(t)) {
      depth.set(n, Math.max(1, level - 1))
      return
    }
    depth.set(n, level)
    for (let k = 0; k < opens; k++) {
      open.push({ line: n, kind: 'end' })
      level++
    }
    for (let k = 0; k < rest; k++) {
      open.push({ line: n, kind: 'brace' })
      level++
    }
    for (let k = 0; k > rest; k--) closeTop('brace', n)
  })
  while (open.length && open[open.length - 1].kind === 'section') endSection(lines.length)
  const unclosed = open.filter(o => o.kind !== 'section')
  return { header, verbatim, depth, ranges: ranges.sort((a, b) => a.start - b.start), unclosed, unopened, lines }
}

/**
 * Formats the source: indentation by block depth (four spaces a level, the diagram's body one
 * level in) for types where indentation carries no meaning, the type's own spacing of a line
 * (flowchart arrows), no trailing spaces, at most one blank line. Quoted text and labels are left
 * as written. For indentation-sensitive types (mindmap, ...) only trailing spaces and runs of
 * blank lines change.
 */
export function format(text) {
  const desc = typeOf(text)
  const out = []
  const blank = () => {
    if (out.length && out[out.length - 1] !== '') out.push('')
  }
  if (desc.indent === 'keep' || desc.indent === 'none') {
    // Indentation is meaning ('keep'), or even trailing space is ('none': ABNF's `; ` comment).
    for (const raw of text.split('\n')) {
      if (raw.trim()) out.push(desc.indent === 'none' ? raw : raw.trimEnd())
      else blank()
    }
  } else {
    const s = structure(text.replace(/\t/g, INDENT), desc)
    s.lines.forEach((raw, i) => {
      const n = i + 1
      if (s.verbatim.has(n)) return out.push(raw.trimEnd())
      const line = raw.trim()
      if (!line) return blank()
      if (n === s.header) return out.push(line)
      const statement = !line.startsWith('%%') && desc.formatLine ? desc.formatLine(line) : line
      out.push(INDENT.repeat(s.depth.get(n) ?? 1) + statement)
    })
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return `${out.join('\n')}\n`
}

/**
 * Lint findings: { line (1-based), severity: 'error' | 'warning' | 'info', rule, message, fix? }.
 * Every type: balanced blocks, and with `config` (Mermaid's config schema, frontmatter.js) the
 * front matter's options. Then the type's own checks (the flowchart's are the house style).
 */
export function lint(text, { config } = {}) {
  const desc = typeOf(text)
  const s = structure(text, desc)
  const findings = []
  for (const u of s.unopened) {
    findings.push({
      line: u.line,
      severity: 'error',
      rule: 'block-balance',
      message:
        u.kind === 'brace'
          ? t('Extra }: there is no { before it to close')
          : t('Extra end: there is no open block before it to close'),
    })
  }
  for (const o of s.unclosed) {
    findings.push({
      line: o.line,
      severity: 'error',
      rule: 'block-balance',
      message:
        o.kind === 'brace'
          ? t('This { is never closed: add a matching }')
          : o.kind === 'raw'
            ? t('This block is never closed: add its closing line')
            : t('This block is never closed: add an end'),
    })
  }
  if (desc.check) {
    const lines = scrubbed(text, s)
    const ctx = { text, lines, verbatim: s.verbatim, header: s.header, structure: s, symbols: symbolsOf(text, desc, s) }
    findings.push(...desc.check(ctx))
  }
  findings.push(...configFindings(text, config))
  return findings.sort((a, b) => a.line - b.line)
}

/** The source with every fixable finding fixed, line by line (later fixes see earlier ones). */
export function fixAll(text, options = {}) {
  const lines = text.split('\n')
  for (let pass = 0; pass < 5; pass++) {
    const fixable = lint(lines.join('\n'), options).filter(f => f.fix !== undefined)
    if (!fixable.length) break
    const seen = new Set()
    for (const f of fixable) {
      if (seen.has(f.line)) continue // one fix a line a pass: each is computed on the line as it stood
      seen.add(f.line)
      lines[f.line - 1] = f.fix
    }
  }
  return lines.join('\n')
}

// The lines a type's scanners read: front matter, multi-line accDescr and whole-line comments
// blanked (line numbers stay).
function scrubbed(text, s) {
  return s.lines.map((l, i) => (s.verbatim.has(i + 1) || /^\s*%%/.test(l) ? '' : l))
}

function symbolsOf(text, desc = typeOf(text), s = structure(text, desc)) {
  return desc.symbols ? desc.symbols(scrubbed(text, s)) : []
}

/** The named elements of a source: [{ name, line, start, end, def, kind? }] (columns 1-based, end exclusive). */
export function symbols(text) {
  return symbolsOf(text)
}

// The three below take the source's symbols when they are known already (an editor keeps them).

/** The named element at a 1-based line and column (the caret right after a name belongs to it). */
export function symbolAt(text, line, column, syms = symbolsOf(text)) {
  const on = syms.filter(s => s.line === line)
  return on.find(s => column >= s.start && column < s.end) ?? on.find(s => column === s.end)
}

/** Every place `id` is a name in the source (not inside quotes or labels): { line, start, end }, 1-based. */
export function occurrences(text, id, syms = symbolsOf(text)) {
  return syms.filter(s => s.name === id).map(({ line, start, end }) => ({ line, start, end }))
}

/** Where `id` is defined: its declaring place, else its first. */
export function definition(text, id, syms = symbolsOf(text)) {
  const all = syms.filter(s => s.name === id)
  const d = all.find(s => s.def) ?? all[0]
  return d && { line: d.line, start: d.start, end: d.end }
}

/** The names a source declares or uses, in order of first appearance. */
export function names(text) {
  const desc = typeOf(text)
  if (desc.names) return desc.names(text)
  return [...new Set(symbolsOf(text, desc).map(s => s.name))]
}

/** The source with `from` renamed to `to` everywhere it is a name; quoted text is left alone. */
export function rename(text, from, to) {
  const lines = text.split('\n')
  const hits = symbolsOf(text)
    .filter(s => s.name === from)
    .sort((a, b) => b.line - a.line || b.start - a.start)
  for (const h of hits) {
    const l = lines[h.line - 1]
    lines[h.line - 1] = l.slice(0, h.start - 1) + to + l.slice(h.end - 1)
  }
  return lines.join('\n')
}

/** Whether `name` may be a new name in this source's type, and why not: undefined when it may. */
export function renameProblem(text, from, name) {
  const desc = typeOf(text)
  const pattern = desc.idPattern ?? /^[A-Za-z_][\w-]*$/
  if (!pattern.test(name))
    return desc.idHint ?? t('A name may only use letters, digits, _ and -, and cannot start with a digit')
  if (name !== from && names(text).includes(name)) return t('An element named {name} already exists', { name })
  return undefined
}

/** The block ranges a source folds: blocks, sections, front matter, indented hierarchy; 1-based lines. */
export function foldingRanges(text) {
  const desc = typeOf(text)
  const s = structure(text, desc)
  const ranges = [...s.ranges]
  if (desc.indent === 'keep') ranges.push(...indentRanges(s))
  const seen = new Set()
  return ranges
    .filter(r => r.end > r.start && !seen.has(`${r.start}`) && seen.add(`${r.start}`))
    .sort((a, b) => a.start - b.start)
}

// Indentation-defined hierarchy: a line folds the more indented lines after it.
function indentRanges(s) {
  const out = []
  const width = l => l.length - l.trimStart().length
  s.lines.forEach((l, i) => {
    if (!l.trim() || s.verbatim.has(i + 1) || l.trim().startsWith('%%')) return
    let end = i
    for (let j = i + 1; j < s.lines.length; j++) {
      const m = s.lines[j]
      if (!m.trim()) continue
      if (width(m) <= width(l)) break
      end = j
    }
    if (end > i && i + 1 !== s.header) out.push({ start: i + 1, end: end + 1 })
  })
  return out
}

/**
 * The tokens of a line for highlighting, with the state the next line starts in: the diagram's
 * type is known from its keyword line on; front matter and directives are 'meta'.
 * state: { type, front, directive, acc, started } (start with initialState()).
 */
export const initialState = () => ({ type: '', front: false, directive: false, acc: false, started: false, line: 0 })
export function lineTokens(line, state) {
  const next = { ...state, line: state.line + 1 }
  const t = line.trim()
  if (state.line === 0 && t === '---')
    return { tokens: [{ type: 'meta', text: line }], state: { ...next, front: true } }
  if (state.front) return { tokens: [{ type: 'meta', text: line }], state: { ...next, front: t !== '---' } }
  if (state.acc) return { tokens: [{ type: 'string', text: line }], state: { ...next, acc: !line.includes('}') } }
  if (state.directive)
    return { tokens: [{ type: 'meta', text: line }], state: { ...next, directive: !t.includes('}%%') } }
  if (opensDirective(t)) return { tokens: [{ type: 'meta', text: line }], state: { ...next, directive: true } }
  if (/^%%\{.*\}%%\s*$/.test(t)) return { tokens: [{ type: 'meta', text: line }], state: next }
  if (!t || t.startsWith('%%'))
    return { tokens: line ? [{ type: line.trim() ? 'comment' : 'space', text: line }] : [], state: next }
  if (/^accDescr\s*\{/.test(t)) {
    const at = line.indexOf('{') + 1
    return {
      tokens: [
        { type: 'keyword', text: line.slice(0, at) },
        { type: 'string', text: line.slice(at) },
      ],
      state: { ...next, acc: !line.slice(at).includes('}') },
    }
  }
  if (/^acc(Title|Descr)\s*:/.test(t)) {
    const at = line.indexOf(':') + 1
    return {
      tokens: [
        { type: 'keyword', text: line.slice(0, at) },
        { type: 'string', text: line.slice(at) },
      ],
      state: next,
    }
  }
  if (!state.started) {
    const desc = typeOfHeader(t)
    const m = /^(\s*)(\S+)(.*)$/.exec(line)
    const tokens = [{ type: 'space', text: m[1] }, { type: 'keyword', text: m[2] }, ...tokensOf(desc, m[3])].filter(
      x => x.text,
    )
    return { tokens, state: { ...next, started: true, type: desc.id } }
  }
  return { tokens: tokensOf(typeById(state.type), line), state: next }
}
const tokensOf = (desc, line) => (desc.tokenize ?? flowTokens)(line)
const typeById = id => typeOf.byId(id) ?? GENERIC

/**
 * The source side of the link between a drawing and its source: select(key) the lines of a
 * drawn element ({ primary, related }), keysAt(line) the elements a line names, neighbors(key)
 * the edges and nodes a node is connected by. Keys:
 * 'node:<name>' for named elements, the type's own for ordered items (messages, tasks...).
 */
export function linkModel(text, desc = typeOf(text)) {
  if (desc.model) return desc.model(text)
  const s = structure(text, desc)
  const lines = scrubbed(text, s)
  const syms = desc.symbols ? desc.symbols(lines) : []
  const items = desc.items ? desc.items(lines, syms, s) : []
  const byName = new Map()
  for (const sym of syms) {
    const e = byName.get(sym.name) ?? { def: undefined, lines: new Set() }
    if (sym.def && e.def === undefined) e.def = sym.line
    e.lines.add(sym.line)
    byName.set(sym.name, e)
  }
  const byKey = new Map(items.map(it => [it.key, it]))
  const itemsAt = n => items.filter(it => (it.lights ?? [it.line]).includes(n))
  const namesAt = n => [...new Set(syms.filter(x => x.line === n).map(x => `node:${x.name}`))]
  const keysAt = n => [...namesAt(n), ...itemsAt(n).map(it => it.key)]
  return {
    text,
    names: [...byName.keys()],
    syms,
    items,
    select(key) {
      const it = byKey.get(key)
      if (it) {
        const end = it.end ?? it.line
        return { primary: it.line, related: Array.from({ length: end - it.line + 1 }, (_, k) => it.line + k) }
      }
      if (key.startsWith('node:')) {
        const e = byName.get(key.slice(5))
        if (!e) return undefined
        const related = [...e.lines].sort((a, b) => a - b)
        return { primary: e.def ?? related[0], related }
      }
      return undefined
    },
    keysAt,
    // A node's connections: on each line naming it that also draws something of its own (a
    // relation, a message, a transition...; a note is aside), that and the other names on the line.
    neighbors(key) {
      const e = key.startsWith('node:') ? byName.get(key.slice(5)) : undefined
      const out = new Set()
      for (const n of e?.lines ?? []) {
        const links = itemsAt(n).filter(it => !it.aside)
        if (links.length) for (const k of [...namesAt(n), ...links.map(it => it.key)]) out.add(k)
      }
      out.delete(key)
      return [...out]
    },
  }
}

/** A line diff of two sources: [{ op: ' ' | '-' | '+', text }], `-` from a, `+` from b (LCS). */
export function lineDiff(a, b) {
  const fullA = a.replace(/\n$/, '').split('\n')
  const fullB = b.replace(/\n$/, '').split('\n')
  // The lines both start with are common as they are (the walk below would take them so): the
  // table is built for the lines after them only.
  let same = 0
  while (same < fullA.length && same < fullB.length && fullA[same] === fullB[same]) same++
  const out = fullA.slice(0, same).map(text => ({ op: ' ', text }))
  const x = fullA.slice(same)
  const y = fullB.slice(same)
  const n = x.length
  const m = y.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: ' ', text: x[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: '-', text: x[i++] })
    else out.push({ op: '+', text: y[j++] })
  }
  while (i < n) out.push({ op: '-', text: x[i++] })
  while (j < m) out.push({ op: '+', text: y[j++] })
  return out
}
