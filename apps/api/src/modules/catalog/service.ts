import type { ApplicationDetail, CatalogApplication, CatalogSystem, SyncState } from '@eidp/contracts/catalog'
export type { ApplicationDetail, CatalogApplication, CatalogSystem, SyncState }
import { config } from '../../lib/config.ts'
import { asc, eq, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { db } from '../../lib/db.ts'
import { cloneOrUpdate, headCommit } from '../../integrations/ado/index.ts'
import { parseInventories, type InventorySystem } from '../../integrations/inventories/parse.ts'
import { ApiError } from '../../lib/errors.ts'
import { exclusive } from '../../lib/locks.ts'
import { log } from '../../lib/log.ts'
import { catalogApplications, catalogSync, catalogSystems } from './schema.ts'

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
let inFlight: Promise<SyncState> | null = null

/**
 * Pulls inventories and rebuilds the catalog. A sync already running is joined
 * rather than started twice — in this process or any other (`lib/locks.ts`):
 * the timer and a DevOps click can overlap, two fetches into one checkout
 * fight over git's lock, and two rebuilds would only do the same work.
 */
export function syncCatalog(): Promise<SyncState> {
  inFlight ??= exclusive('catalog-sync', runSync, finished).finally(() => {
    inFlight = null
  })
  return inFlight
}

/** Another process's sync, once it is done: its state, or its failure. */
async function finished(): Promise<SyncState> {
  const state = await readSyncState()
  if (!state.ok) throw new ApiError(502, 'catalog_sync_failed', state.error ?? 'The catalog sync failed.')
  return state
}

async function runSync(): Promise<SyncState> {
  if (!config.INVENTORIES_PROJECT) {
    throw new ApiError(
      503,
      'inventories_not_configured',
      'INVENTORIES_PROJECT is not set, so there is no repository to read.',
    )
  }

  // One row, id 1: the outcome of the last sync.
  const state = (set: PgUpdateSetSource<typeof catalogSync>) => db.update(catalogSync).set(set).where(eq(catalogSync.id, 1))
  await state({ startedAt: sql`now()`, error: null })

  try {
    const checkout = config.INVENTORIES_CHECKOUT
    await cloneOrUpdate(config.INVENTORIES_PROJECT, config.INVENTORIES_REPO, checkout)
    const commit = await headCommit(checkout)
    const { systems, warnings } = await parseInventories(checkout)
    if (warnings.length > 0) {
      log.warn('catalog sync skipped unreadable files', { count: warnings.length, files: warnings })
    }

    if (systems.length === 0) {
      throw new ApiError(
        502,
        'inventories_empty',
        `No systems found in ${config.INVENTORIES_REPO}. The checkout may be empty or the layout may have changed.`,
      )
    }

    await writeCatalog(systems)
    await state({ finishedAt: sql`now()`, commitSha: commit, ok: true, error: null, warnings })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await state({ finishedAt: sql`now()`, ok: false, error: message })
    throw err
  }

  return readSyncState()
}

export async function writeCatalog(systems: InventorySystem[]): Promise<void> {
  await db.transaction(async (tx) => {
    // Applications cascade from systems, so one delete clears both.
    await tx.delete(catalogSystems)
    for (const system of systems) {
      const { dir, projectName, company, teams, approvers, managers, opsTeams, policy } = system
      await tx.insert(catalogSystems).values({ dir, projectName, company, teams, approvers, managers, opsTeams, policy })
      if (system.applications.length === 0) continue
      await tx.insert(catalogApplications).values(
        system.applications.map((app) => ({
          id: `${system.dir}/${app.group}`,
          systemDir: system.dir,
          groupName: app.group,
          name: app.name,
          environment: app.environment,
          repository: app.repository,
          buildTechnology: app.buildTechnology,
          deployTechnology: app.deployTechnology,
          deployPlatform: app.deployPlatform,
          appType: app.appType,
          microservice: app.microservice,
          technologies: app.technologies,
          descriptor: app.descriptor,
        })),
      )
    }
  })
}

export async function readSyncState(): Promise<SyncState> {
  const [row] = await db.select().from(catalogSync).where(eq(catalogSync.id, 1))
  return {
    startedAt: row?.startedAt?.toISOString() ?? null,
    finishedAt: row?.finishedAt?.toISOString() ?? null,
    commit: row?.commitSha ?? null,
    ok: row?.ok ?? false,
    error: row?.error ?? null,
    warnings: row?.warnings ?? [],
  }
}

/** A stored application as the list shows it. */
const listed = (row: typeof catalogApplications.$inferSelect): CatalogApplication => ({
  id: row.id,
  name: row.name,
  group: row.groupName,
  environment: row.environment,
  repository: row.repository,
  buildTechnology: row.buildTechnology,
  deployTechnology: row.deployTechnology,
  deployPlatform: row.deployPlatform,
  appType: row.appType,
  microservice: row.microservice,
  technologies: row.technologies,
})

/**
 * One application's rows — the base and each environment override — with the
 * full configuration the list view leaves out. Base first, then environments.
 */
export async function readApplication(system: string, name: string): Promise<ApplicationDetail[]> {
  const rows = await db
    .select()
    .from(catalogApplications)
    .where(sql`${catalogApplications.systemDir} = ${system} and ${catalogApplications.name} = ${name}`)
    .orderBy(sql`${catalogApplications.environment} nulls first`)
  return rows.map((row) => ({ ...listed(row), descriptor: row.descriptor ?? {} }))
}

/**
 * The catalog as stored. Environment rows are folded into their base
 * application, so the caller sees one entry per application with the
 * environments it is deployed to.
 */
export async function readCatalog(): Promise<CatalogSystem[]> {
  const [systems, applications] = await Promise.all([
    db.select().from(catalogSystems).orderBy(asc(catalogSystems.projectName)),
    db.select().from(catalogApplications).orderBy(asc(catalogApplications.name), sql`${catalogApplications.environment} nulls first`),
  ])

  const bySystem = new Map<string, CatalogApplication[]>()
  for (const row of applications) {
    const list = bySystem.get(row.systemDir) ?? []
    list.push(listed(row))
    bySystem.set(row.systemDir, list)
  }

  return systems.map((row) => ({
    id: row.dir,
    projectName: row.projectName,
    company: row.company,
    teams: row.teams ?? {},
    approvers: row.approvers ?? [],
    managers: row.managers ?? [],
    applications: bySystem.get(row.dir) ?? [],
  }))
}
