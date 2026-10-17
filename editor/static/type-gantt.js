// Gantt charts: sections, tasks (`name : [tags,] [id,] [start,] end`), task ids (declared as the
// first of three data fields, used by `after`, `until` and `click`); the drawing's task bars and
// their texts (id: the task's id, or "task<n>" counting the tasks without one).

import { t } from './i18n.js'
import { colonAt, duplicates, scan, scanList, symbolList, undeclared } from './type-core.js'

const TAGS = new Set(['active', 'done', 'crit', 'milestone', 'vert'])
const SETTINGS =
  /^(gantt|dateFormat|axisFormat|tickInterval|includes|excludes|todayMarker|inclusiveEndDates|topAxis|weekday|weekend|title|section|accTitle|accDescr|accDescription|click|displayMode)\b/

// A task line's data fields after its ':' with their 0-based columns.
function fields(raw) {
  const c = colonAt(raw)
  if (c < 0 || SETTINGS.test(raw.trim())) return undefined
  const out = []
  let col = c + 1
  for (const part of raw.slice(c + 1).split(',')) {
    const lead = part.length - part.trimStart().length
    out.push({ text: part.trim(), col: col + lead })
    col += part.length + 1
  }
  while (out.length && TAGS.has(out[0].text)) out.shift()
  return out
}

function symbols(lines) {
  const out = symbolList()
  lines.forEach((raw, i) => {
    const n = i + 1
    if (/^\s*click\s/.test(raw)) return scanList(raw, /^\s*click\s+(\S+)/).forEach(h => out.add(h, n))
    const f = fields(raw)
    if (!f) return
    if (f.length === 3 && f[0].text)
      out.add({ name: f[0].text, start: f[0].col + 1, end: f[0].col + 1 + f[0].text.length }, n, true)
    // `after a b`, `until a`: each id, its columns found in the field.
    for (const x of f) {
      if (!/^(after|until)\s/.test(x.text)) continue
      for (const h of scan(x.text, /(?<=\s)([\w-]+)/))
        out.add({ name: h.name, start: x.col + h.start, end: x.col + h.end }, n)
    }
  })
  return out.list
}

// The tasks, in order, keyed by the id the drawing gives their bars.
function items(lines) {
  const out = []
  let generated = 0
  lines.forEach((raw, i) => {
    const f = fields(raw)
    if (!f || !raw.slice(0, colonAt(raw)).trim()) return
    const id = f.length === 3 && f[0].text ? f[0].text : `task${++generated}`
    out.push({ key: `task:${id}`, line: i + 1 })
  })
  return out
}

export default {
  id: 'gantt',
  name: 'Gantt',
  header: /^gantt\b/,
  lexer: {
    keywords: [
      'dateFormat',
      'axisFormat',
      'tickInterval',
      'includes',
      'excludes',
      'todayMarker',
      'inclusiveEndDates',
      'topAxis',
      'weekday',
      'weekend',
      'title',
      'section',
      'click',
      'href',
      'call',
      'after',
      'until',
      'active',
      'done',
      'crit',
      'milestone',
      'vert',
      'accTitle',
      'accDescr',
      'accDescription',
      'weekends',
    ],
    caseInsensitive: true,
    colon: 'before',
    numbers: true,
    id: /^[A-Za-z_][\w-]*/,
  },
  blocks: { sections: /^section\b/i },
  indent: 'depth',
  symbols,
  items,
  idPattern: /^[A-Za-z_][\w-]*$/,
  idHint: t('A task ID may only use letters, digits, _ and -'),
  check: ctx => [
    ...duplicates(ctx.symbols, (name, line) =>
      t('Task id {name} is already used on line {line}: the earlier task is replaced', { name, line }),
    ),
    ...undeclared(ctx.symbols, name =>
      t('No task has the id {name} (after, until and click cannot find it)', { name }),
    ),
  ],
  snippets: [
    [t('section'), t('section ${1:name}')],
    [t('task'), t('${1:task} :${2:id}, ${3:2024-01-01}, ${4:3d}')],
    [t('Following task after'), t('${1:task} :${2:id}, after ${3:previous}, ${4:2d}')],
    [t('milestone'), t('${1:milestone} :milestone, ${2:id}, after ${3:previous}, 0d')],
  ],
  starter: t(
    'gantt\n\ttitle ${1:Plan}\n\tdateFormat YYYY-MM-DD\n\tsection ${2:Prepare}\n\t\t${3:Design} :des, 2024-01-01, 3d\n\t\t${4:Implement} :impl, after des, 5d',
  ),
  link: {
    kinds: [{ selector: 'rect.task, text.taskText', key: rec => `task:${rec.id.replace(/-text$/, '')}` }],
  },
}
