// Swimlanes: a flowchart whose top-level subgraphs are lanes. Same source and drawing as a
// flowchart (ids, edges, subgraphs), without the flowchart house-style lint.

import { t } from './i18n.js'
import { maskBrackets } from './type-core.js'
import flowchart from './type-flowchart.js'

export default {
  ...flowchart,
  id: 'swimlane',
  name: 'Swimlane',
  header: /^swimlane-beta\b/,
  check: undefined,
  // Node ids, not the words of unquoted labels inside shapes, nor the keyword line.
  symbols: lines =>
    flowchart
      .symbols(lines.map(l => (/^\s*swimlane-beta\b/.test(l) ? '' : maskBrackets(l))))
      .filter(s => ![].includes(s.name)),
  snippets: flowchart.snippets
    .filter(([, body]) => !body.startsWith('subgraph'))
    .concat([[t('lane subgraph'), t('subgraph ${1:id} [${2:name}]\n\t$0\nend')]]),
  starter:
    'swimlane-beta LR\n\tsubgraph ${1:a} [${2:Customer}]\n\t\t${3:order}([${4:Order}])\n\tend\n\tsubgraph ${5:b} [${6:Shop}]\n\t\t${7:ship}[${8:Ship}]\n\tend\n\t${3:order} --> ${7:ship}',
}
