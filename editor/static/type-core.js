// The parts every diagram type's descriptor is built from: a line lexer, masking of quoted and
// free text, scanning names with their columns, and the shared ordered-item helpers. Pure
// functions, no DOM.
//
// A descriptor (one module per diagram type, listed in types.js) is a plain object:
//   id, name           the type's key and its name in the README's table
//   header             RegExp tested on the first statement line (trimmed): the diagram's keyword
//   lexer              { keywords, arrows, id?, labels?, colon?, numbers?, caseInsensitive? } (see lexer())
//   blocks             { open?, middle?, close?, braces?, sections? }: what nests (see mermaid-lang.js)
//   indent             'depth': the formatter indents by block depth; 'keep': indentation is meaning,
//                      only trailing spaces and runs of blank lines are tidied
//   symbols(lines)     the named elements: [{ name, line, start, end, def, kind? }], 1-based, end exclusive
//   idPattern          what a new name must look like to rename to it
//   items(lines, syms) the ordered elements a drawing shows (messages, tasks, relations...):
//                      [{ key, line, end?, lights?, aside? }]; aside: a note, beside what it names,
//                      not a connection between them
//   check(ctx)         the type's own lint findings
//   snippets, starter  completion snippets, and the body of a new diagram of this type
//   link               { kinds: [{ selector, key(rec, ctx), info?(el) }], resolve?(target) }:
//                      which rendered elements stand for which source element (diagram-link.js)
//   looks, layouts     the looks besides classic and the layouts besides dagre Mermaid draws this
//                      type with ('neo', 'handDrawn'; 'elk'); others it ignores or fails on (themes.js)

import { t } from './i18n.js'
/** A drawn node's group: Mermaid classes it `node`, or `rough-node` in the hand-drawn look. */
export const NODE = 'g.node, g.rough-node'

/** A word's characters for most types: letters, digits, underscores, inner dashes. */
export const WORD = /^[A-Za-z_][\w]*(?:-(?![-.>=])\w+)*/

/**
 * A tokenizer of one line for a lexer spec: { type, text } tokens, type one of comment, string,
 * label, keyword, arrow, id, number, punct, text, space.
 *   keywords   words highlighted as keywords (Set or array)
 *   arrows     RegExp anchored at ^: relation and arrow operators
 *   id         RegExp anchored at ^: an identifier (default WORD)
 *   labels     true: |text| is a label (flowchart edges)
 *   colon      'text': after the first ':' outside quotes the rest of the line is a label;
 *              'before': the text before the first ':' is the label (gantt, journey, timeline)
 *   numbers    true: numbers are their own tokens
 *   caseInsensitive  keywords match in any case
 *   comment    RegExp anchored at ^: the type's own comments besides %%
 */
export function lexer(spec) {
  const words = spec.caseInsensitive ? new Set([...spec.keywords].map(k => k.toLowerCase())) : new Set(spec.keywords)
  const isKeyword = w => words.has(spec.caseInsensitive ? w.toLowerCase() : w)
  const idRe = spec.id ?? WORD
  return function tokenize(line) {
    const out = []
    const push = (type, text) => {
      if (text) out.push({ type, text })
    }
    let i = 0
    if (spec.colon === 'before') {
      const c = colonAt(line)
      if (c > 0 && /\S/.test(line.slice(0, c)) && !isKeyword(line.trim().split(/\s+/)[0])) {
        const lead = /^\s*/.exec(line)[0]
        push('space', lead)
        push('label', line.slice(lead.length, c))
        i = c
      }
    }
    while (i < line.length) {
      const rest = line.slice(i)
      let m
      if (rest.startsWith('%%')) {
        push('comment', rest)
        break
      }
      if (spec.comment && (m = spec.comment.exec(rest))) {
        push('comment', m[0])
        i += m[0].length
        continue
      }
      if (spec.colon === 'text' && rest[0] === ':' && !/^:::/.test(rest)) {
        push('punct', ':')
        push('label', rest.slice(1))
        break
      }
      if ((m = /^\s+/.exec(rest))) push('space', m[0])
      else if ((m = /^"[^"]*"?/.exec(rest))) push('string', m[0])
      else if (spec.labels && (m = /^\|[^|]*\|?/.exec(rest))) push('label', m[0])
      else if (spec.arrows && (m = spec.arrows.exec(rest)) && m[0]) push('arrow', m[0])
      else if (
        spec.numbers &&
        (m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?![\w])/.exec(rest)) &&
        (i === 0 || !/\w/.test(line[i - 1]))
      )
        push('number', m[0])
      else if ((m = idRe.exec(rest))) push(isKeyword(m[0]) ? 'keyword' : 'id', m[0])
      else if ((m = /^[[\](){}<>:;,&@]/.exec(rest))) push('punct', m[0])
      else if ((m = /^[^\s"|[\](){}<>:;,&@%-]+|^[%-]/.exec(rest))) push('text', m[0])
      i += m ? m[0].length : 1
    }
    return out
  }
}

/**
 * The column (0-based) of the first ':' outside double quotes, or -1. classes: true, the colons
 * of a `:::` (a class shorthand, `a:::cls`) are not one.
 */
export function colonAt(line, { classes = false } = {}) {
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (classes && !quoted && line.startsWith(':::', i)) i += 2
    else if (line[i] === ':' && !quoted) return i
    else if (line.startsWith('%%', i) && !quoted) return -1
  }
  return -1
}

/** The column (0-based) of a %% comment outside double quotes, or -1. */
export function commentAt(line) {
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (!quoted && line.startsWith('%%', i)) return i
  }
  return -1
}

/**
 * The line with its quoted text, its comment and (from: 0-based column) everything after `from`
 * blanked out, same length: names are scanned in what is left, so their columns stay true.
 * comment: the type's own comment marker besides %% (`#`, `//`), likewise read outside quotes.
 */
export function mask(line, from = -1, comment) {
  let out = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (from >= 0 && i >= from) return out + ' '.repeat(line.length - i)
    if (!quoted && (line.startsWith('%%', i) || (comment && line.startsWith(comment, i))))
      return out + ' '.repeat(line.length - i)
    if (ch === '"') {
      quoted = !quoted
      out += ' '
    } else out += quoted ? ' ' : ch
  }
  return out
}

/**
 * Every match of `re` (a RegExp; global and indices flags are added) in `text`, with the 1-based
 * columns of capture group `group`: [{ name, start, end }] (end exclusive). Names are trimmed.
 */
export function scan(text, re, group = 1) {
  const flags = new Set([...re.flags, 'g', 'd'])
  const g = new RegExp(re.source, [...flags].join(''))
  const out = []
  for (const m of text.matchAll(g)) {
    if (m[group] === undefined) continue
    let [s, e] = m.indices[group]
    while (s < e && /\s/.test(text[s])) s++
    while (e > s && /\s/.test(text[e - 1])) e--
    if (e > s) out.push({ name: text.slice(s, e), start: s + 1, end: e + 1 })
    if (m[0] === '') g.lastIndex++
  }
  return out
}

/** A symbol list builder: add(name, line, start, end, def, kind) keeps them in source order. */
export function symbolList() {
  const list = []
  return {
    list,
    add(hit, line, def = false, kind) {
      list.push({ name: hit.name, line, start: hit.start, end: hit.end, def, ...(kind ? { kind } : {}) })
    },
  }
}

/** Escapes a string for use in a RegExp. */
export const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The names of a comma list captured by `re`'s first group (as `class a,b cls`), with columns. */
export function scanList(line, re) {
  const list = scan(line, re)[0]
  if (!list) return []
  const out = []
  let col = list.start
  for (const name of list.name.split(',')) {
    const lead = name.length - name.trimStart().length
    if (name.trim()) out.push({ name: name.trim(), start: col + lead, end: col + lead + name.trim().length })
    col += name.length + 1
  }
  return out
}

/** Findings for names declared twice: { line, ... } for each later declaration. */
export function duplicates(symbols, message, kind) {
  const seen = new Map()
  const out = []
  for (const s of symbols) {
    if (!s.def || (kind !== undefined && s.kind !== kind)) continue
    if (seen.has(s.name))
      out.push({ line: s.line, severity: 'warning', rule: 'duplicate', message: message(s.name, seen.get(s.name)) })
    else seen.set(s.name, s.line)
  }
  return out
}

/** Findings for names used but never declared. */
export function undeclared(symbols, message, kind) {
  const declared = new Set(symbols.filter(s => s.def && (kind === undefined || s.kind === kind)).map(s => s.name))
  return symbols
    .filter(s => !s.def && (kind === undefined || s.kind === kind) && !declared.has(s.name))
    .map(s => ({ line: s.line, severity: 'warning', rule: 'undeclared', message: message(s.name) }))
}

/** Findings for lines holding `direction LR` after other text: read as a direction statement, the whole line is lost. */
export function directionText(lines) {
  const out = []
  lines.forEach((l, i) => {
    if (/\S.*\bdirection\s+(TB|BT|RL|LR)\b/.test(l.trim()))
      out.push({
        line: i + 1,
        severity: 'warning',
        rule: 'direction-text',
        message: t('This line has the word direction, which is read as a direction statement: the whole line is lost'),
      })
  })
  return out
}

/** The item whose label reads `text` (the drawing may drop or move spaces): its key. */
export function keyByText(items, text) {
  const want = (text ?? '').replace(/\s+/g, '')
  return want ? items.find(it => it.label !== undefined && it.label.replace(/\s+/g, '') === want)?.key : undefined
}

/** The line with what is inside brackets (shapes, labels, `@{ }` metadata) blanked; the outer brackets stay. Same length. */
export function maskBrackets(line) {
  let out = ''
  let depth = 0
  let quoted = false
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    const opens = !quoted && '([{|'.includes(ch) && !(ch === '|' && depth)
    const closes = !quoted && (')]}'.includes(ch) || (ch === '|' && depth))
    if (closes) depth = Math.max(0, depth - 1)
    out += depth && !(opens && depth === 0) ? ' '.repeat(ch.length) : ch
    if (opens) depth++
  }
  return out
}
