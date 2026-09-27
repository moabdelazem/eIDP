import { api } from '@/lib/api-client.ts'
import type { System } from './catalog.ts'

export type SyncState = {
  startedAt: string | null
  finishedAt: string | null
  commit: string | null
  ok: boolean
  error: string | null
}

type CatalogResponse = {
  systems: ApiSystem[]
  sync: SyncState
}

/** The API keeps one row per environment variant; the UI wants one per app. */
type ApiApplication = {
  id: string
  name: string
  group: string
  environment: string | null
  repository: string | null
  buildTechnology: string | null
  deployTechnology: string | null
  deployPlatform: string | null
  appType: string | null
  microservice: boolean | null
  technologies: string[]
}

type ApiSystem = {
  id: string
  projectName: string
  company: string | null
  teams: Record<string, string>
  approvers: string[]
  managers: string[]
  applications: ApiApplication[]
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
function foldEnvironments(system: ApiSystem): System {
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
    teams: system.teams as System['teams'],
    applications: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  }
}
