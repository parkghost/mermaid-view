// User journeys: sections and tasks (`name: score: actor, actor`); the drawing's tasks (a group
// each, in order) and sections.

import { t } from './i18n.js'
import { colonAt } from './type-core.js'

const isTask = l => colonAt(l) > 0 && !/^\s*(title|section|accTitle|accDescr)\b/.test(l)

function items(lines) {
  const out = []
  let task = 0
  let section = 0
  lines.forEach((l, i) => {
    if (/^\s*section\b/.test(l)) out.push({ key: `section:${section++}`, line: i + 1 })
    else if (isTask(l)) out.push({ key: `task:${task++}`, line: i + 1 })
  })
  return out
}

export default {
  id: 'journey',
  name: 'User journey',
  header: /^journey\b/,
  lexer: {
    keywords: ['title', 'section', 'accTitle', 'accDescr'],
    caseInsensitive: true,
    colon: 'before',
    numbers: true,
  },
  blocks: { sections: /^section\b/i },
  indent: 'depth',
  items,
  check(ctx) {
    const findings = []
    ctx.lines.forEach((l, i) => {
      if (!isTask(l)) return
      const score = l
        .slice(colonAt(l) + 1)
        .split(':')[0]
        .trim()
      if (!/^\d+(\.\d+)?$/.test(score))
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'score',
          message: t('Score "{score}" is not a number', { score }),
        })
      if (/#/.test(l))
        findings.push({
          line: i + 1,
          severity: 'warning',
          rule: 'text-cut',
          message: t('Everything after # is read as a comment'),
        })
    })
    return findings
  },
  snippets: [
    [t('section'), t('section ${1:name}')],
    [t('task'), t('${1:task}: ${2|1,2,3,4,5|}: ${3:Me}')],
  ],
  starter: t(
    'journey\n\ttitle ${1:My day}\n\tsection ${2:Go to work}\n\t\t${3:Make tea}: 5: Me\n\t\t${4:Go upstairs}: 3: Me',
  ),
  link: {
    kinds: [
      // Each task is drawn in a group of its own (its line, face, box, actors, text).
      { selector: 'g:has(> rect.task)', key: rec => `task:${rec.nth}` },
      { selector: 'g:has(> rect.journey-section):not(:has(rect.task))', key: rec => `section:${rec.nth}` },
      { selector: 'rect.journey-section, text.journey-section', key: rec => `section:${Math.floor(rec.nth / 2)}` },
    ],
  },
}
