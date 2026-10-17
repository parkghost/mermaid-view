// The diagram themes and looks the page offers: mermaid's own, as the Mermaid Live Editor lists
// them (mermaid 12). A dark theme gets a dark canvas behind it.

import { t } from './i18n.js'
export const THEMES = {
  auto: t('Automatic (follows the system)'),
  neo: 'Neo',
  'neo-dark': 'Neo Dark',
  redux: 'Redux',
  'redux-dark': 'Redux Dark',
  'redux-color': 'Redux Color',
  'redux-dark-color': 'Redux Dark Color',
  default: 'Default',
  neutral: 'Neutral',
  forest: 'Forest',
  dark: 'Dark',
}

export const LOOKS = {
  classic: t('Classic'),
  neo: 'Neo',
  handDrawn: t('Hand-drawn'),
}

/** mermaid's theme for a choice: `auto` follows the system's color scheme; unknown names, `auto`. */
export function themeName(choice, systemDark) {
  if (choice in THEMES && choice !== 'auto') return choice
  return systemDark ? 'neo-dark' : 'neo'
}

// The layout engines. Mermaid 12 bundles ELK and lays out with it unless told otherwise;
// dagre, its former default, spreads a large top-down flowchart wider, so it is ours. Tidy tree
// (a mind map grown both ways from its root) is Mermaid's separate package, which app.js loads.
export const LAYOUTS = {
  dagre: t('Dagre (wider)'),
  elk: 'ELK',
  'tidy-tree': 'Tidy tree',
}

export const isDarkTheme = name => name.includes('dark')

export const layoutName = choice => (choice in LAYOUTS ? choice : 'dagre')

export const lookName = choice => (choice in LOOKS ? choice : 'classic')

/**
 * The look and layout a diagram of a type (its descriptor) is drawn with: the chosen ones where
 * the type takes them, else classic and dagre, which every type takes (ELK fails a mind map).
 * `declined` names the chosen ones the type does not take, for the card to say so.
 */
export function fitTo(desc, look, layout) {
  const lookTaken = look === 'classic' || (desc.looks ?? []).includes(look)
  const layoutTaken = layout === 'dagre' || (desc.layouts ?? []).includes(layout)
  return {
    look: lookTaken ? look : 'classic',
    layout: layoutTaken ? layout : 'dagre',
    declined: [...(lookTaken ? [] : [LOOKS[look]]), ...(layoutTaken ? [] : [LAYOUTS[layout]])],
  }
}

/** The names of the types (descriptors) that take a look or layout: all of them for classic and dagre. */
export const takers = (types, look, layout) =>
  types.filter(d => fitTo(d, look ?? 'classic', layout ?? 'dagre').declined.length === 0).map(d => d.name)
