// Requirement diagrams: requirement and element names (declared by their `{ }` blocks),
// relations `a - satisfies -> b` / `b <- satisfies - a`; the drawing's nodes (id: the name) and
// relations "<src>-<dst>-<k>" (k counts from 0).

import { t } from './i18n.js'
import { duplicates, mask, NODE, scan, scanList, symbolList, undeclared } from './type-core.js'

const KINDS =
  'requirement|functionalRequirement|interfaceRequirement|performanceRequirement|physicalRequirement|designConstraint|element'
const NAME = '[\\w][\\w.]*'
const TYPES = 'contains|copies|derives|satisfies|verifies|refines|traces'
const FORWARD = new RegExp(`^\\s*(${NAME})\\s*-\\s*(?:${TYPES})\\s*->\\s*(${NAME})`, 'i')
const BACKWARD = new RegExp(`^\\s*(${NAME})\\s*<-\\s*(?:${TYPES})\\s*-\\s*(${NAME})`, 'i')

// Lines as scanned: quotes and comments (%% and #) blanked, block bodies dropped.
function readLines(lines) {
  let body = false
  return lines.map(raw => {
    const m = mask(raw, -1, '#')
    if (body) {
      if (m.trim() === '}') body = false
      return ''
    }
    if (/\{\s*$/.test(m)) body = true
    return m
  })
}

function symbols(lines) {
  const out = symbolList()
  readLines(lines).forEach((line, i) => {
    const n = i + 1
    let m
    if ((m = scan(line, new RegExp(`^\\s*(?:${KINDS})\\s+(${NAME})`, 'i'))).length) return out.add(m[0], n, true)
    for (const re of [FORWARD, BACKWARD]) {
      if (re.test(line)) {
        for (const g of [1, 2]) for (const h of scan(line, re, g)) out.add(h, n)
        return
      }
    }
    if (/^\s*(class|style)\s/.test(line)) {
      for (const h of scanList(line, /^\s*(?:class|style)\s+(\S+)/)) out.add(h, n)
      return
    }
    if ((m = scan(line, new RegExp(`^\\s*(${NAME})\\s*:::`))).length) out.add(m[0], n)
  })
  return out.list
}

function items(lines) {
  const out = []
  let k = 0
  readLines(lines).forEach((line, i) => {
    if (FORWARD.test(line) || BACKWARD.test(line)) out.push({ key: `rel:${k++}`, line: i + 1 })
  })
  return out
}

export default {
  id: 'requirement',
  name: 'Requirement',
  header: /^requirement(Diagram)?\b/,
  looks: ['neo', 'handDrawn'],
  layouts: ['elk'],
  lexer: {
    keywords: [
      ...KINDS.split('|'),
      'id',
      'text',
      'risk',
      'verifyMethod',
      'type',
      'docref',
      'low',
      'medium',
      'high',
      'analysis',
      'demonstration',
      'inspection',
      'test',
      ...TYPES.split('|'),
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
    ],
    caseInsensitive: true,
    arrows: /^(?:<-|->)/,
  },
  blocks: { braces: true },
  indent: 'depth',
  symbols,
  items,
  idPattern: /^\w[\w.]*$/,
  idHint: t('A name may only use letters, digits, _ and .'),
  check(ctx) {
    const findings = [
      ...duplicates(ctx.symbols, (name, line) =>
        t('{name} is already declared on line {line}: this one is ignored', { name, line }),
      ),
      ...undeclared(ctx.symbols, name => t('{name} is not declared (as a requirement or element)', { name })),
    ]
    // `title` is not part of this grammar (use front matter); `}` must stand on its own line.
    ctx.lines.forEach((l, i) => {
      if (/^\s*title\b/.test(l))
        findings.push({
          line: i + 1,
          severity: 'error',
          rule: 'no-title',
          message: t('Requirement diagrams do not support title: use title: in front matter'),
        })
      if (/\S\s*\}\s*$/.test(mask(l)) && !/\{/.test(mask(l)))
        findings.push({ line: i + 1, severity: 'error', rule: 'brace-line', message: t('Put } on its own line') })
    })
    return findings
  },
  snippets: [
    [
      t('requirement { }'),
      t(
        'requirement ${1:name} {\n\tid: ${2:1}\n\ttext: "${3:description}"\n\trisk: ${4|low,medium,high|}\n\tverifymethod: ${5|analysis,inspection,test,demonstration|}\n}',
      ),
    ],
    [t('element { }'), 'element ${1:name} {\n\ttype: ${2:simulation}\n}'],
    [
      t('relation - satisfies ->'),
      '${1:element} - ${2|satisfies,verifies,derives,refines,traces,contains,copies|} -> ${3:requirement}',
    ],
  ],
  starter: t(
    'requirementDiagram\n\trequirement ${1:req} {\n\t\tid: 1\n\t\ttext: "${2:description}"\n\t\trisk: high\n\t\tverifymethod: test\n\t}\n\telement ${3:entity} {\n\t\ttype: ${4:simulation}\n\t}\n\t${3:entity} - satisfies -> ${1:req}',
  ),
  link: {
    kinds: [
      { selector: NODE, key: (rec, ctx) => (ctx.model.names.includes(rec.id) ? `node:${rec.id}` : undefined) },
      {
        selector: '[data-id]',
        key: rec => (/-(\d+)$/.exec(rec.dataId) ? `rel:${/-(\d+)$/.exec(rec.dataId)[1]}` : undefined),
      },
    ],
    resolve: target => target.closest('.edgeLabel')?.querySelector('[data-id]'),
  },
}
