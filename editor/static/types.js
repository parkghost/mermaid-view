// The diagram types the editor knows, each described in its own module (see type-core.js for the
// descriptor's fields). A new type is a new module and one line in TYPES; nothing else changes.

import { frontMatterEnd } from './frontmatter.js'
import agentflow from './type-agentflow.js'
import architecture from './type-architecture.js'
import block from './type-block.js'
import c4 from './type-c4.js'
import classDiagram from './type-class.js'
import { lexer } from './type-core.js'
import cynefin from './type-cynefin.js'
import er from './type-er.js'
import eventmodeling from './type-eventmodeling.js'
import flowchart, { tokenize as flowTokens } from './type-flowchart.js'
import gantt from './type-gantt.js'
import gitGraph from './type-gitgraph.js'
import info from './type-info.js'
import ishikawa from './type-ishikawa.js'
import journey from './type-journey.js'
import kanban from './type-kanban.js'
import mindmap from './type-mindmap.js'
import packet from './type-packet.js'
import pie from './type-pie.js'
import quadrant from './type-quadrant.js'
import radar from './type-radar.js'
import railroad from './type-railroad.js'
import requirement from './type-requirement.js'
import sankey from './type-sankey.js'
import sequence from './type-sequence.js'
import state from './type-state.js'
import swimlane from './type-swimlane.js'
import timeline from './type-timeline.js'
import treemap from './type-treemap.js'
import treeView from './type-treeview.js'
import usecase from './type-usecase.js'
import venn from './type-venn.js'
import wardley from './type-wardley.js'
import xychart from './type-xychart.js'
import zenuml from './type-zenuml.js'

/** Every type, each with its tokenizer ready. */
export const TYPES = [
  flowchart,
  swimlane,
  agentflow,
  sequence,
  zenuml,
  classDiagram,
  state,
  er,
  requirement,
  c4,
  gantt,
  pie,
  journey,
  timeline,
  mindmap,
  kanban,
  gitGraph,
  quadrant,
  xychart,
  sankey,
  packet,
  block,
  architecture,
  radar,
  treemap,
  treeView,
  eventmodeling,
  ishikawa,
  venn,
  usecase,
  wardley,
  cynefin,
  ...railroad,
  info,
].map(d => ({ ...d, tokenize: d.tokenize ?? lexer(d.lexer) }))

/** A source whose type is not known: highlighting as a flowchart's, no blocks, no lint. */
export const GENERIC = { id: '', name: 'Unknown', header: /$^/, tokenize: flowTokens, indent: 'depth' }

const byId = new Map(TYPES.map(d => [d.id, d]))

/** The type a diagram keyword line (trimmed) starts. */
export const typeOfHeader = line => TYPES.find(d => d.header.test(line)) ?? GENERIC

/** Whether a trimmed line opens a %%{ … }%% directive that goes on over the lines after it. */
export const opensDirective = t => t.startsWith('%%{') && !t.includes('}%%')

/** The type of a source: by its first statement, after front matter, directives and comments. */
export function typeOf(text) {
  const lines = text.split('\n')
  let i = frontMatterEnd(lines)
  if (i < 0) return GENERIC
  let directive = false // inside a directive over several lines (Mermaid reads it wherever it ends)
  for (; i < lines.length; i++) {
    const t = lines[i].trim()
    if (directive) directive = !t.includes('}%%')
    else if (opensDirective(t)) directive = true
    else if (t && !t.startsWith('%%')) return typeOfHeader(t)
  }
  return GENERIC
}
typeOf.byId = id => byId.get(id)
