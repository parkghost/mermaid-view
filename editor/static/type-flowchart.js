// Flowcharts (flowchart, graph, flowchart-elk): node ids by their tokens, the house-style lint
// (quoted subgraph titles, edge labels and node text, plain ids, ASCII edge labels, no styling
// directives), arrows spaced by the formatter, and the drawing's nodes, edges and subgraphs.

import { t } from './i18n.js'
import { escapeRe, lexer, maskBrackets, NODE } from './type-core.js'

export const KEYWORDS = new Set([
  'flowchart',
  'graph',
  'subgraph',
  'end',
  'direction',
  'classDef',
  'class',
  'style',
  'linkStyle',
  'click',
  'sequenceDiagram',
  'participant',
  'actor',
  'note',
  'Note',
  'loop',
  'alt',
  'else',
  'opt',
  'par',
  'and',
  'critical',
  'break',
  'rect',
  'autonumber',
  'activate',
  'deactivate',
  'classDiagram',
  'stateDiagram',
  'stateDiagram-v2',
  'erDiagram',
  'gantt',
  'title',
  'section',
  'dateFormat',
  'pie',
  'journey',
  'mindmap',
  'timeline',
  'gitGraph',
  'TD',
  'TB',
  'BT',
  'LR',
  'RL',
  'over',
  'left',
  'right',
  'of',
])
// A link as Mermaid's lexer reads one: its line (--, ==, -.-, and ~~~ or longer), with a head at
// either end, < > o x (`A o--o B`, `C x--x D`).
const ARROW = /^([xo<]?(?:-{2,}|={2,}|-\.+-|~{3,})[>ox]?|[xo<]?-\.->|-\.-)/
const LEXER = { keywords: KEYWORDS, arrows: ARROW, labels: true }

/** The tokens of one line: { type, text }, type one of comment, string, label, keyword, arrow, id, punct, text, space. */
export const tokenize = lexer(LEXER)

// The first word of a line, outside comments.
const head = line => line.trim().split(/\s+/)[0] ?? ''
const FLOW_HEAD = /^\s*(flowchart|graph)\b/

/**
 * The lines with shape data blanked, its `@` too (`A@{ shape: cyl }`, `e1@{ animate: true }`; it
 * may span lines): what is left is ids, shapes, arrows, labels and edge ids (`e1@-->`). Same lengths.
 */
export function maskShapeData(lines) {
  let open = false
  let quoted = false
  return lines.map(line => {
    let out = ''
    if (!open) quoted = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (open) {
        if (ch === '"') quoted = !quoted
        else if (ch === '}' && !quoted) open = false
        out += ' '
        continue
      }
      if (ch === '"') quoted = !quoted
      if (!quoted && ch === '@' && line[i + 1] === '{') {
        open = true
        out += '  '
        i++
        continue
      }
      out += ch
    }
    return out
  })
}

// The lines as names are read from: whole-line %% comments, shape data and the text inside
// shapes and labels blanked.
const nameLines = lines => maskShapeData(lines).map((l, i) => (lines[i].trim().startsWith('%%') ? '' : maskBrackets(l)))

// The tokens of a name line; an id written right before `@` and an arrow (`e1@-->`) names its
// edge, not a node: { edge: true }.
function nameTokens(line) {
  const tokens = tokenize(line)
  return tokens.map((t, i) =>
    t.type === 'id' && tokens[i + 1]?.text === '@' && tokens[i + 2]?.type === 'arrow' ? { ...t, edge: true } : t,
  )
}

/** The edge ids a flowchart's source gives (`A e1@--> B`): Map id -> { from, to, line }. */
export function edgeIds(text) {
  const edges = new Map()
  nameLines(text.split('\n')).forEach((line, i) => {
    const tokens = nameTokens(line).filter(t => t.type === 'id' || t.type === 'arrow')
    tokens.forEach((t, k) => {
      if (!t.edge || edges.has(t.text)) return
      const from = tokens[k - 1]
      const to = tokens.slice(k + 2).find(x => x.type === 'id')
      if (from?.type === 'id' && to) edges.set(t.text, { from: from.text, to: to.text, line: i + 1 })
    })
  })
  return edges
}

/** The ids a flowchart's source names: node ids in the order they first appear (edge ids aside). */
export function nodeIds(text) {
  const ids = []
  const seen = new Set(edgeIds(text).keys())
  const raws = text.split('\n')
  nameLines(raws).forEach((masked, i) => {
    const line = raws[i].trim()
    if (!line || FLOW_HEAD.test(line)) return
    const word = head(line)
    if (word === 'subgraph' || word === 'end' || /^(classDef|class|style|click|linkStyle|direction)\b/.test(line))
      return
    for (const t of nameTokens(masked)) {
      if (t.type === 'id' && !t.edge && !seen.has(t.text)) {
        seen.add(t.text)
        ids.push(t.text)
      }
    }
  })
  return ids
}

// The ids on a (name) line, in order, ignoring quoted text, labels, shape text and edge ids.
const idsOf = masked =>
  nameTokens(masked)
    .filter(t => t.type === 'id' && !t.edge)
    .map(t => t.text)

/** The node ids on a line, in order, ignoring quoted text, labels, shape text and shape data. */
export function idsOnLine(line) {
  return idsOf(nameLines([line])[0])
}

/**
 * The source lines of a diagram element, 1-based: { primary, related }.
 * kind 'node': primary is the line defining it (id followed by a shape), else its first mention;
 * related, every line naming it. kind 'edge' (from, to): the line linking them in that order.
 * kind 'cluster' (index): the index-th subgraph line. Undefined when nothing matches.
 */
export function sourceLines(text, element) {
  const lines = text.split('\n')
  const named = nameLines(lines)
  const at = []
  if (element.kind === 'node') {
    let primary
    lines.forEach((l, i) => {
      const ids = idsOf(named[i])
      if (!ids.includes(element.id)) return
      at.push(i + 1)
      if (primary === undefined && defines(l, element.id)) primary = i + 1
    })
    if (!at.length) return undefined
    return { primary: primary ?? at[0], related: at }
  }
  if (element.kind === 'edge') {
    const idx = named.findIndex(l => {
      const ids = idsOf(l)
      const a = ids.indexOf(element.from)
      return a >= 0 && ids.indexOf(element.to, a + 1) > a && tokenize(l).some(t => t.type === 'arrow')
    })
    if (idx < 0) return undefined
    // An edge with an id (`A e1@--> B`) also lights the lines that give it metadata (`e1@{ ... }`).
    const ids = [...edgeIds(text)]
      .filter(([, e]) => e.line === idx + 1 && e.from === element.from && e.to === element.to)
      .map(([id]) => id)
    const related = [idx + 1]
    named.forEach((l, i) => {
      if (i !== idx && nameTokens(l).some(t => t.type === 'id' && ids.includes(t.text))) related.push(i + 1)
    })
    return { primary: idx + 1, related }
  }
  if (element.kind === 'cluster') {
    let count = -1
    const idx = lines.findIndex(l => head(l) === 'subgraph' && ++count === element.index)
    if (idx < 0) return undefined
    let depth = 0,
      close = idx
    for (let i = idx; i < lines.length; i++) {
      const w = head(lines[i])
      if (w === 'subgraph') depth++
      if (w === 'end' && --depth === 0) {
        close = i
        break
      }
    }
    return { primary: idx + 1, related: Array.from({ length: close - idx + 1 }, (_, k) => idx + 1 + k) }
  }
  return undefined
}

// Whether a line defines a node: its id followed by a shape or shape data.
const defines = (line, id) => new RegExp(`(^|[\\s;&])${escapeRe(id)}\\s*(?:[\\[({>]|@\\{)`).test(line)

/** The index, among the source's subgraphs, of the one titled `title` (quotes and id[...] aside). */
export function subgraphIndex(text, title) {
  const want = title.trim()
  const titles = text
    .split('\n')
    .filter(l => head(l) === 'subgraph')
    .map(l => {
      const rest = l.trim().slice('subgraph'.length).trim()
      const bracket = /^\S+\s*\[\s*"?([^"\]]*)"?\s*\]/.exec(rest)
      return (bracket ? bracket[1] : rest.replace(/^"(.*)"$/, '$1')).trim()
    })
  const i = titles.indexOf(want)
  return i < 0 ? undefined : i
}

/**
 * The element a rendered flowchart's DOM id stands for, given the source's node ids:
 * node "flowchart-<id>-<n>", edge "L_<from>_<to>_<n>" (or with dashes). Mermaid 12 leads the
 * DOM ids with the render's id: `prefix` (that id) is taken off first. Undefined otherwise.
 */
export function elementOfDomId(domId, ids, prefix = '', edges = new Map()) {
  if (prefix && domId.startsWith(`${prefix}-`)) domId = domId.slice(prefix.length + 1)
  // An edge with an id (`A e1@--> B`) is drawn under that id.
  const edge = edges.get(domId)
  if (edge) return { kind: 'edge', from: edge.from, to: edge.to }
  let m = /^flowchart-(.+)-\d+$/.exec(domId)
  if (m && ids.includes(m[1])) return { kind: 'node', id: m[1] }
  m = /^L[-_](.+)[-_]\d+$/.exec(domId)
  if (m) {
    const pair = m[1]
    for (const from of ids) {
      for (const sep of ['_', '-']) {
        if (pair.startsWith(from + sep) && ids.includes(pair.slice(from.length + 1))) {
          return { kind: 'edge', from, to: pair.slice(from.length + 1) }
        }
      }
    }
  }
  return undefined
}

// The source element keys of one line: its nodes, the edges its arrows draw, the subgraph it opens.
function keysOfLine(lines, named, edges, n) {
  const line = lines[n - 1] ?? ''
  // An edge id's own line (`e1@{ animate: true }`) is its edge's.
  const keys = idsOf(named[n - 1] ?? '').map(id =>
    edges.has(id) ? `edge:${edges.get(id).from}>${edges.get(id).to}` : `node:${id}`,
  )
  for (const [from, to] of linksOf(named[n - 1] ?? '')) keys.push(`edge:${from}>${to}`)
  if (/^\s*subgraph\b/.test(line)) {
    const before = lines.slice(0, n - 1).filter(l => /^\s*subgraph\b/.test(l)).length
    keys.push(`cluster:${before}`)
  }
  return keys
}

// The edges a (name) line's arrows draw, [from, to]: each arrow links every id of the group before
// it to every id of the group after it (`A & B --> C`). A `;` ends a statement, and the words
// between a text link's `--` or `==` and its arrow are its text (`A -- yes --> B`).
function linksOf(masked) {
  const links = []
  let groups = [[]]
  let text = false
  const end = () => {
    links.push(...groups.slice(1).flatMap((to, i) => groups[i].flatMap(from => to.map(id => [from, id]))))
    groups = [[]]
  }
  for (const t of nameTokens(masked)) {
    if (t.type === 'punct' && t.text === ';') end()
    else if (t.type === 'arrow' && text) text = false
    else if (t.type === 'arrow') {
      groups.push([])
      text = t.text === '--' || t.text === '=='
    } else if (t.type === 'id' && !t.edge && !text) groups.at(-1).push(t.text)
  }
  end()
  return links
}

// The keys a node is connected by: its edges and the nodes at their other ends.
function neighborsOf(named, key) {
  if (!key.startsWith('node:')) return []
  const id = key.slice(5)
  const out = new Set()
  named.forEach(l => {
    for (const [from, to] of linksOf(l)) {
      if (from !== id && to !== id) continue
      out.add(`edge:${from}>${to}`)
      out.add(`node:${from === id ? to : from}`)
    }
  })
  out.delete(key) // a loop's other end is the node itself
  return [...out]
}

const keyOf = el =>
  el.kind === 'node' ? `node:${el.id}` : el.kind === 'edge' ? `edge:${el.from}>${el.to}` : `cluster:${el.index}`
const elementOfKey = key => {
  const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
  if (kind === 'node') return { kind, id: rest }
  if (kind === 'edge') return { kind, from: rest.slice(0, rest.indexOf('>')), to: rest.slice(rest.indexOf('>') + 1) }
  return { kind, index: Number(rest) }
}

// One space before and after an arrow (its |label| stays attached) and between other tokens
// that had space between them; quoted text, a single token, keeps its own spaces.
function spaceArrows(line) {
  const tokens = tokenize(line)
  let s = ''
  let space = false
  const emit = text => {
    if (space && s) s += ' '
    space = false
    s += text
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type === 'space') {
      space = true
      continue
    }
    if (t.type !== 'arrow') {
      emit(t.text)
      continue
    }
    space = true
    emit(t.text)
    let j = i + 1
    while (tokens[j]?.type === 'space') j++
    if (tokens[j]?.type === 'label') {
      s += tokens[j].text
      i = j
    }
    space = true
  }
  return s
}

// The line as its node definitions are read: shape data (`masked`) and arrows outside shapes
// blanked, so `A-->B[x]` reads as two nodes. Same length.
function nodeLine(masked) {
  let out = ''
  let depth = 0
  for (const t of tokenize(masked)) {
    if (t.type === 'punct' && '[({'.includes(t.text)) depth++
    if (t.type === 'punct' && '])}'.includes(t.text)) depth = Math.max(0, depth - 1)
    out += t.type === 'arrow' && !depth ? ' '.repeat(t.text.length) : t.text
  }
  return out
}

// The line with the text inside double quotes blanked and the quotes kept (`a["f(x)"]` reads
// `a["    "]`): a quoted label's brackets and bars are its text, not shapes or edge labels. Same length.
const blankQuoted = line => line.replace(/"[^"]*"/g, q => `"${' '.repeat(q.length - 2)}"`)

// The line with its text from start to end replaced; no replacement patterns (`$&`, `$$` in a label stay).
const splice = (line, start, end, text) => line.slice(0, start) + text + line.slice(end)

// The house-style findings of one flowchart line (`masked`: its shape data blanked; same length as raw).
function styleFindings(raw, masked, n) {
  const findings = []
  const line = raw.trim()
  const word = head(line)
  const nodes = blankQuoted(nodeLine(masked))
  if (word === 'subgraph') {
    const title = line.slice('subgraph'.length).trim()
    if (/\s/.test(title) && !/^"/.test(title) && !/^\S+\s*\[/.test(title)) {
      findings.push({
        line: n,
        severity: 'warning',
        rule: 'subgraph-quote',
        message: t('Subgraph title has spaces: put it in double quotes'),
        fix: raw.replace(title, () => `"${title}"`),
      })
    }
  }
  if (/^(classDef|style|click|linkStyle)\b/.test(line)) {
    findings.push({
      line: n,
      severity: 'info',
      rule: 'no-styling',
      message: t('Avoid {word} unless it is really needed', { word }),
    })
  }
  // Edge labels: |text| must be quoted and plain ASCII arrows only.
  for (const m of blankQuoted(masked).matchAll(/\|[^|]*\|/g)) {
    const [start, end] = [m.index + 1, m.index + m[0].length - 1] // the label inside its bars
    const label = raw.slice(start, end)
    if (!/^".*"$/.test(label.trim())) {
      findings.push({
        line: n,
        severity: 'warning',
        rule: 'edge-label-quote',
        message: t('Put edge label |{label}| in double quotes', { label }),
        fix: splice(raw, start, end, `"${label.trim()}"`),
      })
    }
    if (/[→<>#]/.test(label)) {
      findings.push({
        line: n,
        severity: 'warning',
        rule: 'edge-label-chars',
        message: t('Edge label |{label}| has a character such as →, <, > or #: write ->, to or vs instead', { label }),
      })
    }
  }
  // Node definitions: id[text] with plain ids and quoted text. Styling lines name no shapes.
  if (/^(classDef|class|style|click|linkStyle)\b/.test(line)) return findings
  for (const m of nodes.matchAll(/(^|[\s;&>|-])([^\s"[\](){}|;&-]+)(\[|\(|\{)(?!["([{])([^\]){}"]*)(\]|\)|\})/g)) {
    const [, before, id, open, , close] = m
    if (word === 'subgraph' || KEYWORDS.has(id)) continue
    const start = m.index + before.length
    const end = m.index + m[0].length
    const body = raw.slice(start + id.length + open.length, end - close.length)
    // The slants of a lean or trapezoid shape (`A[/text\]`) stay outside the quotes.
    const [, lead, text, trail] = /^([/\\]?)(.*?)([/\\]?)$/.exec(body)
    const quoted = lead && trail ? `${lead}"${text}"${trail}` : `"${body}"`
    findings.push({
      line: n,
      severity: 'warning',
      rule: 'node-text-quote',
      message: t('Put the text of node {id} in double quotes, as ["..."]', { id }),
      fix: splice(raw, start, end, `${id}${open}${quoted}${close}`),
    })
  }
  for (const m of nodes.matchAll(/(?:^|[\s;&])([^\s"[\](){}|;&]+?)\s*(?=\[|\(|\{)/g)) {
    const id = m[1]
    if (word === 'subgraph' || KEYWORDS.has(id)) continue
    if (!/^[A-Za-z0-9_]+$/.test(id)) {
      findings.push({
        line: n,
        severity: 'warning',
        rule: 'node-id',
        message: t('Node id "{id}": use only letters, digits and underscores', { id }),
      })
    }
  }
  return findings
}

export default {
  id: 'flowchart',
  name: 'Flowchart',
  header: /^(flowchart-elk|flowchart|graph)\b/,
  looks: ['neo', 'handDrawn'],
  layouts: ['elk'],
  lexer: LEXER,
  tokenize,
  blocks: { open: /^subgraph\b/, close: /^end\b/ },
  indent: 'depth',
  formatLine: spaceArrows,
  idPattern: /^[A-Za-z_][A-Za-z0-9_]*$/,

  // Every place a node id or an edge id is a token (not the text inside shapes or shape data);
  // the defining one (id then a shape or shape data) else the first, def.
  symbols(lines) {
    const out = []
    const firstDef = new Map()
    const edgeAt = new Map() // an edge id is defined by its edge
    nameLines(lines).forEach((masked, i) => {
      const line = lines[i]
      let start = 1
      for (const t of nameTokens(masked)) {
        const end = start + t.text.length
        if (t.type === 'id') {
          out.push({ name: t.text, line: i + 1, start, end, def: false })
          if (t.edge && !edgeAt.has(t.text)) edgeAt.set(t.text, i + 1)
          if (!firstDef.has(t.text) && defines(line, t.text)) firstDef.set(t.text, i + 1)
        }
        start = end
      }
    })
    for (const [name, line] of edgeAt) firstDef.set(name, line)
    const marked = new Set()
    for (const s of out) {
      const want = firstDef.get(s.name)
      if (marked.has(s.name)) continue
      if (want === undefined || want === s.line) {
        s.def = true
        marked.add(s.name)
      }
    }
    return out
  },
  // A rename must not take another node's or edge's id.
  names: text => [...nodeIds(text), ...edgeIds(text).keys()],

  check(ctx) {
    const masked = maskShapeData(ctx.lines)
    return ctx.lines.flatMap((raw, i) => {
      const line = raw.trim()
      if (!line || ctx.verbatim.has(i + 1) || ctx.header === i + 1) return []
      return styleFindings(raw, masked[i], i + 1)
    })
  },

  snippets: [
    [t('Node ["text"]'), t('${1:Id}["${2:text}"]')],
    [t('Rounded node ("text")'), t('${1:Id}("${2:text}")')],
    [t('Decision {"text"}'), t('${1:Id}{"${2:question}"}')],
    [t('Stadium (["text"])'), t('${1:Id}(["${2:text}"])')],
    [t('Database [("text")]'), t('${1:Id}[("${2:text}")]')],
    [t('Link -->|"label"|'), t('${1:From} -->|"${2:label}"| ${3:To}')],
    [t('Dotted link -.->|"label"|'), t('${1:From} -.->|"${2:label}"| ${3:To}')],
    [t('subgraph'), t('subgraph "${1:title}"\n\t$0\nend')],
  ],
  starter: t('flowchart TD\n\t${1:A}["${2:Start}"] --> ${3:B}["${4:End}"]'),

  // The drawing: nodes "flowchart-<id>-<n>", edges by their data-id, subgraphs by title.
  model(text) {
    const lines = text.split('\n')
    const named = nameLines(lines)
    const edges = edgeIds(text)
    return {
      ids: nodeIds(text),
      edges,
      text,
      select: key => sourceLines(text, elementOfKey(key)),
      keysAt: n => keysOfLine(lines, named, edges, n),
      neighbors: key => neighborsOf(named, key),
    }
  },
  link: {
    kinds: [
      { selector: NODE, key: (rec, ctx) => keyFrom(elementOfDomId(rec.id, ctx.model.ids, ctx.prefix), 'node') },
      {
        selector: '[data-id], path[id]',
        key: (rec, ctx) =>
          keyFrom(elementOfDomId(rec.dataId || rec.id, ctx.model.ids, ctx.prefix, ctx.model.edges), 'edge'),
      },
      {
        selector: 'g.cluster',
        info: el => ({ title: el.querySelector('.cluster-label, .nodeLabel, text')?.textContent ?? '' }),
        key: (rec, ctx) => `cluster:${subgraphIndex(ctx.model.text, rec.title) ?? rec.nth}`,
      },
    ],
    resolve: target => target.closest('.edgeLabel')?.querySelector('[data-id]'),
  },
}

const keyFrom = (el, kind) => (el?.kind === kind ? keyOf(el) : undefined)
