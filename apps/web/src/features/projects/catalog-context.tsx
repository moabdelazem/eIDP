import { createContext, use, useMemo, type ReactNode } from 'react'
import { useResource } from '@/lib/use-resource.ts'
import type { System } from './catalog.ts'
import { fetchCatalog, type CatalogScope, type SyncState } from './api.ts'

type CatalogValue = {
  status: 'loading' | 'ready' | 'error'
  systems: System[]
  sync: SyncState | null
  /** Whether these are every project or only the caller's teams', and how many there are in all. */
  scope: CatalogScope | null
  /** Set when the catalog could not be loaded; already fit to show. */
  error: string | null
  reload: () => void
}

const CatalogContext = createContext<CatalogValue | null>(null)

/**
 * Loads the catalog once for everything under it — map, detail and
 * breadcrumbs — through the shared cache (`['catalog']`), so anything else
 * that asks for it reads the same answer. A reload keeps the map on screen
 * while the new one comes.
 */
export function CatalogProvider({ children }: { children: ReactNode }) {
  // The catalog changes when a sync lands — minutes apart — so a minute fresh; past that the API answers an unchanged one with a 304 (ETag).
  const catalog = useResource(['catalog'], fetchCatalog, { staleMs: 60_000 })
  const value = useMemo<CatalogValue>(
    () => ({
      status: catalog.data ? 'ready' : catalog.error ? 'error' : 'loading',
      systems: catalog.data?.systems ?? [],
      sync: catalog.data?.sync ?? null,
      scope: catalog.data?.scope ?? null,
      error: catalog.data ? null : catalog.error,
      reload: catalog.reload,
    }),
    [catalog.data, catalog.error, catalog.reload],
  )
  return <CatalogContext value={value}>{children}</CatalogContext>
}

export function useCatalog(): CatalogValue {
  const value = use(CatalogContext)
  if (!value) throw new Error('useCatalog must be used inside <CatalogProvider>')
  return value
}
