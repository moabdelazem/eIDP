import type { CatalogResponse } from '@eidp/contracts/catalog'
import { Hono } from 'hono'
import { etag } from 'hono/etag'
import { ApiError } from '../../lib/errors.ts'
import { accessFrom, requireAuth, requirePermission, type AppEnv } from '../../middleware/auth.ts'
import { catalogReach } from '../access/index.ts'
import { readApplication, readCatalog, readSystem, readSyncState, syncCatalog } from './service.ts'

export const catalogRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  // Sync carries its own, stronger guard below; reading needs this one.
  .use('*', async (c, next) => (c.req.method === 'GET' ? requirePermission('catalog.view')(c, next) : next()))

  /**
   * The catalog, with the state of the last sync beside it.
   *
   * Stale data still gets served: knowing the map is from this morning beats
   * an error page. Only an empty catalog is a failure, and then the message
   * says why the last attempt failed rather than just that there is nothing.
   *
   * Each person gets the projects their teams own (`catalogReach`), not the
   * whole map; `catalog.view_all` gets every one.
   */
  .get('/', etag(), async (c) => {
    // The catalog changes when a sync lands, not every time the map asks: the browser
    // revalidates with the ETag, and an unchanged catalog comes back as a 304 with no body.
    c.header('Cache-Control', 'private, no-cache')
    const [systems, sync, access] = await Promise.all([readCatalog(), readSyncState(), accessFrom(c)])

    if (systems.length === 0) {
      throw new ApiError(
        503,
        'catalog_unavailable',
        sync.error
          ? `The projects map could not be built: ${sync.error}`
          : 'The projects map has not been built yet. Run a sync once Azure DevOps is configured.',
      )
    }

    const reach = catalogReach(access)
    const shown = systems.filter((s) => reach.sees({ project: s.projectName, ...s }))
    return c.json({ systems: shown, sync, scope: { all: reach.all, total: systems.length } } satisfies CatalogResponse)
  })

  .get('/status', async (c) => c.json(await readSyncState()))

  /** One application's full configuration, base and per environment. */
  .get('/systems/:system/applications/:name', async (c) => {
    const [system, access] = await Promise.all([readSystem(c.req.param('system')), accessFrom(c)])
    // Someone else's project answers as one that does not exist: its name is not theirs to confirm.
    const rows = system && catalogReach(access).sees(system) ? await readApplication(system.dir, c.req.param('name')) : []
    if (rows.length === 0) {
      throw new ApiError(404, 'application_not_found', 'There is no such application in the catalog.')
    }
    return c.json(rows)
  })

  // A sync clones from Azure DevOps with the service account's token and
  // rewrites the catalog, so it is DevOps's to trigger, not everyone's.
  .post('/sync', requirePermission('catalog.sync'), async (c) => c.json(await syncCatalog()))
