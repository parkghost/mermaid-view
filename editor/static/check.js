// A diagram's check as an agent reads it, from the findings the cards show (Mermaid's parser,
// then the editor's lint for the source's type): valid or not, the type, what checked it, and
// errors and warnings with their lines. The same report for WebMCP's tools (webmcp.js) and for
// the MCP server's checks, which a page runs when asked (app.js, the event `check`).

import { typeOf } from './types.js'

export const MERMAID_VERSION = '12.1.0'

// Mermaid 12.1.0's preprocessing (preprocess.ts): what its parsers read of a source.
const DIRECTIVE = /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi
const COMMENT_LINE = /^\s*%%(?!{)[^\n]+\n?/gm

/**
 * The source's line of a line Mermaid's parser names in an error: it parses the source without
 * its front matter, its %%{...}%% directives and %% comment lines, trimmed at the start, so its
 * line n is a later line of the source when any of those come before.
 */
export function sourceLine(source, parsed) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let from = 0
  if (/^[^\S\n]*---\s*$/.test(lines[0] ?? '')) {
    const close = lines.findIndex((l, k) => k > 0 && /^[^\S\n]*---\s*$/.test(l))
    if (close > 0) for (from = close + 1; from < lines.length && !lines[from].trim(); from++);
  }
  const read = lines.slice(from).join('\n').replace(DIRECTIVE, '').replace(COMMENT_LINE, '').trimStart().split('\n')
  // Each line read is a line of the source, in order: the next one that reads the same.
  let k = from
  for (let n = 0; n < read.length && k < lines.length; n++, k++) {
    const want = read[n].trim()
    while (k < lines.length && lines[k].replace(DIRECTIVE, '').trim() !== want) k++
    if (n === parsed - 1) return k < lines.length ? k + 1 : parsed
  }
  return parsed
}

const plain = f => ({ line: f.line, severity: f.severity, rule: f.rule, message: f.message })

/**
 * The report on a source from its findings. expected: the type id the caller meant ('' for
 * any); a source of another type gets a warning (it may still be a valid diagram).
 */
export function checkReport(source, findings, expected = '') {
  const desc = typeOf(source)
  const all = findings.map(plain)
  if (expected && desc.id !== expected) {
    const what = desc.id ? `of type ${desc.id} (${desc.name})` : 'of no diagram type Mermaid knows'
    all.unshift({
      line: 1,
      severity: 'warning',
      rule: 'type-mismatch',
      message: `The source is ${what}, not ${expected}.`,
    })
  }
  const errors = all.filter(f => f.severity === 'error')
  return {
    checked: true,
    ok: errors.length === 0,
    type: desc.id || null,
    typeName: desc.id ? desc.name : null,
    checker: `Mermaid ${MERMAID_VERSION} parser with the editor's config, and mermaid-view lint (${desc.id ? desc.name : 'balanced blocks only'})`,
    errors,
    warnings: all.filter(f => f.severity !== 'error'),
  }
}
