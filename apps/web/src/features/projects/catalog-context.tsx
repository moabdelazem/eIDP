import { createContext, use, useMemo, type ReactNode } from 'react'
import { useResource } from '@/lib/use-resource.ts'
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

/**
 * Loads the catalog once for everything under it — map, detail and
 * breadcrumbs — through the shared cache (`['catalog']`), so anything else
 * that asks for it reads the same answer. A reload keeps the map on screen
 * while the new one comes.
 */
export function CatalogProvider({ children }: { children: ReactNode }) {
  const catalog = useResource(['catalog'], fetchCatalog)
  const value = useMemo<CatalogValue>(
    () => ({
      status: catalog.data ? 'ready' : catalog.error ? 'error' : 'loading',
      systems: catalog.data?.systems ?? [],
      sync: catalog.data?.sync ?? null,
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
