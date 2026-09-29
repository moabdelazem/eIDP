import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate.ts'
import { requireAuth, requireDevOps, type AppEnv } from '../middleware/auth.ts'
import * as requests from '../services/requests.ts'

const Target = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create_repository'),
    collection: z.string().min(1),
    project: z.string().min(1),
    repository: z.string(),
  }),
  z.object({
    kind: z.literal('create_project'),
    collection: z.string().min(1),
    project: z.string(),
    description: z.string().max(4000).optional(),
  }),
  z.object({
    kind: z.literal('grant_access'),
    collection: z.string().min(1),
    project: z.string().min(1),
    // Always the whole project, always Contribute — neither is the
    // requester's choice, so neither is accepted.
    grantees: z.array(z.string().max(256)).max(100),
  }),
])

const NewRequest = z.intersection(
  Target,
  z.object({
    justification: z.string().max(4000),
    // The requester's team, granted access with them. Checked against their
    // groups in the directory by the service.
    // Creations only: checked against the requester's groups by the service.
    teamGroup: z.string().min(1, 'Choose your team.').max(256).optional(),
  }),
)

const Decision = z.object({ note: z.string().max(4000).optional() })

export const requestRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

  /** The form's live check: the same rules `POST /` enforces. */
  .post('/check', validate('json', Target), async (c) => c.json(await requests.check(c.req.valid('json'))))

  .post('/', validate('json', NewRequest), async (c) => {
    const request = await requests.submit(c.req.valid('json'), actor(c))
    return c.json(request, 201)
  })

  .get('/mine', async (c) => c.json(await requests.listMine(actor(c).uid)))

  // ---- DevOps only ------------------------------------------------------

  .get('/pool', requireDevOps, async (c) => c.json(await requests.listPool()))

  .post('/:id/approve', requireDevOps, validate('json', Decision), async (c) =>
    c.json(await requests.approve(c.req.param('id'), actor(c), c.req.valid('json').note)),
  )

  .post('/:id/reject', requireDevOps, validate('json', Decision), async (c) =>
    c.json(await requests.reject(c.req.param('id'), actor(c), c.req.valid('json').note ?? '')),
  )

  .post('/:id/retry', requireDevOps, async (c) =>
    c.json(await requests.retry(c.req.param('id'), actor(c))),
  )

  // ---- the requester's own, or DevOps ------------------------------------

  .get('/:id', async (c) => c.json(await requests.get(c.req.param('id'), actor(c))))

  .post('/:id/cancel', async (c) => c.json(await requests.cancel(c.req.param('id'), actor(c))))

function actor(c: { get: (key: 'jwtPayload') => { sub: string; name: string } }) {
  const claims = c.get('jwtPayload')
  return { uid: claims.sub, name: claims.name }
}
