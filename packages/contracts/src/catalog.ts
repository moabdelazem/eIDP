/** The catalog: what `/catalog` sends (apps/api modules/catalog/service.ts). One row per application per environment variant; the map folds them. */

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
  /** `ops_team_list`: the teams that operate it. */
  opsTeams: string[]
  applications: CatalogApplication[]
}

/**
 * Which part of the catalog the caller sees. Someone sees the projects their
 * teams own (`all: false`); `catalog.view_all` sees every one. `total` is how
 * many there are in all, so the map can say "4 of 207".
 */
export type CatalogScope = { all: boolean; total: number }

/** `GET /catalog`: the systems the caller sees. */
export type CatalogResponse = { systems: CatalogSystem[]; sync: SyncState; scope: CatalogScope }
