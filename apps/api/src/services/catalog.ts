import { config } from '../lib/config.ts'
import { query, transaction } from '../lib/db.ts'
import { cloneOrUpdate, headCommit } from '../integrations/ado/index.ts'
import { parseInventories, type InventorySystem } from '../integrations/inventories/parse.ts'
import { ApiError } from '../lib/errors.ts'

export type SyncState = {
  startedAt: string | null
  finishedAt: string | null
  commit: string | null
  ok: boolean
  error: string | null
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

export type CatalogSystem = {
  id: string
  projectName: string
  company: string | null
  teams: Record<string, string>
  approvers: string[]
  managers: string[]
  applications: CatalogApplication[]
}

/**
 * Pulls the inventories repo and rebuilds the catalog from it.
 *
 * The rebuild is delete-then-insert inside one transaction. The catalog is
 * derived data, so there is nothing to preserve, and readers keep seeing the
 * previous contents until the commit lands.
 *
 * ponytail: fine at ~1100 rows. If this grows an order of magnitude, or the
 * sync starts running often enough that the write amplification matters, move
 * to upsert-and-prune keyed on id.
 */
export async function syncCatalog(): Promise<SyncState> {
  if (!config.INVENTORIES_PROJECT) {
    throw new ApiError(
      503,
      'inventories_not_configured',
      'INVENTORIES_PROJECT is not set, so there is no repository to read.',
    )
  }

  await query('update catalog_sync set started_at = now(), error = null where id = 1')

  try {
    const checkout = config.INVENTORIES_CHECKOUT
    await cloneOrUpdate(config.INVENTORIES_PROJECT, config.INVENTORIES_REPO, checkout)
    const commit = await headCommit(checkout)
    const systems = await parseInventories(checkout)

    if (systems.length === 0) {
      throw new ApiError(
        502,
        'inventories_empty',
        `No systems found in ${config.INVENTORIES_REPO}. The checkout may be empty or the layout may have changed.`,
      )
    }

    await writeCatalog(systems)
    await query(
      `update catalog_sync
          set finished_at = now(), commit_sha = $1, ok = true, error = null
        where id = 1`,
      [commit],
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await query(
      'update catalog_sync set finished_at = now(), ok = false, error = $1 where id = 1',
      [message],
    )
    throw err
  }

  return readSyncState()
}

export async function writeCatalog(systems: InventorySystem[]): Promise<void> {
  await transaction(async (client) => {
    // Applications cascade from systems, so one delete clears both.
    await client.query('delete from catalog_systems')

    for (const system of systems) {
      await client.query(
        `insert into catalog_systems
           (dir, project_name, company, teams, approvers, managers, ops_teams, policy)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          system.dir,
          system.projectName,
          system.company,
          JSON.stringify(system.teams),
          system.approvers,
          system.managers,
          system.opsTeams,
          JSON.stringify(system.policy),
        ],
      )

      for (const app of system.applications) {
        await client.query(
          `insert into catalog_applications
             (id, system_dir, group_name, name, environment, repository,
              build_technology, deploy_technology, deploy_platform, app_type,
              microservice, technologies, descriptor)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            `${system.dir}/${app.group}`,
            system.dir,
            app.group,
            app.name,
            app.environment,
            app.repository,
            app.buildTechnology,
            app.deployTechnology,
            app.deployPlatform,
            app.appType,
            app.microservice,
            app.technologies,
            JSON.stringify(app.descriptor),
          ],
        )
      }
    }
  })
}

export async function readSyncState(): Promise<SyncState> {
  const { rows } = await query<{
    started_at: Date | null
    finished_at: Date | null
    commit_sha: string | null
    ok: boolean
    error: string | null
  }>('select started_at, finished_at, commit_sha, ok, error from catalog_sync where id = 1')

  const row = rows[0]
  return {
    startedAt: row?.started_at?.toISOString() ?? null,
    finishedAt: row?.finished_at?.toISOString() ?? null,
    commit: row?.commit_sha ?? null,
    ok: row?.ok ?? false,
    error: row?.error ?? null,
  }
}

/**
 * The catalog as stored. Environment rows are folded into their base
 * application, so the caller sees one entry per application with the
 * environments it is deployed to.
 */
export async function readCatalog(): Promise<CatalogSystem[]> {
  const [systems, applications] = await Promise.all([
    query<{
      dir: string
      project_name: string
      company: string | null
      teams: Record<string, string>
      approvers: string[]
      managers: string[]
    }>('select dir, project_name, company, teams, approvers, managers from catalog_systems order by project_name'),
    query<{
      id: string
      system_dir: string
      group_name: string
      name: string
      environment: string | null
      repository: string | null
      build_technology: string | null
      deploy_technology: string | null
      deploy_platform: string | null
      app_type: string | null
      microservice: boolean | null
      technologies: string[]
    }>('select * from catalog_applications order by name, environment nulls first'),
  ])

  const bySystem = new Map<string, CatalogApplication[]>()
  for (const row of applications.rows) {
    const list = bySystem.get(row.system_dir) ?? []
    list.push({
      id: row.id,
      name: row.name,
      group: row.group_name,
      environment: row.environment,
      repository: row.repository,
      buildTechnology: row.build_technology,
      deployTechnology: row.deploy_technology,
      deployPlatform: row.deploy_platform,
      appType: row.app_type,
      microservice: row.microservice,
      technologies: row.technologies,
    })
    bySystem.set(row.system_dir, list)
  }

  return systems.rows.map((row) => ({
    id: row.dir,
    projectName: row.project_name,
    company: row.company,
    teams: row.teams ?? {},
    approvers: row.approvers ?? [],
    managers: row.managers ?? [],
    applications: bySystem.get(row.dir) ?? [],
  }))
}
