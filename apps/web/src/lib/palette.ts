import { useSyncExternalStore } from 'react'

/**
 * The portal's colours, chosen per person beside light and dark:
 *
 * - `classic` (the default) — the eggplant and crimson the portal started with;
 * - `efinance` — the e-finance mark's navy and red, on white.
 *
 * Both are token sets in `index.css`; e-finance is `data-palette="efinance"`
 * on <html>, which outranks Classic's `:root` and `.dark`. The choice is kept
 * in this browser (`eidp.palette`) so the first paint is right, and with the
 * person's account (`lib/appearance.ts`) so it follows them to any browser.
 * index.html's script sets it before the first paint; `applyStoredPalette`
 * sets it again as the app starts, so it holds even where that inline script
 * is not run.
 */
export const PALETTES = ['classic', 'efinance'] as const
export type Palette = (typeof PALETTES)[number]

const KEY = 'eidp.palette'
/** The browser chrome's colour on a phone, per palette. */
const THEME_COLOR: Record<Palette, string> = { classic: '#2a1930', efinance: '#003366' }

const listeners = new Set<() => void>()

/** What this browser last chose. Anything but e-finance — nothing, or the old 'classic' — is the default. */
export function storedPalette(): Palette {
  try {
    return localStorage.getItem(KEY) === 'efinance' ? 'efinance' : 'classic'
  } catch {
    return 'classic' // storage refused (a private window)
  }
}

function apply(next: Palette) {
  const html = document.documentElement
  if (next === 'efinance') html.dataset.palette = 'efinance'
  else delete html.dataset.palette
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[next])
}

/** As the app starts: the stored palette, whether or not index.html's script ran. */
export function applyStoredPalette() {
  apply(storedPalette())
}

export function setPalette(next: Palette) {
  try {
    if (next === 'classic') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
    // Storage refused (a private window): the choice still holds for this page.
  }
  apply(next)
  for (const listener of listeners) listener()
}

/** The palette in use, following a change made anywhere in this tab. */
export function usePalette(): Palette {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // <html> is the truth: set from storage before React ran, and kept by setPalette.
    () => (document.documentElement.dataset.palette === 'efinance' ? 'efinance' : 'classic'),
  )
}
