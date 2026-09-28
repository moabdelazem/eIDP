import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError } from '@/lib/api-client.ts'
import type { System } from './catalog.ts'
import { fetchCatalog, type SyncState } from './api.ts'

type CatalogValue = {
  status: 'loading' | 'ready' | 'error'
  systems: System[]
  sync: SyncState | null
  /** Set when the catalog could not be loaded; already fit to show. */
  error: string | null
  reload: () => void
}

const CatalogContext = createContext<CatalogValue | null>(null)

/** Loads the catalog once for everything under it — map, detail and breadcrumbs. */
export function CatalogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<CatalogValue, 'reload'>>({
    status: 'loading',
    systems: [],
    sync: null,
    error: null,
  })

  const load = useCallback(() => {
    let cancelled = false
    setState((current) => ({ ...current, status: 'loading', error: null }))

    fetchCatalog()
      .then(({ systems, sync }) => {
        if (!cancelled) setState({ status: 'ready', systems, sync, error: null })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          systems: [],
          sync: null,
          error:
            err instanceof ApiError
              ? err.message
              : 'Something went wrong while loading the projects map.',
        })
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(load, [load])

  const value = useMemo(() => ({ ...state, reload: load }), [state, load])
  return <CatalogContext value={value}>{children}</CatalogContext>
}

export function useCatalog(): CatalogValue {
  const value = use(CatalogContext)
  if (!value) throw new Error('useCatalog must be used inside <CatalogProvider>')
  return value
}
