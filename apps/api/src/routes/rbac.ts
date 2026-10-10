import type { Catalogue, Permission } from '@eidp/contracts/rbac'
import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate.ts'
import { requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
import * as rbac from '../services/rbac.ts'

const NewBinding = z.object({
  subjectType: z.enum(['group', 'user']),
  subject: z.string().max(256),
  role: z.string().max(64),
  scopeType: z.enum(['global', 'team', 'project']),
  scope: z.string().max(256).nullish(),
  reason: z.string().max(2000).nullish(),
  expiresAt: z.string().max(64).nullish(),
})

/** Who may do what — the admin page's API. Everything here needs `rbac.manage`. */
export const rbacRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .use('*', requirePermission('rbac.manage'))

  /** Roles and permissions are code; listed so the page can explain them. */
  .get('/roles', (c) =>
    c.json({
      permissions: (Object.entries(rbac.PERMISSIONS) as [Permission, string][]).map(([id, description]) => ({ id, description })),
      roles: Object.entries(rbac.ROLES).map(([id, role]) => ({ id, ...role })),
    } satisfies Catalogue),
  )

  .get('/bindings', async (c) => c.json(await rbac.listBindings()))

  .post('/bindings', validate('json', NewBinding), async (c) =>
    c.json(await rbac.addBinding(c.req.valid('json'), c.get('jwtPayload').sub), 201),
  )

  /** A binding's reason and expiry; the rest of it is what was granted, and stays. */
  .patch(
    '/bindings/:id',
    validate('json', z.object({ reason: z.string().max(2000).nullish(), expiresAt: z.string().max(64).nullish() })),
    async (c) => c.json(await rbac.updateBinding(c.req.param('id'), c.req.valid('json'), c.get('jwtPayload').sub)),
  )

  /** Teams, projects and groups the grant form can offer as someone types. */
  .get('/suggestions', async (c) => c.json(await rbac.suggestions()))

  .delete('/bindings/:id', async (c) => {
    await rbac.removeBinding(c.req.param('id'), c.get('jwtPayload').sub)
    return c.body(null, 204)
  })

  /** "Why can bob approve?" — groups, bindings and every permission with what grants it. */
  .get('/explain/:uid', async (c) => c.json(await rbac.explain(c.req.param('uid'))))

  .get('/audit', async (c) => c.json(await rbac.listAudit()))
