// WebMCP: the page's own tools for an agent in the browser (the WebMCP draft of the W3C Web
// Machine Learning community group: document.modelContext, formerly navigator.modelContext).
// Without it, nothing happens.
//
// The tools act on the page as the person would, through the page's own functions (injected:
// see `page` below), so an edit goes through the card's editor (undo works) and saves as typing
// does. The page loads once and documents open in it, so the tools are registered once and read
// the document shown when they are called. Two tools help write a diagram right: each type's
// syntax for Mermaid 12.1.0 (syntax-reference.json) and a check without saving (check.js).

import { checkReport, MERMAID_VERSION } from './check.js'
import { findType, summaries, unknownType } from './syntax-reference.js'

/** The browser's model context: document.modelContext, or the earlier navigator.modelContext. */
export function modelContextOf(doc = globalThis.document, nav = globalThis.navigator) {
  return doc?.modelContext ?? nav?.modelContext ?? null
}

/** A document of this editor from a URL or a page id; null for anything else (another site). */
export function documentUrl(target, base) {
  const text = String(target ?? '').trim()
  if (!text) return null
  const url = new URL(/^[A-Za-z0-9_-]+$/.test(text) ? `/d/${text}` : text, base)
  return url.origin === new URL(base).origin && /^\/[df](\/|$)/.test(url.pathname) ? url.href : null
}

// A finding as the agent reads it: where, how bad, which rule, what.
const plain = findings => findings.map(f => ({ line: f.line, severity: f.severity, rule: f.rule, message: f.message }))
const json = value => JSON.stringify(value, null, 2)
const INDEX = {
  type: 'integer',
  minimum: 0,
  description: "The diagram's index on the page, from 0 (diagram 1 is index 0).",
}
const TYPE = {
  type: 'string',
  description:
    'A diagram type: its id (from get_syntax_reference without type) or its header keyword, e.g. flowchart, graph, sequenceDiagram, stateDiagram-v2, architecture-beta.',
}
const VERSION_NOTE = `This editor renders with Mermaid ${MERMAID_VERSION}: syntax of other Mermaid versions may not parse; call get_syntax_reference before writing a diagram type you are unsure about.`

/**
 * The tools, over the page:
 *   current() -> { kind, id, projectId, path, title, url, diagrams: [{ index, source }] } | null
 *   findings(index) -> the parser's and linter's findings of a diagram as it is now
 *   setSource(index, text) -> findings once drawn again; fix(index) -> the same, its source fixed
 *   open(url) -> the document shown after; search(query) -> what the library lists
 *   exportText(index, 'svg' | 'mmd') -> text
 *   check(source) -> the parser's and linter's findings of any source, nothing saved
 *   reference() -> the syntax reference (syntax-reference.json)
 * A diagram that is not on the page throws.
 */
export function tools(page) {
  const diagram = index => {
    const doc = page.current()
    const d = doc?.diagrams.find(x => x.index === index)
    if (!d)
      throw new Error(
        doc ? `This document has no diagram ${index} (it has ${doc.diagrams.length}).` : 'No document is open.',
      )
    return d
  }
  const typeNamed = async key => {
    const reference = await page.reference()
    const entry = findType(reference, key)
    if (!entry) throw new Error(unknownType(reference, key))
    return { reference, entry }
  }
  return [
    {
      name: 'get_syntax_reference',
      description:
        `The syntax of a Mermaid diagram type as Mermaid ${MERMAID_VERSION} (the version this editor renders with) takes it: ` +
        'header keywords and variants, statements, arrows, blocks, version differences and common mistakes, an example. ' +
        'Call it before writing a diagram type you are unsure about, since syntax from other Mermaid versions may not parse. ' +
        'Without type: every type with its header and purpose.',
      inputSchema: { type: 'object', properties: { type: TYPE } },
      annotations: { readOnlyHint: true },
      execute: async ({ type = '' } = {}) => {
        if (!String(type).trim()) {
          const reference = await page.reference()
          return json({ mermaid: reference.mermaid, types: summaries(reference) })
        }
        const { reference, entry } = await typeNamed(type)
        return json({ mermaid: reference.mermaid, ...entry, common: reference.common })
      },
    },
    {
      name: 'check_diagram',
      description:
        `Checks a Mermaid source without saving it or changing the page: Mermaid ${MERMAID_VERSION}'s parser (with the editor's config) ` +
        "and the editor's lint for its type. Returns ok (no errors), the detected type, errors and warnings with line numbers, and what checked it.",
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'The whole Mermaid source, without the ``` fence.' },
          type: {
            ...TYPE,
            description: `${TYPE.description} Optional: the type you meant; a source of another type is reported.`,
          },
        },
        required: ['source'],
      },
      annotations: { readOnlyHint: true },
      execute: async ({ source, type = '' }) => {
        const expected = String(type).trim() ? (await typeNamed(type)).entry.id : ''
        const text = String(source)
        return json(checkReport(text, await page.check(text), expected))
      },
    },
    {
      name: 'get_current_document',
      description:
        'The Mermaid document open in this mermaid-view editor tab: its kind (a page of diagrams kept from a conversation, ' +
        "or a project file), id or path, title, and each diagram's source with the parser's errors and the linter's warnings.",
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const doc = page.current()
        if (!doc) return json({ kind: null, diagrams: [] })
        const diagrams = await Promise.all(
          doc.diagrams.map(async d => ({ ...d, findings: plain(await page.findings(d.index)) })),
        )
        return json({ ...doc, diagrams })
      },
    },
    {
      name: 'set_diagram_source',
      description:
        "Replaces one diagram's Mermaid source in its editor, as one undoable edit that saves like typing does, and redraws it. " +
        "Returns the parser's errors and the linter's warnings for the new source, and its check (as check_diagram reports it). " +
        VERSION_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          index: INDEX,
          source: { type: 'string', description: 'The whole Mermaid source, without the ``` fence.' },
        },
        required: ['index', 'source'],
      },
      execute: async ({ index, source }) => {
        diagram(index)
        const text = String(source)
        const findings = await page.setSource(index, text)
        return json({ index, findings: plain(findings), check: checkReport(text, findings) })
      },
    },
    {
      name: 'fix_diagram',
      description:
        "Applies every automatic lint fix to one diagram and formats it (the card's buttons to fix all and to format), as one undoable edit. Returns its source and findings after.",
      inputSchema: { type: 'object', properties: { index: INDEX }, required: ['index'] },
      execute: async ({ index }) => {
        diagram(index)
        const findings = await page.fix(index)
        return json({ index, source: diagram(index).source, findings: plain(findings) })
      },
    },
    {
      name: 'open_document',
      description:
        'Opens another document in this tab: a page by its id, or an editor URL (/d/<page id>, /f/<project id>?path=<file>). ' +
        'Unsaved edits are saved first.',
      inputSchema: {
        type: 'object',
        properties: { target: { type: 'string', description: 'A page id or an editor URL.' } },
        required: ['target'],
      },
      execute: async ({ target }) => {
        const url = documentUrl(target, page.base())
        if (!url) throw new Error(`Not a document of this editor: ${target}`)
        await page.open(url)
        const doc = page.current()
        return json(
          doc
            ? {
                kind: doc.kind,
                id: doc.id,
                projectId: doc.projectId,
                path: doc.path,
                title: doc.title,
                url: doc.url,
                diagrams: doc.diagrams.length,
              }
            : null,
        )
      },
    },
    {
      name: 'search_library',
      description:
        'Searches the library as its search box does (every word must match): pages by title, tags, project and source, or, ' +
        "while a project file is open, that project's files by path and source. Lists what the library shows.",
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Words to find; empty lists everything.' } },
      },
      annotations: { readOnlyHint: true },
      execute: async ({ query = '' } = {}) => json(await page.search(String(query))),
    },
    {
      name: 'export_diagram',
      description: 'One diagram as text: its Mermaid source (mmd) or its drawing as SVG markup (svg).',
      inputSchema: {
        type: 'object',
        properties: {
          index: INDEX,
          format: { type: 'string', enum: ['svg', 'mmd'], description: 'svg: the drawing; mmd: the source.' },
        },
        required: ['index', 'format'],
      },
      annotations: { readOnlyHint: true },
      execute: async ({ index, format }) => {
        diagram(index)
        if (format !== 'svg' && format !== 'mmd') throw new Error('format must be svg or mmd')
        return page.exportText(index, format)
      },
    },
  ]
}

/**
 * Registers the tools with a model context. registerTool(tool, { signal }) as drafted (aborting the
 * signal unregisters); an earlier navigator.modelContext returned { unregister } instead, or had
 * provideContext({ tools }) only.
 */
export async function registerTools(modelContext, list, signal) {
  if (typeof modelContext.registerTool !== 'function') {
    modelContext.provideContext?.({ tools: list })
    signal?.addEventListener('abort', () => modelContext.clearContext?.())
    return
  }
  for (const tool of list) {
    const registered = await modelContext.registerTool(tool, { signal })
    if (typeof registered?.unregister === 'function') signal?.addEventListener('abort', () => registered.unregister())
  }
}

/** The page's tools, when the browser has a model context; false when it has none. */
export function startWebMcp(page, { doc, nav, signal } = {}) {
  const modelContext = modelContextOf(doc, nav)
  if (!modelContext) return false
  registerTools(modelContext, tools(page), signal).catch(err =>
    console.warn('mermaid-view: WebMCP tools not registered', err),
  )
  return true
}
