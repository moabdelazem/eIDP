import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate.ts'
import { requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
import * as jenkins from '../services/jenkins.ts'

// A job's full name carries its folders ("payments/loan-api"), so it travels
// as a value rather than as path segments.
const BuildRef = z.object({ job: z.string().min(1).max(1024), number: z.coerce.number().int().positive() })

/** The Jenkins page's API. Reading needs `jenkins.view`; acting, `jenkins.operate`. */
export const jenkinsRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

  .get('/', requirePermission('jenkins.view'), async (c) =>
    c.json(await jenkins.overview({ fresh: c.req.query('fresh') === '1' })),
  )

  .get('/run', requirePermission('jenkins.view'), validate('query', BuildRef), async (c) => {
    const { job, number } = c.req.valid('query')
    return c.json(await jenkins.run(job, number))
  })

  .get('/audit', requirePermission('jenkins.view'), async (c) => c.json(await jenkins.listAudit()))

  .post('/rebuild', requirePermission('jenkins.operate'), validate('json', BuildRef), async (c) => {
    const { job, number } = c.req.valid('json')
    return c.json(await jenkins.rebuild(job, number, actor(c)), 202)
  })

  .post('/stop', requirePermission('jenkins.operate'), validate('json', BuildRef), async (c) => {
    const { job, number } = c.req.valid('json')
    await jenkins.stop(job, number, actor(c))
    return c.json({ ok: true }, 202)
  })

  .post('/queue/:id/cancel', requirePermission('jenkins.operate'), async (c) => {
    await jenkins.cancel(Number(c.req.param('id')) || 0, actor(c))
    return c.json({ ok: true })
  })

function actor(c: { get: (key: 'jwtPayload') => { sub: string; name: string } }) {
  const claims = c.get('jwtPayload')
  return { uid: claims.sub, name: claims.name }
}
