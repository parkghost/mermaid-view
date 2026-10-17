// The page's language. Text is written in English where it is used, wrapped in t(); a catalog
// (locale-<lang>.js) gives each English text its translation. The language is chosen once, when
// the page loads: the person's choice, else the browser's; a change reloads the page, so modules
// may translate their constants at import.

import zhHant from './locale-zh-hant.js'
import { stored } from './prefs.js'

/** The languages offered, each with its name in itself. English is the source and the fallback. */
export const LANGS = { en: 'English', 'zh-Hant': '繁體中文' }
const CATALOGS = { 'zh-Hant': zhHant }

/**
 * The language for a choice ('auto' or one of LANGS) and the browser's languages, in order:
 * any Chinese reads Traditional Chinese, anything else English.
 */
export function pickLang(choice, languages = []) {
  if (choice in LANGS) return choice
  for (const tag of languages) {
    const lower = String(tag).toLowerCase()
    if (lower.startsWith('zh')) return 'zh-Hant'
    if (lower.startsWith('en')) return 'en'
  }
  return 'en'
}

/** The language the page is in. */
export const lang = pickLang(stored('lang', 'auto'), globalThis.navigator?.languages ?? [])
let current = lang // the language t() writes in: the page's, or English inside inEnglish()

/**
 * `text` in the page's language, its `{name}` places filled from params. Without params the text
 * is taken as it is (a snippet's `${1:name}` and braces stay).
 */
export function t(text, params) {
  return translate(current, text, params)
}

/**
 * fn's result with t() writing English: for what an agent reads (a check's report through the
 * editor's MCP server or WebMCP), whatever the page's language. fn must not await: the language
 * is English only while it runs.
 */
export function inEnglish(fn) {
  const was = current
  current = 'en'
  try {
    return fn()
  } finally {
    current = was
  }
}

/** `text` in `language`: the catalog's translation, else the English text itself. */
export function translate(language, text, params) {
  const out = CATALOGS[language]?.[text] ?? text
  return params ? out.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m)) : out
}

/**
 * The page's static text in its language: an element's text (data-i18n), title (data-i18n-title)
 * and placeholder (data-i18n-placeholder) hold the English text to translate.
 */
export function translatePage(root = document) {
  root.documentElement?.setAttribute('lang', lang)
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle)
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder)
}

/** Items as a list in the page's language ("a, b" or 「a、b」). */
export const list = items => items.join(t(', '))
