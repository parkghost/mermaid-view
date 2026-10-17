// Event models: time frames (`tf 01 ui Name`, `rf 02 ...`), data blocks, references `->> 03`
// and `[[Data]]`; the drawing's boxes, one for each frame in order.

import { t } from './i18n.js'
import { duplicates, scan, symbolList, undeclared } from './type-core.js'

const FRAME = /^\s*(tf|timeframe|rf|resetframe)\s+(\d{1,3})\b/

function symbols(lines) {
  const out = symbolList()
  lines.forEach((l, i) => {
    const n = i + 1
    const masked = l.replace(/\{.*\}|"[^"]*"|'[^']*'/g, s => ' '.repeat(s.length))
    let m
    if ((m = scan(masked, /^\s*data\s+([_a-zA-Z]\w*)/)).length) out.add(m[0], n, true, 'data')
    for (const h of scan(masked, /\[\[\s*([_a-zA-Z]\w*)\s*\]\]/)) out.add(h, n, false, 'data')
    if ((m = scan(masked, /^\s*(?:tf|timeframe|rf|resetframe)\s+\d+\s+\w+\s+([_a-zA-Z][\w.]*)/)).length)
      out.add(m[0], n, true, 'entity')
  })
  return out.list
}

function items(lines) {
  const out = []
  lines.forEach((l, i) => {
    if (FRAME.test(l)) out.push({ key: `frame:${out.length}`, line: i + 1 })
  })
  return out
}

export default {
  id: 'eventmodeling',
  name: 'Event modeling',
  header: /^eventmodeling\b/,
  lexer: {
    keywords: [
      'tf',
      'timeframe',
      'rf',
      'resetframe',
      'entity',
      'data',
      'note',
      'gwt',
      'given',
      'when',
      'then',
      'rmo',
      'readmodel',
      'ui',
      'cmd',
      'command',
      'evt',
      'event',
      'pcr',
      'processor',
    ],
    arrows: /^(?:->>|\[\[|\]\])/,
    numbers: true,
  },
  indent: 'keep',
  symbols,
  items,
  idPattern: /^[_a-zA-Z]\w*$/,
  check: ctx => [
    ...duplicates(ctx.symbols, (name, line) => t('{name} is already declared on line {line}', { name, line }), 'data'),
    ...undeclared(ctx.symbols, name => t('No data {name} is declared', { name }), 'data'),
    ...ctx.lines.flatMap((l, i) =>
      /^\s*(title|accTitle|accDescr)\b/.test(l)
        ? [
            {
              line: i + 1,
              severity: 'error',
              rule: 'no-title',
              message: t('eventmodeling does not support title or accTitle: use title: in front matter'),
            },
          ]
        : [],
    ),
  ],
  snippets: [
    [t('Time frame tf'), 'tf ${1:01} ${2|ui,cmd,evt,rmo,pcr|} ${3:Name}'],
    [t('data'), 'data ${1:Name} {\n\t$0\n}'],
  ],
  starter: 'eventmodeling\ntf 01 ui ${1:Screen}\ntf 02 cmd ${2:DoThing}\ntf 03 evt ${3:ThingDone}',
  link: { kinds: [{ selector: 'g.em-box', key: rec => `frame:${rec.nth}` }] },
}
