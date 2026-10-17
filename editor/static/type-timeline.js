// Timelines: sections, periods and their events (`period : event : event`, a line `: event`
// adds to the period before); the drawing's boxes in source order.

// Every box the drawing makes, in order: sections, periods, each event.
import { t } from './i18n.js'

function items(lines) {
  const out = []
  lines.forEach((l, i) => {
    const t = l.trim()
    if (!t || /^(timeline|title|accTitle|accDescr)\b/i.test(t)) return
    if (/^section\b/i.test(t)) return out.push({ key: `box:${out.length}`, line: i + 1 })
    const parts = t.split(/:(?=\s)|:$/)
    if (parts[0].trim()) out.push({ key: `box:${out.length}`, line: i + 1 })
    for (const e of parts.slice(1)) if (e.trim()) out.push({ key: `box:${out.length}`, line: i + 1 })
  })
  return out
}

export default {
  id: 'timeline',
  name: 'Timeline',
  header: /^timeline\b/i,
  looks: ['neo'],
  lexer: { keywords: ['title', 'section', 'LR', 'TD', 'accTitle', 'accDescr'], caseInsensitive: true, colon: 'before' },
  blocks: { sections: /^section\b/i },
  indent: 'depth',
  items,
  check(ctx) {
    // An event line (`: event`) before any period crashes the drawing.
    for (const [i, l] of ctx.lines.entries()) {
      const text = l.trim()
      if (!text || /^(timeline|title|section|accTitle|accDescr)\b/i.test(text)) continue
      if (text.startsWith(':'))
        return [
          {
            line: i + 1,
            severity: 'error',
            rule: 'event-first',
            message: t('An event needs a time period before it (e.g. 2024 : event)'),
          },
        ]
      break
    }
    return []
  },
  snippets: [
    [t('section'), t('section ${1:name}')],
    [t('time period : event'), t('${1:2024} : ${2:event}')],
  ],
  starter: t(
    'timeline\n\ttitle ${1:History}\n\tsection ${2:Early days}\n\t\t${3:2002} : ${4:event}\n\t\t${5:2004} : ${6:event} : ${7:event}',
  ),
  link: { kinds: [{ selector: 'g.timeline-node', key: rec => `box:${rec.nth}` }] },
}
