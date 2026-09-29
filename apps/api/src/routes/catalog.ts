import { Hono } from 'hono'
import { ApiError } from '../lib/errors.ts'
import { requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
import { readApplication, readCatalog, readSyncState, syncCatalog } from '../services/catalog.ts'

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
   */
  .get('/', async (c) => {
    const [systems, sync] = await Promise.all([readCatalog(), readSyncState()])

    if (systems.length === 0) {
      throw new ApiError(
        503,
        'catalog_unavailable',
        sync.error
          ? `The projects map could not be built: ${sync.error}`
          : 'The projects map has not been built yet. Run a sync once Azure DevOps is configured.',
      )
    }

    return c.json({ systems, sync })
  })

  .get('/status', async (c) => c.json(await readSyncState()))

  /** One application's full configuration, base and per environment. */
  .get('/systems/:system/applications/:name', async (c) => {
    const rows = await readApplication(c.req.param('system'), c.req.param('name'))
    if (rows.length === 0) {
      throw new ApiError(404, 'application_not_found', 'There is no such application in the catalog.')
    }
    return c.json(rows)
  })

  // A sync clones from Azure DevOps with the service account's token and
  // rewrites the catalog, so it is DevOps's to trigger, not everyone's.
  .post('/sync', requirePermission('catalog.sync'), async (c) => c.json(await syncCatalog()))
