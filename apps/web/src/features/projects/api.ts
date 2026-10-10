import { api } from '@/lib/api-client.ts'
import type { System } from './catalog.ts'

// The JSON's shapes are the API's, from @eidp/contracts — one definition, so the two cannot drift.
import type { ApplicationDetail, CatalogResponse, CatalogSystem, SyncState } from '@eidp/contracts/catalog'
export type { SyncState } from '@eidp/contracts/catalog'
/** One row of an application — the base, or one environment's override — with its merged configuration. */
export type ApplicationConfig = ApplicationDetail

export function fetchApplication(system: string, name: string): Promise<ApplicationConfig[]> {
  return api<ApplicationConfig[]>(
    `/catalog/systems/${encodeURIComponent(system)}/applications/${encodeURIComponent(name)}`,
  )
}

/** Pulls inventories and rebuilds the catalog now. Needs `catalog.sync`. */
export function syncCatalog(): Promise<SyncState> {
  return api<SyncState>('/catalog/sync', { method: 'POST' })
}

export async function fetchCatalog(): Promise<{ systems: System[]; sync: SyncState }> {
  const body = await api<CatalogResponse>('/catalog')
  return { systems: body.systems.map(foldEnvironments), sync: body.sync }
}

/**
 * Collapses `nfp-backend`, `dev_nfp-backend`, `prd_nfp-backend` into one
 * application carrying the environments it was found in. The unprefixed row is
 * the base, so it supplies the details when a variant leaves a field blank.
 */
function foldEnvironments(system: CatalogSystem): System {
  const byName = new Map<string, System['applications'][number]>()

  for (const row of system.applications) {
    const existing = byName.get(row.name)
    if (!existing) {
      byName.set(row.name, {
        id: row.name,
        name: row.name,
        repository: row.repository,
        buildTechnology: row.buildTechnology,
        deployPlatform: row.deployPlatform,
        microservice: row.microservice,
        environments: row.environment ? [row.environment as never] : [],
      })
      continue
    }
    if (row.environment && !existing.environments.includes(row.environment as never)) {
      existing.environments.push(row.environment as never)
    }
    // A base row carries the fullest description; let it fill any gaps.
    existing.repository ??= row.repository
    existing.buildTechnology ??= row.buildTechnology
    existing.deployPlatform ??= row.deployPlatform
    existing.microservice ??= row.microservice
  }

  return {
    id: system.id,
    projectName: system.projectName,
    company: system.company,
    teams: system.teams,
    applications: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  }
}
