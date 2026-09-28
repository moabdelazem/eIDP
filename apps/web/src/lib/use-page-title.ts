import { useEffect } from 'react'

/**
 * Names the browser tab after the page. With every tab called "e-IDP", three
 * open requests and the map are indistinguishable, and so is the history list.
 * The most specific part goes first so it survives a narrow tab.
 */
export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} — e-IDP` : 'e-IDP'
  }, [title])
}
