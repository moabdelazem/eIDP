import type { ProjectView } from '@eidp/contracts/projects'
import { Hono } from 'hono'
import { accessFrom, requireAuth, requirePermission, type AppEnv } from '../../middleware/auth.ts'
import { projectView } from './service.ts'

/** A project's page: its repositories with their pipelines, and who can work in it. */
export const projectRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/:system', requirePermission('catalog.view'), async (c) => c.json((await projectView(c.req.param('system'), await accessFrom(c))) satisfies ProjectView))
