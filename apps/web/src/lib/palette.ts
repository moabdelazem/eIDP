import { useSyncExternalStore } from 'react'

/**
 * The portal's colours, chosen per browser beside light and dark:
 *
 * - `efinance` (the default) — the e-finance mark's navy and red;
 * - `classic` — the eggplant and crimson the portal started with.
 *
 * Both are token sets in `index.css`; `classic` is `data-palette="classic"`
 * on <html>, which outranks the default's `:root` and `.dark`. The choice is
 * kept in `eidp.palette`, and index.html's script sets it before the first
 * paint, as it does the theme, so a page never flashes the other colours.
 */
export const PALETTES = ['efinance', 'classic'] as const
export type Palette = (typeof PALETTES)[number]

const KEY = 'eidp.palette'
/** The browser chrome's colour on a phone, per palette — the rail's. */
const THEME_COLOR: Record<Palette, string> = { efinance: '#002e6d', classic: '#2a1930' }

const listeners = new Set<() => void>()

export function setPalette(next: Palette) {
  try {
    if (next === 'efinance') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
    // Storage refused (a private window): the choice still holds for this page.
  }
  const html = document.documentElement
  if (next === 'efinance') delete html.dataset.palette
  else html.dataset.palette = next
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[next])
  for (const listener of listeners) listener()
}

/** The palette in use, following a change made anywhere in this tab. */
export function usePalette(): Palette {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // <html> is the truth: index.html's script set it from storage before React ran, and setPalette keeps it.
    () => (document.documentElement.dataset.palette === 'classic' ? 'classic' : 'efinance'),
  )
}
