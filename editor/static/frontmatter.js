// A diagram's front matter (the YAML between `---` lines before its header) against Mermaid's
// config schema: findings (an option Mermaid 12.1.0 does not have, a value of the wrong type or
// not one it takes, a key Mermaid ignores), completions and hovers for its keys and values.
// Pure functions, no DOM; the schema is config-schema.json, Mermaid 12.1.0's own
// (packages/mermaid/src/schemas/config.schema.yaml) as JSON.
//
// Mermaid reads front matter with YAML's JSON schema: true/false, null and JSON-style numbers are
// typed, every other plain value is a string. This reads the block mappings front matter is
// written in; a flow value ({…}, […]), a block scalar (|, >), a quoted string over several lines
// or a list is taken as written, unchecked.

import { t } from './i18n.js'

const FILE = new URL('./config-schema.json', import.meta.url)
let loaded = null

/** The schema, fetched once (again after a failure). */
export function loadConfigSchema(fetchFn = globalThis.fetch, url = FILE) {
  loaded ??= fetchFn(url).then(res => {
    if (!res.ok) throw new Error(`config schema: ${res.status}`)
    return res.json()
  })
  loaded.catch(() => (loaded = null))
  return loaded
}

/** The keys Mermaid reads at the top of front matter (frontmatter.ts), each with what it is for. */
const TOP = {
  title: { type: 'string', description: t("The diagram's title, drawn above it.") },
  config: {
    type: 'object',
    description: t("Mermaid config for this diagram: theme, look, layout, and each diagram type's options."),
  },
  displayMode: {
    type: 'string',
    description: t('Gantt only: `compact` puts tasks on shared rows (config.gantt.displayMode).'),
  },
}

/** The index of the line after a source's front matter: 0 when it has none, -1 when it is not closed. */
export function frontMatterEnd(lines) {
  if (lines[0]?.trim() !== '---') return 0
  return lines.findIndex((l, i) => i > 0 && l.trim() === '---') + 1 || -1
}

/**
 * The front matter of a source: `from` and `to`, the 1-based lines of its `---` fences, and its
 * entries, each { line, indent, key, keyStart, keyEnd (1-based columns, end exclusive), path
 * (keys from the top, this one last), value } where value is null for a mapping (its entries
 * follow, indented), { scalar, type } for a plain or quoted value, or { opaque } for one not read.
 * Null when the source has none (or it is not closed).
 */
export function frontMatter(text) {
  const lines = text.split('\n')
  const end = frontMatterEnd(lines)
  if (end <= 0) return null
  const close = end - 1
  const entries = []
  const stack = [] // [{ indent, key }] of the mappings open above the line
  let skipDeeper = -1 // a block scalar's or list's indent: deeper lines are its content
  for (let i = 1; i < close; i++) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = line.length - line.trimStart().length
    if (skipDeeper >= 0) {
      if (indent > skipDeeper) continue
      skipDeeper = -1
    }
    if (/^\s*-(\s|$)/.test(line)) {
      skipDeeper = indent // a list item: its entries are not read
      continue
    }
    const m = /^(\s*)("[^"]*"|'[^']*'|[^\s"'#:][^:#]*?)\s*:(?:\s+(.*?))?\s*$/.exec(line)
    if (!m) continue
    const key = m[2].replace(/^(["'])(.*)\1$/, '$2')
    while (stack.length && stack.at(-1).indent >= indent) stack.pop()
    const path = [...stack.map(s => s.key), key]
    const raw = m[3] === undefined ? '' : stripComment(m[3])
    let value
    if (!raw && deeperNext(lines, i, close, indent)) {
      value = null
      stack.push({ indent, key })
    } else if (!raw)
      value = { scalar: null, type: 'null', empty: true } // nothing under it (yet): YAML's null
    else {
      value = /^[|>[{&*!]/.test(raw) || /^(["'])(?!.*\1\s*$)/.test(raw) ? { opaque: raw } : scalar(raw)
      skipDeeper = indent // deeper lines under a value are more of it (a block scalar, a string over lines)
    }
    entries.push({ line: i + 1, indent, key, keyStart: indent + 1, keyEnd: indent + 1 + m[2].length, path, value })
  }
  return { from: 1, to: close + 1, entries }
}

// Is the next line with content indented deeper than `indent` (the entries of a mapping)?
function deeperNext(lines, i, close, indent) {
  for (let j = i + 1; j < close; j++) {
    const l = lines[j]
    if (!l.trim() || /^\s*#/.test(l)) continue
    return l.length - l.trimStart().length > indent
  }
  return false
}

const stripComment = raw => (/^["']/.test(raw) ? raw : raw.replace(/\s+#.*$/, '')).trim()

// A value as YAML's JSON schema types it.
function scalar(raw) {
  const quoted = /^(["'])(.*)\1$/.exec(raw)
  if (quoted) return { scalar: quoted[2], type: 'string' }
  if (raw === 'true' || raw === 'false') return { scalar: raw === 'true', type: 'boolean' }
  if (raw === 'null' || raw === '~') return { scalar: null, type: 'null' }
  if (/^-?(0|[1-9]\d*)$/.test(raw)) return { scalar: Number(raw), type: 'integer' }
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) return { scalar: Number(raw), type: 'number' }
  return { scalar: raw, type: 'string' }
}

// --- The schema ----------------------------------------------------------------------------

// A schema node with its $ref followed (siblings of the $ref win: a default, a description).
function resolve(root, node) {
  let n = node
  for (let hops = 0; n?.$ref && hops < 20; hops++) {
    const { $ref, ...rest } = n
    const target = $ref
      .replace(/^#\//, '')
      .split('/')
      .reduce((o, k) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], root)
    n = { ...target, ...rest }
  }
  return n ?? {}
}

// The properties a node allows, its allOf's included.
function propertiesOf(root, node) {
  const n = resolve(root, node)
  const own = n.properties ?? {}
  const inherited = (n.allOf ?? []).map(p => propertiesOf(root, p))
  return Object.assign({}, ...inherited, own)
}

// Does a node take keys it does not list (themeVariables, dompurifyConfig)?
function isOpen(root, node) {
  const n = resolve(root, node)
  if (n.additionalProperties === false || n.unevaluatedProperties === false) return false
  return !n.properties && !n.allOf
}

/** The schema node of a config path (the keys under `config:`); undefined when Mermaid has none. */
function nodeAt(root, path) {
  let node = root
  for (const key of path) {
    if (isOpen(root, node)) return {}
    node = propertiesOf(root, node)[key]
    if (!node) return undefined
  }
  return resolve(root, node)
}

// The types a node takes, and its enum (with each value's description) when it has one.
function shapeOf(root, node) {
  const n = resolve(root, node)
  const branches = n.oneOf ?? n.anyOf
  if (branches) {
    const shapes = branches.map(b => shapeOf(root, b))
    return {
      types: shapes.some(s => !s.types) ? undefined : shapes.flatMap(s => s.types),
      values:
        shapes.some(s => !s.values) && shapes.some(s => s.types?.includes('string'))
          ? undefined
          : shapes.flatMap(s => s.values ?? []),
      docs: Object.assign({}, ...shapes.map(s => s.docs)),
    }
  }
  const types = n.type === undefined ? undefined : [n.type].flat()
  const values = n.enum ?? (types?.length === 1 && types[0] === 'boolean' ? [true, false] : undefined)
  return { types, values, docs: n['meta:enum'] ?? {} }
}

const typeTakes = (types, type) => !types || types.includes(type) || (type === 'integer' && types.includes('number'))

// --- Findings ------------------------------------------------------------------------------

/**
 * Findings in a source's front matter: { line, severity: 'warning', rule: 'config', message, fix? }.
 * Mermaid itself ignores an option it does not have, and a value it cannot use falls back to its
 * default, so each is a warning, not an error; a misspelt key that is one edit from an option is
 * fixed to it.
 */
export function configFindings(text, schema) {
  const fm = frontMatter(text)
  if (!fm || !schema) return []
  const lines = text.split('\n')
  const secure = new Set(schema.properties?.secure?.default ?? [])
  const unknownUnder = new Set() // paths already reported unknown: their entries are not
  const findings = []
  const warn = (e, message, fix) =>
    findings.push({ line: e.line, severity: 'warning', rule: 'config', message, ...(fix ? { fix } : {}) })
  for (const e of fm.entries) {
    const parentKey = e.path.slice(0, -1).join('.')
    if ([...unknownUnder].some(p => parentKey === p || parentKey.startsWith(`${p}.`))) continue
    if (e.path.length === 1) {
      if (!TOP[e.key]) {
        const near = closest(e.key, Object.keys(TOP))
        warn(
          e,
          t('Mermaid ignores "{key}" in front matter: it reads only title, config and displayMode', { key: e.key }) +
            (near ? t(' (did you mean "{near}"?)', { near }) : ''),
          near && renameKey(lines[e.line - 1], e, near),
        )
        unknownUnder.add(e.key)
      } else checkValue(e, TOP[e.key], warn, schema)
      continue
    }
    if (e.path[0] !== 'config') continue
    const path = e.path.slice(1)
    const parent = nodeAt(schema, path.slice(0, -1))
    if (parent && isOpen(schema, parent)) continue // themeVariables and the like take any key
    const node = nodeAt(schema, path)
    if (!node) {
      const near = parent ? closest(e.key, Object.keys(propertiesOf(schema, parent))) : undefined
      const where = path.length > 1 ? `config.${path.slice(0, -1).join('.')}` : 'config'
      warn(
        e,
        t('"{key}" is not a Mermaid 12.1.0 option of {where}: Mermaid ignores it', { key: e.key, where }) +
          (near ? t(' (did you mean "{near}"?)', { near }) : ''),
        near && renameKey(lines[e.line - 1], e, near),
      )
      unknownUnder.add(e.path.join('.'))
      continue
    }
    if (path.length === 1 && secure.has(e.key)) {
      warn(
        e,
        t('Mermaid ignores config.{key} in a diagram: only the page that draws it can set it (a secure key)', {
          key: e.key,
        }),
      )
      continue
    }
    checkValue(e, node, warn, schema)
  }
  return findings
}

// A value against its node: a mapping where a value is wanted or the other way round, a type, an enum.
function checkValue(e, node, warn, schema) {
  const name = e.path.join('.')
  const { types, values } = shapeOf(schema, node)
  const wantsObject = types?.includes('object') && !types.some(t => t !== 'object')
  if (e.value === null) {
    if (types && !types.includes('object'))
      warn(e, t('{name} takes {what}, not a mapping', { name, what: describe(types, values) }))
    return
  }
  if (e.value.opaque !== undefined) return
  if (wantsObject) return warn(e, t('{name} is a mapping: write its options on the lines below, indented', { name }))
  const { scalar: v, type } = e.value
  if (type === 'null') return
  if (values && !values.some(x => x === v)) {
    // A number or boolean written for a string enum still reads as that string: compare as text.
    if (values.some(x => String(x) === String(v))) return
    return warn(
      e,
      t('{name} does not take {value}: {what}', {
        name,
        value: JSON.stringify(v),
        what: describe(undefined, values),
      }),
    )
  }
  if (types && !typeTakes(types, type) && !(type !== 'string' && types.includes('string')))
    warn(
      e,
      t('{name} takes {what}, not {type} ({value})', {
        name,
        what: describe(types, values),
        type: kindName(type === 'integer' ? 'number' : type),
        value: JSON.stringify(v),
      }),
    )
}

// A value's kind, as a finding names it ("a string").
const kindName = type => {
  const names = {
    string: t('a string'),
    number: t('a number'),
    integer: t('a whole number'),
    boolean: t('a boolean'),
    array: t('a list'),
    object: t('a mapping'),
    null: 'null',
  }
  return names[type] ?? type
}

const describe = (types, values) =>
  values?.length
    ? t('one of {values}', { values: values.map(x => JSON.stringify(x)).join(', ') })
    : types.map(kindName).join(t(' or '))

// The line with its key renamed.
const renameKey = (line, e, to) => line.slice(0, e.keyStart - 1) + to + line.slice(e.keyEnd - 1)

// The one option a key is a slip from: the same but for case, or one edit away (a letter added,
// dropped, changed, or two swapped); else undefined.
function closest(key, options) {
  const lower = key.toLowerCase()
  const same = options.filter(o => o.toLowerCase() === lower)
  if (same.length === 1) return same[0]
  const near = options.filter(o => editDistance(o.toLowerCase(), lower) === 1)
  return near.length === 1 ? near[0] : undefined
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  let before = prev
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], before[j - 2] + 1)
    }
    before = prev
    prev = row
  }
  return prev[b.length]
}

// --- Completion and hover ------------------------------------------------------------------

// The mapping a key at `indent` on `line` is in: that of the nearest entry above it indented less
// (an entry with nothing after its colon is the mapping being written).
function parentPath(fm, line, indent) {
  const owner = fm.entries.filter(e => e.line < line && e.indent < indent).at(-1)
  return !owner ? [] : owner.value === null || owner.value.empty ? owner.path : owner.path.slice(0, -1)
}

const docOf = node => {
  const n = node ?? {}
  return [
    n.description?.trim(),
    n.default !== undefined && typeof n.default !== 'object' ? `Default: \`${JSON.stringify(n.default)}\`` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * What can be written at a place in the front matter: { kind: 'key', items } for a key (each
 * { label, detail, doc, mapping, choices: has values to pick from }), { kind: 'value', items }
 * after `key: ` (each { label, detail, doc }); { kind: 'none', items: [] } in front matter where
 * nothing is known; null outside it. `line` and `column` are 1-based,
 * the column the caret is at.
 */
export function configCompletions(text, line, column, schema) {
  const fm = frontMatter(text)
  if (!fm || !schema || line <= fm.from || line >= fm.to) return null
  const before = text.split('\n')[line - 1].slice(0, column - 1)
  const keyAt = /^(\s*)([\w-]*)$/.exec(before)
  if (keyAt) {
    const indent = keyAt[1].length
    const parent = parentPath(fm, line, indent)
    const taken = new Set(
      fm.entries
        .filter(
          e =>
            e.line !== line &&
            e.path.length === parent.length + 1 &&
            e.path.slice(0, -1).join('.') === parent.join('.'),
        )
        .map(e => e.key),
    )
    let options
    if (!parent.length) options = TOP
    else if (parent[0] === 'config') {
      const node = nodeAt(schema, parent.slice(1))
      if (!node || isOpen(schema, node)) return NONE
      options = propertiesOf(schema, node)
    } else return NONE
    const secure = new Set(parent.length === 1 ? (schema.properties?.secure?.default ?? []) : [])
    const items = Object.entries(options)
      .filter(([k]) => !taken.has(k) && !secure.has(k) && !k.startsWith('_'))
      .map(([k, n]) => {
        const node = resolve(schema, n)
        const { types, values } = shapeOf(schema, node)
        return {
          label: k,
          detail: types ? describe(types, values) : 'any',
          doc: docOf(node),
          choices: Boolean(values?.length),
          mapping:
            Boolean(types?.length === 1 && types[0] === 'object') ||
            (!types && !values && isOpen(schema, node) && k !== 'secure'),
        }
      })
    return { kind: 'key', items }
  }
  const valueAt = /^(\s*)("[^"]*"|'[^']*'|[\w-]+)\s*:\s+[\w-]*$/.exec(before)
  if (valueAt) {
    const indent = valueAt[1].length
    const key = valueAt[2].replace(/^(["'])(.*)\1$/, '$2')
    const path = [...parentPath(fm, line, indent), key]
    const node = path.length === 1 ? TOP[key] : path[0] === 'config' ? nodeAt(schema, path.slice(1)) : undefined
    if (!node) return NONE
    const { values, docs } = shapeOf(schema, node)
    if (!values?.length) return NONE
    return { kind: 'value', items: values.map(v => ({ label: String(v), detail: key, doc: docs?.[v] ?? '' })) }
  }
  return NONE
}

const NONE = Object.freeze({ kind: 'none', items: [] })

/** The doc of the front matter key at a place: { name, doc, range: { keyStart, keyEnd } }; else null. */
export function configHover(text, line, column, schema) {
  const fm = frontMatter(text)
  if (!fm || !schema) return null
  const e = fm.entries.find(x => x.line === line && column >= x.keyStart && column < x.keyEnd)
  if (!e) return null
  const node = e.path.length === 1 ? TOP[e.key] : e.path[0] === 'config' ? nodeAt(schema, e.path.slice(1)) : undefined
  if (!node) return null
  const { types, values } = shapeOf(schema, node)
  const takes = types || values ? t('Takes {what}.', { what: describe(types ?? [], values) }) : ''
  return {
    name: e.path.join('.'),
    doc: [docOf(node), takes].filter(Boolean).join('\n\n'),
    keyStart: e.keyStart,
    keyEnd: e.keyEnd,
  }
}
