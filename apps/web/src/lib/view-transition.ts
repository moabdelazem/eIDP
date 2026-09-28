import { flushSync } from 'react-dom'

/**
 * Runs a state update inside a View Transition, so the browser animates the
 * change — a removed card fades while the ones below slide up — with no
 * animation library: this is a native browser API.
 *
 * Falls back to a plain update where the API is missing, and skips the
 * animation for anyone who asked their system for reduced motion.
 */
export function withViewTransition(update: () => void): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced || typeof document.startViewTransition !== 'function') {
    update()
    return
  }
  // flushSync so React commits inside the transition's callback; otherwise
  // the "after" snapshot is taken before the DOM has changed.
  document.startViewTransition(() => flushSync(update))
}
