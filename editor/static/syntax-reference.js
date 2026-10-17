// The syntax reference of each diagram type for Mermaid 12.1.0, the version the editor renders
// with. Its one source is syntax-reference.json, which the MCP server reads too (reference.py):
// a type is named by its descriptor id, a header keyword or its name, in any case.

const FILE = new URL('./syntax-reference.json', import.meta.url)
let loaded = null

/** The reference, fetched once. */
export function loadReference(fetchFn = globalThis.fetch, url = FILE) {
  loaded ??= fetchFn(url).then(res => {
    if (!res.ok) throw new Error(`syntax reference: ${res.status}`)
    return res.json()
  })
  loaded.catch(() => (loaded = null)) // a failed fetch is tried again next time
  return loaded
}

/** The type a descriptor id, header keyword or name stands for; undefined when none. */
export function findType(reference, key) {
  const want = String(key ?? '')
    .trim()
    .toLowerCase()
  return reference.types.find(t => [t.id, t.name, ...t.headers].some(k => k.toLowerCase() === want))
}

/** Why a type is not one: the valid ones, by id and header. */
export const unknownType = (reference, key) =>
  `No diagram type "${key}". Valid types (id: header): ${reference.types.map(t => `${t.id}: ${t.headers[0]}`).join(', ')}.`

/** Every type in a line: id, name, header to write, purpose. */
export const summaries = reference =>
  reference.types.map(t => ({ id: t.id, name: t.name, header: t.headers[0], purpose: t.purpose }))
