// Use case diagrams: actors, use cases (`Id(label)`, `Id[label]`), system boundaries
// (`systemBoundary ... end`), relations; the drawing's elements "usecase-<id>", boundaries,
// relations "edge-<k>" in order and notes "note-<k>".

import { t } from './i18n.js'
import { duplicates, NODE, scan, scanList, symbolList } from './type-core.js'

const ID = '\\w+'
const ARROW = '(?:--\\|>|\\.\\.>|<--+|--+>|--o|o--|--x|x--|--+)'

// Lines as scanned: quotes, labels in brackets and `@{ }` metadata blanked.
const bare = l => l.replace(/"[^"]*"|'[^']*'|\([^)]*\)|\[[^\]]*\]|@\{[^}]*\}|<<[^>]*>>/g, s => ' '.repeat(s.length))

// A relation's id, written before its arrow: `A pays@..> B`.
const EDGE_ID = new RegExp(`(?<![\\w@])(${ID})@(?=[-.<ox])`)

function symbols(lines) {
  const out = symbolList()
  const edges = new Set(lines.flatMap(l => scan(bare(l), EDGE_ID).map(h => h.name)))
  lines.forEach((l, i) => {
    const n = i + 1
    const line = bare(l)
    let m
    if ((m = scan(line, new RegExp(`^\\s*(?:actor|systemBoundary|json)\\s+(${ID})`))).length)
      return out.add(m[0], n, true)
    if ((m = scan(line, new RegExp(`^\\s*note\\s+for\\s+(${ID})`))).length) return out.add(m[0], n)
    if (/^\s*(class|style)\s/.test(line))
      return scanList(line, /^\s*(?:class|style)\s+(\S+)/).forEach(h => out.add(h, n))
    if (/^\s*(direction|classDef|end|accTitle|accDescr)\b/.test(line)) return
    const rel = /[\s@](--|\.\.|<--|o--|x--)/.test(` ${l}`) ? relationEnds(l) : undefined
    if (rel) {
      scan(line, EDGE_ID).forEach(h => out.add(h, n, true))
      return rel.forEach(h => out.add(h, n))
    }
    // A use case declared on its own: Id(label), Id[label], Id@{...}; or a relation's metadata.
    if ((m = scan(l, new RegExp(`^\\s*(${ID})\\s*[([@]`))).length) out.add(m[0], n, !edges.has(m[0].name))
  })
  return out.list
}

// The two ends of a relation line (labels and keywords in between are not names).
function relationEnds(l) {
  const line = bare(l)
  const first = scan(line, new RegExp(`^\\s*(${ID})`))[0]
  const last = scan(line, new RegExp(`(${ID})\\s*$`))[0]
  return first && last && first.start !== last.start ? [first, last] : undefined
}

function items(lines) {
  const out = []
  let note = 0
  lines.forEach((l, i) => {
    if (/^\s*note\s+for\b/.test(l)) out.push({ key: `note:${note++}`, line: i + 1, aside: true })
    else if (
      !/^\s*(actor|systemBoundary|json|class|style|classDef|direction|end)\b/.test(l) &&
      /[\s@](--|\.\.|<--)/.test(` ${l}`) &&
      relationEnds(l)
    )
      out.push({ key: `rel:${out.filter(x => x.key.startsWith('rel:')).length}`, line: i + 1 })
  })
  return out
}

export default {
  id: 'usecase',
  name: 'Use case',
  header: /^usecase-beta\b/,
  looks: ['neo', 'handDrawn'],
  layouts: ['elk'],
  lexer: {
    keywords: [
      'actor',
      'systemBoundary',
      'end',
      'direction',
      'TD',
      'TB',
      'BT',
      'LR',
      'RL',
      'note',
      'for',
      'json',
      'classDef',
      'class',
      'style',
      'include',
      'extend',
      'true',
      'false',
      'accTitle',
      'accDescr',
    ],
    arrows: new RegExp(`^${ARROW}`),
    id: /^\w+/,
  },
  blocks: { open: /^systemBoundary\b/, close: /^end\b/ },
  indent: 'depth',
  symbols,
  items,
  idPattern: /^\w+$/,
  idHint: t('An ID may only use letters, digits and _'),
  check(ctx) {
    const findings = duplicates(ctx.symbols, (name, line) =>
      t('{name} is already declared on line {line}', { name, line }),
    )
    // Declared, or an end of a relation (which declares it); a note, class or style line declares nothing.
    const refers = l => /^\s*(note|class|style)\b/.test(l)
    const known = new Set(
      ctx.symbols
        .filter(s => s.def || (!refers(ctx.lines[s.line - 1] ?? '') && relationEnds(ctx.lines[s.line - 1] ?? '')))
        .map(s => s.name),
    )
    for (const s of ctx.symbols) {
      const l = ctx.lines[s.line - 1]
      if (refers(l) && !known.has(s.name))
        findings.push({
          line: s.line,
          severity: 'error',
          rule: 'undeclared',
          message: t('{name} is not declared', { name: s.name }),
        })
    }
    ctx.lines.forEach((l, i) => {
      if (/^\s*title\b/.test(l))
        findings.push({
          line: i + 1,
          severity: 'error',
          rule: 'no-title',
          message: t('Use case diagrams do not support title: use title: in front matter'),
        })
    })
    return findings
  },
  snippets: [
    [t('actor'), 'actor ${1:User}'],
    [t('use case (label)'), t('${1:Id}("${2:name}")')],
    [t('systemBoundary'), t('systemBoundary ${1:id}["${2:system}"]\n\t$0\nend')],
    [t('association -->'), '${1:actor} --> ${2:usecase}'],
    [t('include'), '${1:a} ..> : include ${2:b}'],
    [t('note for'), t('note for ${1:Id} "${2:note}"')],
  ],
  starter:
    'usecase-beta\ndirection LR\nactor ${1:Customer}\nsystemBoundary ${2:shop}["${3:Shop}"]\n\t${4:Checkout}("${5:Checkout}")\nend\n${1:Customer} --> ${4:Checkout}',
  link: {
    kinds: [
      {
        selector: `${NODE}, g.cluster`,
        info: el => ({ ucid: el.dataset.usecaseId ?? '' }),
        key: (rec, ctx) => ucKey(rec, ctx),
      },
      {
        selector: '[data-id]',
        key: rec =>
          /^edge-(\d+)$/.test(rec.dataId)
            ? `rel:${rec.dataId.slice(5)}`
            : /^note-(\d+)-edge$/.test(rec.dataId)
              ? `note:${/\d+/.exec(rec.dataId)[0]}`
              : undefined,
      },
    ],
    resolve: target => target.closest('.edgeLabel')?.querySelector('[data-id]'),
  },
}

function ucKey(rec, ctx) {
  const id = rec.ucid || /^usecase-(.+)$/.exec(rec.id)?.[1]
  if (!id) return undefined
  if (/^note-\d+$/.test(id)) return `note:${id.slice(5)}`
  return ctx.model.names.includes(id) ? `node:${id}` : undefined
}
