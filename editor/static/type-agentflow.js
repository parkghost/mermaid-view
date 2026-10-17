// Agent flows: a flowchart fork with `flow ... end` and `global ... end` blocks, connectors and
// agent shapes; the drawing's nodes "agentflow-<id>-<n>", flows (id: the flow's id), edges.

import { t } from './i18n.js'
import { lexer, maskBrackets, NODE } from './type-core.js'
import flowchart, { elementOfDomId, nodeIds } from './type-flowchart.js'

const LEXER = {
  keywords: [
    'flow',
    'global',
    'end',
    'connector',
    'direction',
    'style',
    'linkStyle',
    'classDef',
    'class',
    'click',
    'call',
    'href',
    'default',
    'interpolate',
    'TB',
    'TD',
    'BT',
    'LR',
    'RL',
    'accTitle',
    'accDescr',
    'shape',
    'connectorRef',
  ],
  arrows: /^(?:--+[x>]|-\.+-|--)/,
  labels: true,
}

export default {
  ...flowchart,
  id: 'agentflow',
  name: 'Agent flow',
  header: /^agentflow-beta\b/,
  lexer: LEXER,
  tokenize: lexer(LEXER),
  blocks: { open: /^(flow|global)\b/, close: /^end\b/ },
  formatLine: undefined,
  check: undefined,
  // Node ids, not the words of unquoted labels inside shapes, nor the keyword line.
  symbols: lines =>
    flowchart
      .symbols(
        lines.map(l =>
          /^\s*agentflow-beta\b/.test(l)
            ? ''
            : maskBrackets(l).replace(/(--\s)([^-]+?)(\s--[x>])/g, (_, a, t, b) => a + ' '.repeat(t.length) + b),
        ),
      )
      .filter(s => !['flow', 'global', 'connector', 'shape', 'connectorRef'].includes(s.name)),
  names: undefined,
  snippets: [
    [t('flow … end'), t('flow ${1:id}["${2:name}"]\n\t$0\nend')],
    [t('task'), t('${1:id}["${2:task}"]@{ shape: task }')],
    [t('tool'), t('${1:id}["${2:tool}"]@{ shape: tool }')],
    [t('connector'), 'connector ${1:id}["${2:API}"]'],
    [t('Sequence -->'), '${1:a} --> ${2:b}'],
    [t('Reference -.-'), '${1:a} -.- ${2:b}'],
    [t('Failure --x'), '${1:a} --x ${2:b}'],
  ],
  starter:
    'agentflow-beta LR\n\tflow ${1:agent}["${2:Agent}"]\n\t\t${3:input}["${4:Input}"]@{ shape: input }\n\t\t${5:task}["${6:Task}"]@{ shape: task }\n\t\t${3:input} --> ${5:task}\n\tend',
  link: {
    kinds: [
      {
        selector: NODE,
        key: (rec, ctx) =>
          /^agentflow-(.+)-\d+$/.exec(rec.id) && ctx.model.ids.includes(/^agentflow-(.+)-\d+$/.exec(rec.id)[1])
            ? `node:${/^agentflow-(.+)-\d+$/.exec(rec.id)[1]}`
            : undefined,
      },
      {
        selector: '[data-id], path[id]',
        key: (rec, ctx) => {
          const el = elementOfDomId(rec.dataId || rec.id, ctx.model.ids, ctx.prefix)
          return el?.kind === 'edge' ? `edge:${el.from}>${el.to}` : undefined
        },
      },
      {
        selector: 'g.cluster',
        key: (rec, ctx) => (nodeIds(ctx.model.text).includes(rec.id) ? `node:${rec.id}` : undefined),
      },
    ],
    resolve: target => target.closest('.edgeLabel')?.querySelector('[data-id]'),
  },
}
