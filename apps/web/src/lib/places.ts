import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'

/**
 * Where someone was, so the way back lands there: a list page's last address
 * (tab, filters, search, page), the scroll position of every address, and the
 * item they opened last. Kept per browser tab (sessionStorage), so a new tab
 * starts fresh and two tabs do not move each other. A convenience: without
 * storage it holds for the visit, and without that the pages work as before.
 */

const PLACE = 'eidp.place.'
const SCROLL = 'eidp.scroll'
const OPENED = 'eidp.opened.'

const memory = new Map<string, string>()
function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key) ?? memory.get(key) ?? null
  } catch {
    return memory.get(key) ?? null
  }
}
function write(key: string, value: string): void {
  memory.set(key, value)
  try {
    sessionStorage.setItem(key, value)
  } catch {
    // A private window or blocked storage: memory holds it for this visit.
  }
}

/** Keeps this page's address (its search included) as the place to come back to. */
export function useRememberPlace(): void {
  const { pathname, search } = useLocation()
  useEffect(() => write(PLACE + pathname, pathname + search), [pathname, search])
}

/** The address someone last had on a page, or the page itself. */
export const placeFor = (pathname: string): string => read(PLACE + pathname) ?? pathname

/** Marks something as the one opened last, under a name the list knows it by. */
export function rememberOpened(list: string, id: string): void {
  write(OPENED + list, id)
}

export const lastOpened = (list: string): string | null => read(OPENED + list)

/** State a link carries to say: this is a way back — put the page where it was. */
export const BACK = { back: true } as const

function scrolls(): Record<string, number> {
  try {
    return JSON.parse(read(SCROLL) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

/**
 * Scroll as people expect between pages, which the declarative router does
 * not do: a new page opens at the top; Back, Forward and a way-back link
 * (state `BACK`) open where that address was left. Changing a page's own
 * filters (a replace on the same path) leaves the scroll alone. Positions are
 * kept by address; the page may still be loading, so the restore waits until
 * the page is tall enough, for up to two seconds.
 */
export function useScrollMemory(): void {
  const location = useLocation()
  const type = useNavigationType()
  const address = location.pathname + location.search

  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
  }, [])

  // Remember each address's position as it scrolls. The address is a ref, set
  // before a navigation scrolls anything, so the jump to the top of a new page
  // is never saved as the old page's position.
  const current = useRef(address)
  useEffect(() => {
    let frame = 0
    const save = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const here = current.current
        // The 50 addresses seen last are enough to go back through.
        const kept = Object.entries(scrolls()).filter(([key]) => key !== here).slice(-49)
        write(SCROLL, JSON.stringify(Object.fromEntries([...kept, [here, Math.round(window.scrollY)]])))
      })
    }
    window.addEventListener('scroll', save, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', save)
    }
  }, [])

  const back = type === 'POP' || (location.state as { back?: boolean } | null)?.back === true
  useLayoutEffect(() => {
    current.current = address
    if (!back) {
      if (type !== 'REPLACE') window.scrollTo(0, 0)
      return
    }
    const target = scrolls()[address]
    if (!target) return window.scrollTo(0, 0)
    const until = performance.now() + 2000
    let frame = 0
    // Someone scrolling while the page loads has taken over: stop putting it back.
    const stop = () => cancelAnimationFrame(frame)
    const events = ['wheel', 'touchstart', 'keydown'] as const
    events.forEach((e) => window.addEventListener(e, stop, { once: true, passive: true }))
    const attempt = () => {
      window.scrollTo(0, target)
      const reachable = document.documentElement.scrollHeight - window.innerHeight >= target
      if (!reachable && performance.now() < until) frame = requestAnimationFrame(attempt)
    }
    attempt()
    return () => {
      stop()
      events.forEach((e) => window.removeEventListener(e, stop))
    }
    // The path and search, not the location object: a page's own state updates do not move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, location.key])
}
