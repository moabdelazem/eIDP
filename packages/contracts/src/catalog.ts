/** The catalog: what `/catalog` sends (apps/api services/catalog.ts). One row per application per environment variant; the map folds them. */

/** The last sync of the inventories repo, so the page can tell current from stale from never-built. */
export type SyncState = {
  startedAt: string | null
  finishedAt: string | null
  commit: string | null
  ok: boolean
  error: string | null
  /** Files the last sync skipped because they could not be read. */
  warnings: string[]
}

export type CatalogApplication = {
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

/** One application in one environment, with its full merged configuration. */
export type ApplicationDetail = CatalogApplication & {
  /** Every group_vars file of the app merged as Ansible merges them; secrets hidden. */
  descriptor: Record<string, unknown>
}

export type CatalogSystem = {
  id: string
  projectName: string
  company: string | null
  teams: Record<string, string>
  approvers: string[]
  managers: string[]
  applications: CatalogApplication[]
}

/** `GET /catalog`. */
export type CatalogResponse = { systems: CatalogSystem[]; sync: SyncState }
