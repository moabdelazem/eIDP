import { Hono } from 'hono'
import { requireAuth, requirePermission, type AppEnv } from '../../middleware/auth.ts'
import { serverInfo } from '../../integrations/jira/index.ts'

/** What the Jira request form needs: which server, and that it answers at all. */
export const jiraRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  // Only the request forms read this.
  .use('*', requirePermission('requests.create'))

  .get('/', async (c) => c.json(await serverInfo()))
