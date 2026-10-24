import type { Appearance, AppearancePreference, ThemeChoice } from '@eidp/contracts/preferences'
import { api } from './api-client.ts'

export type { Appearance, ThemeChoice } from '@eidp/contracts/preferences'

/**
 * The theme and colours, kept with the person's account (`/preferences/appearance`)
 * as well as in the browser: the browser's copy paints the first frame right;
 * the account's makes the choice follow them to another browser or machine,
 * and survive cleared site data. `app/appearance-sync.tsx` reads it after
 * sign-in; the user menu saves it on every change.
 */

const THEME_KEY = 'eidp.theme'

/** What next-themes keeps in this browser, read before React has it. */
export function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function fetchAppearance(): Promise<AppearancePreference> {
  return api<AppearancePreference>('/preferences/appearance')
}

/**
 * Saves the choice with the account. Never in the way: the browser already
 * holds it, so a failure (offline, or viewing as someone, which is read-only)
 * costs only the other browsers.
 */
export function rememberAppearance(appearance: Appearance): void {
  void api<AppearancePreference>('/preferences/appearance', { method: 'PUT', body: JSON.stringify(appearance) }).catch(() => {})
}
