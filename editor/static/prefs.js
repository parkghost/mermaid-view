// The viewer's choices (theme, panel widths, PNG size...), kept in this browser only. Storage may
// be off: a read then gives the fallback, and a choice lasts for this page only.

/** A choice as stored, else `fallback`. */
export const stored = (key, fallback) => {
  try {
    return localStorage.getItem(`mermaid-view.${key}`) ?? fallback
  } catch {
    return fallback
  }
}

/** Keeps a choice. */
export const store = (key, value) => {
  try {
    localStorage.setItem(`mermaid-view.${key}`, value)
  } catch {
    // storage off: the choice lasts for this page only
  }
}
