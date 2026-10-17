// Railroad diagrams, in four grammar notations (railroad-beta, -ebnf-, -abnf-, -peg-): rules
// `name = ... ;` (`::=`, `<-`), references to other rules in their bodies; the drawing's rules
// in order and the rule a nonterminal box names.

import { t } from './i18n.js'
import { duplicates, lexer, symbolList } from './type-core.js'

const ABNF_CORE = new Set([
  'ALPHA',
  'BIT',
  'CHAR',
  'CR',
  'CRLF',
  'CTL',
  'DIGIT',
  'DQUOTE',
  'HEXDIG',
  'HTAB',
  'LF',
  'LWSP',
  'OCTET',
  'SP',
  'VCHAR',
  'WSP',
])
const IR_WORDS = ['sequence', 'choice', 'optional', 'oneOrMore', 'zeroOrMore', 'terminal', 'nonterminal', 'special']

// One notation: its header, how a rule starts, names, comments and what is not a name.
function railroad({
  id,
  name,
  header,
  assign,
  ident,
  comment,
  words = [],
  strings = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
  starter,
  snippets,
  core = new Set(),
}) {
  const RULE = new RegExp(`^\\s*(${ident})\\s*(?:${assign})`)
  // The lines with strings, special sequences and comments blanked (`(* ... *)` and `/* ... */`
  // may span lines). Same lengths.
  const blank = s => s.replace(/[^\n]/g, ' ')
  const bareLines = lines =>
    lines
      .map(l => l.replace(strings, blank))
      .join('\n')
      .replace(comment, blank)
      .split('\n')

  function symbols(lines) {
    const out = symbolList()
    const bare = bareLines(lines)
    lines.forEach((l, i) => {
      const n = i + 1
      if (header.test(l.trim()) || /^\s*(title|accTitle|accDescr)\b/.test(l)) return
      const line = bare[i]
      const def = RULE.exec(line)
      const from = def ? def[0].length : 0
      if (def) {
        const start = line.indexOf(def[1]) + 1
        out.add({ name: def[1], start, end: start + def[1].length }, n, true)
      }
      for (const m of line.slice(from).matchAll(new RegExp(`(?<![\\w-])(${ident})(?![\\w-]|\\s*\\()`, 'g'))) {
        if (words.includes(m[1])) continue
        out.add({ name: m[1], start: from + m.index + 1, end: from + m.index + 1 + m[1].length }, n)
      }
      // railroad-beta names its references as strings: nonterminal("x") (not in a comment).
      for (const m of l.matchAll(/nonterminal\(\s*"([^"]*)"/g)) {
        if (!line.startsWith('nonterminal', m.index)) continue
        const start = m.index + m[0].length - m[1].length + 1
        out.add({ name: m[1], start, end: start + m[1].length }, n)
      }
    })
    return out.list
  }

  function items(lines) {
    const out = []
    bareLines(lines).forEach((l, i) => {
      if (!header.test(lines[i].trim()) && RULE.test(l)) out.push({ key: `rule:${out.length}`, line: i + 1 })
    })
    return out
  }

  const LEXER = {
    keywords: [...words, 'title', 'accTitle', 'accDescr'],
    arrows: new RegExp(`^(?:${assign}|[|/*+?!&])`),
    comment: new RegExp(`^(?:${comment.source})`),
    id: new RegExp(`^${ident}`),
  }
  return {
    id,
    name,
    header,
    lexer: LEXER,
    tokenize: lexer(LEXER),
    indent: id === 'railroadAbnf' ? 'none' : 'keep',
    symbols,
    items,
    idPattern: new RegExp(`^${ident}$`),
    check(ctx) {
      const findings = duplicates(ctx.symbols, (n, line) =>
        t('Rule {name} is already defined on line {line}', { name: n, line }),
      )
      const defined = new Set(ctx.symbols.filter(s => s.def).map(s => s.name))
      for (const s of ctx.symbols) {
        if (!s.def && !defined.has(s.name) && !core.has(s.name))
          findings.push({
            line: s.line,
            severity: 'warning',
            rule: 'undefined',
            message: t('Rule {name} is not defined', { name: s.name }),
          })
      }
      return findings
    },
    snippets,
    starter,
    link: {
      kinds: [
        { selector: 'g.railroad-rule', key: rec => `rule:${rec.nth}` },
        {
          selector: 'g.railroad-nonterminal',
          key: (rec, ctx) => (ctx.model.names.includes(rec.text) ? `node:${rec.text}` : undefined),
        },
      ],
    },
  }
}

export const ir = railroad({
  id: 'railroad',
  name: 'Railroad',
  header: /^railroad-beta\b/i,
  assign: '=',
  ident: '[A-Za-z_][\\w-]*',
  comment: /\/\*[\s\S]*?\*\//g,
  words: IR_WORDS,
  snippets: [[t('rule'), '${1:name} = sequence(${2:terminal("x")});']],
  starter: 'railroad-beta\n${1:digits} = oneOrMore(nonterminal("${2:digit}"));\n${2:digit} = special("0-9");',
})
export const ebnf = railroad({
  id: 'railroadEbnf',
  name: 'Railroad (EBNF)',
  header: /^railroad-ebnf-beta\b/i,
  assign: '::=|=',
  ident: '[A-Za-z_][\\w-]*',
  comment: /\(\*[\s\S]*?\*\)|\/\*[\s\S]*?\*\//g,
  strings: /"[^"]*"|'[^']*'|\?[^?\n]*\?/g,
  snippets: [[t('rule'), '${1:name} = ${2:term} ;']],
  starter: 'railroad-ebnf-beta\n${1:expr} = ${2:term} { "+" ${2:term} } ;\n${2:term} = "x" ;',
})
export const abnf = railroad({
  id: 'railroadAbnf',
  name: 'Railroad (ABNF)',
  header: /^railroad-abnf-beta\b/i,
  assign: '=',
  ident: '[A-Za-z][A-Za-z0-9-]*',
  comment: /;(?=.).*$/gm,
  strings: /"[^"]*"|%[xXdDbB][0-9A-Fa-f.-]+/g,
  core: ABNF_CORE,
  snippets: [[t('rule'), '${1:name} = ${2:ALPHA} ;']],
  starter: 'railroad-abnf-beta\n${1:word} = 1*${2:letter} ;\n${2:letter} = ALPHA ;',
})
export const peg = railroad({
  id: 'railroadPeg',
  name: 'Railroad (PEG)',
  header: /^railroad-peg-beta\b/i,
  assign: '<-',
  ident: '[A-Za-z_][\\w]*',
  comment: /#.*$/gm,
  snippets: [[t('rule'), '${1:Name} <- ${2:Other} ;']],
  starter: 'railroad-peg-beta\n${1:Num} <- ${2:Digit}+ ;\n${2:Digit} <- "0" / "1" ;',
})

export default [ir, ebnf, abnf, peg]
