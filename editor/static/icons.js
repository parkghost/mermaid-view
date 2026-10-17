// The icon packs Mermaid draws named icons from: `logos:aws-s3` in an architecture or tree view,
// `A@{ icon: "mdi:account" }` in a flowchart, and `fa:fa-user` in a label (a Font Awesome prefix
// Mermaid knows: fa, fas, far, fab). Each is an Iconify set, fetched the first time a diagram
// uses it; an icon of a pack not here draws as a "?".

const ICONIFY = 'https://cdn.jsdelivr.net/npm/@iconify-json'

/** Each pack's name in a diagram and the Iconify set (package@version) behind it. */
export const ICON_PACKS = {
  logos: 'logos@1.2.14',
  mdi: 'mdi@1.2.3',
  fa: 'fa6-solid@1.2.4',
  fas: 'fa6-solid@1.2.4',
  far: 'fa6-regular@1.2.4',
  fab: 'fa6-brands@1.2.6',
}

/**
 * The packs as mermaid.registerIconPacks takes them. A set two names share is fetched once; a
 * failed fetch is tried again by the next diagram that asks (Mermaid keeps only what loaded).
 */
export function iconPacks(fetchFn = globalThis.fetch) {
  const sets = new Map()
  const load = set => {
    if (!sets.has(set)) {
      const loading = fetchFn(`${ICONIFY}/${set}/icons.json`).then(res => {
        if (!res.ok) throw new Error(`icon pack ${set}: ${res.status}`)
        return res.json()
      })
      loading.catch(() => sets.delete(set))
      sets.set(set, loading)
    }
    return sets.get(set)
  }
  return Object.entries(ICON_PACKS).map(([name, set]) => ({ name, loader: () => load(set) }))
}
