// Architecture diagrams: groups, services and junctions (one namespace; `in` nests), edges
// `a:R -- L:b`, `align`; the drawing's services "service-<id>", junctions "node-<id>",
// groups "group-<id>" and edges "L_<a>_<b>_<n>".

import { t } from './i18n.js'
import { duplicates, scan, symbolList } from './type-core.js'

const ID = '[\\w](?:[-\\w]*\\w)?'
const EDGE = new RegExp(
  `^\\s*(${ID})(?:\\{group\\})?\\s*:\\s*[LRTB]\\s*<?-(?:-|\\[[^\\]\\n]*\\]-)>?\\s*[LRTB]\\s*:\\s*(${ID})`,
)

function symbols(lines) {
  const out = symbolList()
  lines.forEach((l, i) => {
    const n = i + 1
    let m
    if ((m = scan(l, new RegExp(`^\\s*(?:group|service|junction)\\s+(${ID})`))).length) {
      out.add(m[0], n, true, /^\s*group/.test(l) ? 'group' : 'node')
      for (const h of scan(l, new RegExp(`\\bin\\s+(${ID})\\s*$`))) out.add(h, n)
      return
    }
    if (EDGE.test(l)) return [1, 2].forEach(g => scan(l, EDGE, g).forEach(h => out.add(h, n)))
    if (/^\s*align\s+(row|column)\b/.test(l)) {
      const at = l.indexOf(/align\s+(row|column)/.exec(l)[0]) + /align\s+(row|column)/.exec(l)[0].length
      for (const h of scan(l.slice(at), new RegExp(`(${ID})`)))
        out.add({ name: h.name, start: h.start + at, end: h.end + at }, n)
    }
  })
  return out.list
}

function items(lines) {
  const out = []
  lines.forEach((l, i) => {
    const m = EDGE.exec(l)
    if (m) out.push({ key: `edge:${out.length}`, line: i + 1, from: m[1], to: m[2] })
  })
  return out
}

export default {
  id: 'architecture',
  name: 'Architecture',
  header: /^architecture(-beta)?\b/,
  lexer: {
    keywords: ['group', 'service', 'junction', 'in', 'align', 'row', 'column', 'title', 'accTitle', 'accDescr'],
    arrows: /^(?:<?-\[[^\]\n]*\]->?|<?-->?|\{group\})/,
  },
  indent: 'depth',
  symbols,
  items,
  idPattern: /^[\w](?:[-\w]*\w)?$/,
  idHint: t('An ID may only use letters, digits, _ and - (not first or last)'),
  check(ctx) {
    const findings = duplicates(ctx.symbols, (name, line) =>
      t('Id {name} is already used on line {line}', { name, line }),
    )
    const declaredAt = new Map()
    for (const s of ctx.symbols)
      if (s.def && !declaredAt.has(s.name)) declaredAt.set(s.name, { line: s.line, kind: s.kind })
    for (const s of ctx.symbols) {
      if (s.def) continue
      const d = declaredAt.get(s.name)
      const inRef =
        /\bin\s+\S+\s*$/.test(ctx.lines[s.line - 1]) && /^\s*(group|service|junction)\b/.test(ctx.lines[s.line - 1])
      // Mermaid adds every group, then every service and junction, then every edge: only a
      // group's parent must come before it.
      const groupIn = inRef && /^\s*group\b/.test(ctx.lines[s.line - 1])
      if (!d)
        findings.push({
          line: s.line,
          severity: 'error',
          rule: 'undeclared',
          message: t('{name} is not declared', { name: s.name }),
        })
      else if (groupIn && d.line > s.line)
        findings.push({
          line: s.line,
          severity: 'error',
          rule: 'declare-later',
          message: t('{name} is declared later, on line {line}: declare it before this line', {
            name: s.name,
            line: d.line,
          }),
        })
      else if (inRef && d.kind !== 'group')
        findings.push({
          line: s.line,
          severity: 'error',
          rule: 'in-group',
          message: t('in must name a group, and {name} is not one', { name: s.name }),
        })
      else if (
        !inRef &&
        d.kind === 'group' &&
        EDGE.test(ctx.lines[s.line - 1]) &&
        !/\{group\}/.test(ctx.lines[s.line - 1])
      ) {
        findings.push({
          line: s.line,
          severity: 'error',
          rule: 'edge-group',
          message: t('An edge must join services or junctions, and {name} is a group', { name: s.name }),
        })
      }
    }
    if (ctx.header && /^\s*architecture\s*$/.test(ctx.lines[ctx.header - 1])) {
      findings.push({
        line: ctx.header,
        severity: 'error',
        rule: 'header',
        message: t('Write the header as architecture-beta'),
        fix: ctx.lines[ctx.header - 1].replace('architecture', 'architecture-beta'),
      })
    }
    return findings
  },
  snippets: [
    [t('group'), t('group ${1:id}(${2|cloud,server,database,disk,internet|})[${3:name}]')],
    [t('service'), t('service ${1:id}(${2|server,database,disk,cloud,internet|})[${3:name}] in ${4:group}')],
    [t('junction'), 'junction ${1:id}'],
    [t('Edge a:R -- L:b'), '${1:a}:${2|R,L,T,B|} -- ${3|L,R,T,B|}:${4:b}'],
  ],
  starter:
    'architecture-beta\n\tgroup ${1:api}(cloud)[${2:API}]\n\tservice ${3:db}(database)[${4:Database}] in ${1:api}\n\tservice ${5:server}(server)[${6:Server}] in ${1:api}\n\t${3:db}:L -- R:${5:server}',
  link: {
    kinds: [
      {
        selector: '.architecture-service, .architecture-junction > rect, rect.node-bkg',
        key: (rec, ctx) => nodeKey(rec.id, ctx),
      },
      { selector: 'g.architecture-edges path', key: (rec, ctx) => edgeKey(rec.id, ctx) },
    ],
  },
}

const nodeKey = (id, ctx) => {
  const m = /^(?:service|node|group)-(.+)$/.exec(id)
  return m && ctx.model.names.includes(m[1]) ? `node:${m[1]}` : undefined
}
const edgeKey = (id, ctx) => {
  const m = /^L_(.+)_\d+$/.exec(id)
  return m ? ctx.model.items.find(it => `${it.from}_${it.to}` === m[1])?.key : undefined
}
