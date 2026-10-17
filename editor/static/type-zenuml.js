// ZenUML sequence diagrams (Mermaid's @mermaid-js/mermaid-zenuml, which app.js registers):
// participants (declared on a line of their own, with an annotator or an alias, or met in a
// message), async messages `A->B: text`, sync messages `A.method()` with `{ }` bodies, `new`,
// `return`, and the fragments (if/else, while/for/loop, opt, par, try/catch/finally, critical,
// section, ref, group), all closed by `}`. ZenUML's parser takes any text without an error, so
// the lint looks for what a source written in Mermaid's other sequence syntax would hold.

import { t } from './i18n.js'
import { duplicates, mask, scan, symbolList } from './type-core.js'

const NAME = '[A-Za-z_][\\w]*'
// The words ZenUML reads as its own (its lexer's literal names), not as participants.
const KEYWORDS = [
  'title',
  'if',
  'else',
  'while',
  'for',
  'forEach',
  'foreach',
  'loop',
  'return',
  'new',
  'par',
  'group',
  'opt',
  'critical',
  'section',
  'ref',
  'as',
  'try',
  'catch',
  'finally',
  'in',
  'const',
  'readonly',
  'static',
  'await',
  'true',
  'false',
  'null',
  'nil',
]
const KEYWORD = new RegExp(`^(${KEYWORDS.join('|')})\\b`)

// The line as the scanners read it: no // comment, no quoted text, no message text after an
// async message's ':', nothing inside ( ) (parameters, conditions); same length.
function readable(line) {
  let m = mask(line, -1, '//')
  const arrow = /->[^:]*:/.exec(m)
  if (arrow) m = m.slice(0, arrow.index + arrow[0].length) + ' '.repeat(m.length - arrow.index - arrow[0].length)
  let out = ''
  let depth = 0
  for (const ch of m) {
    if (ch === ')') depth = Math.max(0, depth - 1)
    out += depth ? ' ' : ch
    if (ch === '(') depth++
  }
  return out
}

function symbols(lines) {
  const out = symbolList()
  lines.forEach((raw, i) => {
    const n = i + 1
    const line = readable(raw)
    const t = line.trim()
    if (!t || /^zenuml\b/.test(t) || /^title\b/.test(t)) return
    let m
    // A declaration: `Name`, `@Actor Name`, `<<stereotype>> Name`, `Name as Label`, `Name #color`.
    if (
      (m = scan(line, new RegExp(`^\\s*(?:@\\w+\\s+)?(?:<<[^>]*>>\\s*)?(${NAME})(?:\\s+as\\s+.*)?\\s*(?:#\\w+)?\\s*$`)))
        .length &&
      !KEYWORD.test(m[0].name)
    ) {
      return out.add(m[0], n, true)
    }
    if (/^@(starter)\b/i.test(t)) return // @Starter(A): the parameter is masked
    // `new A` / `new A(...)`: a participant made here.
    for (const h of scan(line, new RegExp(`\\bnew\\s+(${NAME})`))) out.add(h, n)
    // Async messages: `A->B:` (either side), and `A->B.method()` (a sync call from A).
    for (const g of [1, 2])
      for (const h of scan(line, new RegExp(`(?:^|[\\s{};])(${NAME})\\s*--?>\\s*(${NAME})`), g)) out.add(h, n)
    // Sync messages: `B.method`, `x = B.method()`, `Type x = B.method()`, `A->B.method()`.
    for (const h of scan(line, new RegExp(`(?:^|[\\s=>{};])(${NAME})\\s*\\.\\s*\\w`))) {
      if (!out.list.some(s => s.line === n && s.start === h.start)) out.add(h, n)
    }
  })
  return out.list.filter(s => !KEYWORD.test(s.name))
}

export default {
  id: 'zenuml',
  name: 'ZenUML',
  header: /^zenuml\b/,
  lexer: {
    keywords: KEYWORDS,
    arrows: /^(?:-->|->)/,
    comment: /^\/\/.*/,
    id: /^@?[A-Za-z_][\w]*/,
    colon: 'text',
    numbers: true,
  },
  blocks: { braces: true, mask: t => t.replace(/\/\/.*$/, m => ' '.repeat(m.length)) },
  indent: 'depth',
  symbols,
  idPattern: new RegExp(`^${NAME}$`),
  idHint: t('A participant name may only use letters, digits and _, and cannot start with a digit'),
  check(ctx) {
    const findings = duplicates(ctx.symbols, (name, line) =>
      t('Participant {name} is already declared on line {line}', { name, line }),
    )
    // @Starter above a declaration with an annotator or an alias: ZenUML then draws little or
    // nothing (it reads the declarations wrong), with no error.
    const starter = ctx.lines.findIndex(l => /^\s*@starter\b/i.test(l))
    if (starter >= 0) {
      const after = ctx.symbols.find(
        s => s.def && s.line > starter + 1 && /^\s*@\w+\s|\sas\s/.test(readable(ctx.lines[s.line - 1])),
      )
      if (after)
        findings.push({
          line: starter + 1,
          severity: 'warning',
          rule: 'starter-order',
          message: t(
            'ZenUML draws little or nothing with @Starter above the declaration on line {line}: move @Starter below the declarations',
            { line: after.line },
          ),
        })
    }
    // Mermaid's other sequence syntax, which ZenUML takes without an error and draws wrong.
    ctx.lines.forEach((raw, i) => {
      const line = readable(raw)
      const text = line.trim()
      const say = (rule, message) => findings.push({ line: i + 1, severity: 'warning', rule, message })
      if (/^(participant|actor)\s/.test(text))
        say(
          'sequence-syntax',
          t('ZenUML declares a participant by its name alone (or @Actor Name), not with {word}', {
            word: text.split(/\s/)[0],
          }),
        )
      else if (/\w\s*--?(?:>>|x|\))\s*[A-Za-z_]/.test(line))
        say(
          'sequence-syntax',
          t('This is a sequenceDiagram arrow: ZenUML writes an async message as A->B: text (or A-->B for a reply)'),
        )
      else if (/^end$/.test(text)) say('sequence-syntax', t('ZenUML closes a block with }, not end'))
      else if (/^(alt|loop|rect|note|activate|deactivate|autonumber|box)\b(?!\s*[({])/i.test(text))
        say(
          'sequence-syntax',
          t('{word} is sequenceDiagram syntax: ZenUML has if/else, while/loop with { }, and // comments for notes', {
            word: text.split(/\s/)[0],
          }),
        )
    })
    return findings
  },
  snippets: [
    [t('async message A->B: text'), t('${1:A}->${2:B}: ${3:message}')],
    [t('sync call A.method() { }'), '${1:B}.${2:method}(${3}) {\n\t${0}\n}'],
    [t('return'), 'return ${1:result}'],
    [t('new'), 'new ${1:A}(${2})'],
    [
      t('participant @Actor'),
      '@${1|Actor,Boundary,Control,Database,Entity,EC2,Lambda,AzureFunction,S3,SQS,SNS|} ${2:Name}',
    ],
    [t('if / else'), 'if(${1:condition}) {\n\t${2}\n} else {\n\t${0}\n}'],
    [t('while'), 'while(${1:condition}) {\n\t${0}\n}'],
    [t('opt { }'), 'opt {\n\t${0}\n}'],
    [t('par'), 'par {\n\t${0}\n}'],
    [t('try / catch'), 'try {\n\t${1}\n} catch {\n\t${2}\n} finally {\n\t${0}\n}'],
  ],
  starter: t(
    'zenuml\n\ttitle ${1:Title}\n\t@Actor ${2:Alice}\n\t${3:Service}\n\t${2:Alice}->${3:Service}: ${4:request}\n\t${3:Service}.${5:handle}() {\n\t\treturn ${6:ok}\n\t}',
  ),
}
