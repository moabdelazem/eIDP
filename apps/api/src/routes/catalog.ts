import { Hono } from 'hono'
import { ApiError } from '../lib/errors.ts'
import { requireAuth, requireDevOps, type AppEnv } from '../middleware/auth.ts'
import { readCatalog, readSyncState, syncCatalog } from '../services/catalog.ts'

export const catalogRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

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
          ? `The project map could not be built: ${sync.error}`
          : 'The project map has not been built yet. Run a sync once Azure DevOps is configured.',
      )
    }

    return c.json({ systems, sync })
  })

  .get('/status', async (c) => c.json(await readSyncState()))

  // A sync clones from Azure DevOps with the service account's token and
  // rewrites the catalog, so it is DevOps's to trigger, not everyone's.
  .post('/sync', requireDevOps, async (c) => c.json(await syncCatalog()))
