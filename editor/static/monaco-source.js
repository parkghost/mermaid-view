// The source editor on Monaco (VS Code's editor, as the Mermaid Live Editor uses), with a Mermaid
// language for every diagram type: highlighting, every place of the name under the caret,
// rename (F2), go to definition (F12) and references (Shift+F12), completion and snippets, format
// (Shift+Alt+F), quick fixes from the linter, and folding; in front matter, Mermaid's config
// options and values, with their docs on hover. What a type knows is in its
// descriptor (type-*.js); this only hands it to Monaco.

import { configCompletions, configHover, loadConfigSchema } from './frontmatter.js'
import { t } from './i18n.js'
import {
  definition,
  foldingRanges,
  format,
  initialState,
  lineTokens,
  names,
  occurrences,
  renameProblem,
  symbolAt,
  symbols,
  TYPES,
  typeOf,
} from './mermaid-lang.js'

const CDN = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min'
const findingsOf = new WeakMap() // model -> the findings its markers show, for quick fixes

let ready
/** Monaco, loaded once from the CDN, with the Mermaid language registered. */
export function loadMonaco() {
  ready ??= new Promise((resolve, reject) => {
    // The editor's worker, from the CDN through a same-origin blob; if it cannot start, Monaco
    // does its work on the page's thread instead. The worker is this exact release's (its name
    // carries the build's hash).
    window.MonacoEnvironment = {
      getWorkerUrl: () =>
        URL.createObjectURL(
          new Blob(
            [`self.MonacoEnvironment={baseUrl:'${CDN}/'};importScripts('${CDN}/vs/assets/editor.worker-Be8ye1pW.js');`],
            {
              type: 'text/javascript',
            },
          ),
        ),
    }
    const css = document.createElement('link')
    css.rel = 'stylesheet'
    css.href = `${CDN}/vs/editor/editor.main.css`
    document.head.append(css)
    const script = document.createElement('script')
    script.src = `${CDN}/vs/loader.js`
    script.onerror = reject
    script.onload = () => {
      window.require.config({ paths: { vs: `${CDN}/vs` } })
      window.require(
        ['vs/editor/editor.main'],
        () => {
          register(window.monaco)
          resolve(window.monaco)
        },
        reject,
      )
    }
    document.head.append(script)
  })
  return ready
}

// A model's text and named elements, worked out once a version: every move of the caret asks
// for the name under it, and its places.
const parsed = new WeakMap() // model -> { version, text, syms }
function parsedOf(model) {
  const version = model.getVersionId()
  let p = parsed.get(model)
  if (p?.version !== version) {
    const text = model.getValue()
    parsed.set(model, (p = { version, text, syms: symbols(text) }))
  }
  return p
}

// The name under a position, with its range; undefined when the caret is not on one.
function idAt(monaco, model, pos) {
  const { text, syms } = parsedOf(model)
  const s = symbolAt(text, pos.lineNumber, pos.column, syms)
  return s && { id: s.name, range: new monaco.Range(s.line, s.start, s.line, s.end) }
}

// Every place a name is one in a model's text.
function placesOf(model, id) {
  const { text, syms } = parsedOf(model)
  return occurrences(text, id, syms)
}

// Monaco's tokenizer state: the language's line state, comparable and copyable.
class LineState {
  constructor(state) {
    this.state = state
  }
  clone() {
    return new LineState({ ...this.state })
  }
  equals(other) {
    return other instanceof LineState && JSON.stringify(other.state) === JSON.stringify(this.state)
  }
}
const SCOPE = { id: 'identifier', punct: 'delimiter', text: 'text', space: 'white' }

function register(monaco) {
  const { languages } = monaco
  languages.register({ id: 'mermaid', extensions: ['.mmd'], aliases: ['Mermaid'] })
  // Highlighting by the type's own tokens: the keyword line tells the type for the lines after it.
  languages.setTokensProvider('mermaid', {
    getInitialState: () => new LineState(initialState()),
    tokenize(line, state) {
      const { tokens, state: next } = lineTokens(line, state.state)
      let at = 0
      const out = tokens.map(t => {
        const token = { startIndex: at, scopes: SCOPE[t.type] ?? t.type }
        at += t.text.length
        return token
      })
      return { tokens: out, endState: new LineState(next) }
    },
  })
  languages.setLanguageConfiguration('mermaid', {
    comments: { lineComment: '%%' },
    brackets: [
      ['[', ']'],
      ['(', ')'],
      ['{', '}'],
    ],
    // No `|`: it opens and closes relations (`||--o{`) as often as it wraps a label. A `{` after
    // `|`, `o` or `}` is a cardinality (`||--o{`, `}|..|{`, `}o--o{`): the longest pair ending in
    // the typed character wins, and these close with nothing.
    autoClosingPairs: [
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '{', close: '}' },
      { open: '"', close: '"' },
      { open: '|{', close: '' },
      { open: 'o{', close: '' },
      { open: '}{', close: '' },
    ],
    surroundingPairs: [
      { open: '"', close: '"' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
    ],
    indentationRules: {
      increaseIndentPattern:
        /^\s*(subgraph|loop|alt|opt|par|par_over|critical|break|rect|box|flow|global|systemBoundary|block\b(?!-)|section)\b|\{\s*$/,
      decreaseIndentPattern: /^\s*(end\b|\})/,
    },
  })
  const colors = dark => ({
    keyword: dark ? 'C678DD' : 'A626A4',
    arrow: dark ? '56B6C2' : '0184BC',
    string: dark ? '98C379' : '50A14F',
    label: dark ? 'E5C07B' : 'C18401',
    identifier: dark ? '61AFEF' : '4078F2',
    comment: dark ? '7F848E' : 'A0A1A7',
    number: dark ? 'D19A66' : '986801',
    meta: dark ? '7F848E' : '696C77',
  })
  for (const dark of [false, true]) {
    const c = colors(dark)
    monaco.editor.defineTheme(dark ? 'mermaid-dark' : 'mermaid-light', {
      base: dark ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [
        { token: 'keyword', foreground: c.keyword, fontStyle: 'bold' },
        { token: 'arrow', foreground: c.arrow, fontStyle: 'bold' },
        { token: 'string', foreground: c.string },
        { token: 'label', foreground: c.label },
        { token: 'identifier', foreground: c.identifier },
        { token: 'comment', foreground: c.comment, fontStyle: 'italic' },
        { token: 'number', foreground: c.number },
        { token: 'meta', foreground: c.meta, fontStyle: 'italic' },
      ],
      colors: {},
    })
  }

  // Every place of the id under the caret, as VS Code marks a symbol's occurrences.
  languages.registerDocumentHighlightProvider('mermaid', {
    provideDocumentHighlights(model, pos) {
      const at = idAt(monaco, model, pos)
      if (!at) return []
      return placesOf(model, at.id).map(o => ({
        range: new monaco.Range(o.line, o.start, o.line, o.end),
        kind: languages.DocumentHighlightKind.Text,
      }))
    },
  })

  // F2: rename a name everywhere it is one; quoted text and labels keep their words.
  languages.registerRenameProvider('mermaid', {
    resolveRenameLocation(model, pos) {
      const at = idAt(monaco, model, pos)
      return at
        ? { range: at.range, text: at.id }
        : { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: t('Nothing here can be renamed') }
    },
    provideRenameEdits(model, pos, newName) {
      const at = idAt(monaco, model, pos)
      const text = model.getValue()
      if (!at) return { edits: [], rejectReason: t('Nothing here can be renamed') }
      const problem = renameProblem(text, at.id, newName)
      if (problem) return { edits: [], rejectReason: problem }
      return {
        edits: placesOf(model, at.id).map(o => ({
          resource: model.uri,
          versionId: undefined,
          textEdit: { range: new monaco.Range(o.line, o.start, o.line, o.end), text: newName },
        })),
      }
    },
  })

  // F12 / Ctrl+click: the place that declares the name; Shift+F12: every place it is named.
  languages.registerDefinitionProvider('mermaid', {
    provideDefinition(model, pos) {
      const at = idAt(monaco, model, pos)
      const { text, syms } = parsedOf(model)
      const o = at && definition(text, at.id, syms)
      return o ? [{ uri: model.uri, range: new monaco.Range(o.line, o.start, o.line, o.end) }] : []
    },
  })
  languages.registerReferenceProvider('mermaid', {
    provideReferences(model, pos) {
      const at = idAt(monaco, model, pos)
      if (!at) return []
      return placesOf(model, at.id).map(o => ({
        uri: model.uri,
        range: new monaco.Range(o.line, o.start, o.line, o.end),
      }))
    },
  })

  // In front matter: the config options a key can be, the values an option takes (with each one's
  // docs), from Mermaid's config schema; none where neither is known. Null outside front matter.
  const configItems = async (model, pos, range) => {
    const text = model.getValue()
    if (!text.startsWith('---')) return null
    const schema = await loadConfigSchema().catch(() => null)
    const at = schema && configCompletions(text, pos.lineNumber, pos.column, schema)
    if (!at) return null
    const K = languages.CompletionItemKind
    const doc = d => (d ? { value: d } : undefined)
    return at.items.map((it, i) =>
      at.kind === 'key'
        ? {
            label: it.label,
            kind: it.mapping ? K.Module : K.Property,
            detail: it.detail,
            documentation: doc(it.doc),
            range,
            insertText: it.mapping ? `${it.label}:\n  $0` : `${it.label}: $0`,
            sortText: String(i).padStart(4, '0'),
            insertTextRules: languages.CompletionItemInsertTextRule.InsertAsSnippet,
            command: it.choices ? { id: 'editor.action.triggerSuggest', title: 'values' } : undefined,
          }
        : {
            label: it.label,
            kind: K.EnumMember,
            detail: it.detail,
            documentation: doc(it.doc),
            insertText: it.label,
            range,
            sortText: String(i).padStart(4, '0'),
          },
    )
  }

  // Completion: in front matter, config options and values; else the diagram's names, its type's
  // keywords and snippets; on a source with no diagram yet, a new diagram of every type.
  languages.registerCompletionItemProvider('mermaid', {
    async provideCompletionItems(model, pos) {
      const word = model.getWordUntilPosition(pos)
      const range = new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn)
      const config = await configItems(model, pos, range)
      if (config) return { suggestions: config }
      const K = languages.CompletionItemKind
      const text = model.getValue()
      const desc = typeOf(text)
      const snippet = (label, body, detail) => ({
        label,
        kind: K.Snippet,
        insertText: body,
        range,
        detail,
        insertTextRules: languages.CompletionItemInsertTextRule.InsertAsSnippet,
      })
      if (!desc.id)
        return { suggestions: TYPES.map(d => snippet(t('New {type}', { type: d.name }), d.starter, d.header.source)) }
      return {
        suggestions: [
          // The names, but not the word being typed when it is its only place.
          ...names(text)
            .filter(id => id !== word.word || occurrences(text, id).length > 1)
            .map(id => ({ label: id, kind: K.Variable, insertText: id, range, detail: desc.name })),
          ...[...new Set(desc.lexer?.keywords ?? [])].map(k => ({ label: k, kind: K.Keyword, insertText: k, range })),
          ...(desc.snippets ?? []).map(([label, body]) => snippet(label, body)),
        ],
      }
    },
  })

  // After `option: ` in front matter, the values it takes (the space only asks this provider).
  languages.registerCompletionItemProvider('mermaid', {
    triggerCharacters: [' '],
    async provideCompletionItems(model, pos, context) {
      if (context.triggerKind !== languages.CompletionTriggerKind.TriggerCharacter) return { suggestions: [] }
      const range = new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column)
      return { suggestions: (await configItems(model, pos, range)) ?? [] }
    },
  })

  // Hover on a front matter key: what the option does, its default, what it takes.
  languages.registerHoverProvider('mermaid', {
    async provideHover(model, pos) {
      const text = model.getValue()
      if (!text.startsWith('---')) return null
      const schema = await loadConfigSchema().catch(() => null)
      const h = schema && configHover(text, pos.lineNumber, pos.column, schema)
      if (!h) return null
      return {
        range: new monaco.Range(pos.lineNumber, h.keyStart, pos.lineNumber, h.keyEnd),
        contents: [{ value: `**${h.name}**` }, ...(h.doc ? [{ value: h.doc }] : [])],
      }
    },
  })

  languages.registerDocumentFormattingEditProvider('mermaid', {
    provideDocumentFormattingEdits: model => [{ range: model.getFullModelRange(), text: format(model.getValue()) }],
  })

  // The light bulb: a lint finding that has a fix offers it.
  languages.registerCodeActionProvider('mermaid', {
    provideCodeActions(model, _range, context) {
      const findings = findingsOf.get(model) ?? []
      const actions = []
      for (const marker of context.markers) {
        const f = findings.find(x => x.fix !== undefined && x.line === marker.startLineNumber && x.rule === marker.code)
        if (!f) continue
        actions.push({
          title: `Fix: ${f.message}`,
          kind: 'quickfix',
          diagnostics: [marker],
          isPreferred: true,
          edit: {
            edits: [
              {
                resource: model.uri,
                versionId: undefined,
                textEdit: { range: new monaco.Range(f.line, 1, f.line, model.getLineMaxColumn(f.line)), text: f.fix },
              },
            ],
          },
        })
      }
      return { actions, dispose() {} }
    },
  })

  languages.registerFoldingRangeProvider('mermaid', {
    provideFoldingRanges: model =>
      foldingRanges(model.getValue()).map(r => ({
        start: r.start,
        end: r.end,
        kind: languages.FoldingRangeKind.Region,
      })),
  })
}

export class MonacoSource {
  /** Needs loadMonaco() resolved first. */
  constructor(root) {
    const monaco = window.monaco
    this.monaco = monaco
    root.classList.add('monaco-host')
    const dark = matchMedia('(prefers-color-scheme: dark)').matches
    this.editor = monaco.editor.create(root, {
      value: '',
      language: 'mermaid',
      theme: dark ? 'mermaid-dark' : 'mermaid-light',
      automaticLayout: true,
      fontSize: 13,
      lineHeight: 20,
      tabSize: 4,
      insertSpaces: true,
      minimap: { enabled: true, renderCharacters: false },
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      bracketPairColorization: { enabled: true },
      guides: { indentation: true },
      renameOnType: false,
    })
    this.model = this.editor.getModel()
    this.findings = []
    this.marks = this.editor.createDecorationsCollection()
    this.caretListeners = []
    this.editor.onDidChangeCursorPosition(e => {
      const n = e.position.lineNumber
      if (n === this.lastLine) return
      this.lastLine = n
      for (const fn of this.caretListeners) fn(n)
    })
  }

  get value() {
    return this.model.getValue()
  }

  /** The first text: replaces everything without an undo step. */
  set value(text) {
    this.model.setValue(text)
  }

  /** Removes the editor with its text, markers and listeners (its document left the page). */
  dispose() {
    this.monaco.editor.setModelMarkers(this.model, 'mermaid-view', [])
    this.caretListeners = []
    this.editor.dispose()
    this.model.dispose()
  }

  onInput(fn) {
    this.model.onDidChangeContent(() => fn())
  }

  /** Keys pressed in the editor: the person at work in it (edits made by code press none). */
  onKeys(fn) {
    this.editor.onKeyDown(() => fn())
  }

  onCaretLine(fn) {
    this.caretListeners.push(fn)
  }

  onBlur(fn) {
    this.editor.onDidBlurEditorText(fn)
  }

  /** Replaces the whole text as one undoable edit, keeping the caret where it can stay. */
  replace(text) {
    if (text === this.value) return
    const pos = this.editor.getPosition()
    this.editor.pushUndoStop()
    this.editor.executeEdits('mermaid-view', [{ range: this.model.getFullModelRange(), text }])
    this.editor.pushUndoStop()
    if (pos) this.editor.setPosition(this.model.validatePosition(pos))
  }

  caretLine() {
    return this.editor.getPosition()?.lineNumber ?? 1
  }

  /** Moves to a line, in view; select: the whole line. */
  goto(n, select = true) {
    const line = Math.min(Math.max(1, n), this.model.getLineCount())
    const end = select ? this.model.getLineMaxColumn(line) : 1
    this.editor.setSelection(new this.monaco.Range(line, 1, line, end))
    this.editor.revealLineInCenterIfOutsideViewport(line)
    this.editor.focus()
  }

  /** Marks the lines of what was picked in the diagram: primary strongest. */
  mark(primary, related = []) {
    const whole = (line, cls) => ({
      range: new this.monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: cls },
    })
    this.marks.set([
      ...related.filter(n => n !== primary).map(n => whole(n, 'mv-line-related')),
      ...(primary ? [whole(primary, 'mv-line-primary')] : []),
    ])
  }

  /** The parser's and the linter's findings, as markers (squiggles, hovers, the light bulb). */
  setFindings(findings) {
    this.findings = findings
    findingsOf.set(this.model, findings)
    const S = this.monaco.MarkerSeverity
    const severity = { error: S.Error, warning: S.Warning, info: S.Info }
    const lines = this.model.getLineCount()
    this.monaco.editor.setModelMarkers(
      this.model,
      'mermaid-view',
      findings
        .filter(f => f.line >= 1 && f.line <= lines)
        .map(f => {
          const content = this.model.getLineContent(f.line)
          return {
            severity: severity[f.severity] ?? S.Info,
            message: f.message,
            code: f.rule,
            source: f.rule === 'parse' ? 'mermaid' : 'lint',
            startLineNumber: f.line,
            startColumn: content.length - content.trimStart().length + 1,
            endLineNumber: f.line,
            endColumn: this.model.getLineMaxColumn(f.line),
          }
        }),
    )
  }
}
