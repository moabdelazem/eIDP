import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate.ts'
import { accessFrom, requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
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
  z.object({
    kind: z.literal('create_jira_project'),
    // The project's name; its key is what issues are numbered with.
    project: z.string().max(256),
    projectKey: z.string().max(256),
    description: z.string().max(4000).optional(),
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

/** Everyone who may decide at least one request: DevOps hold it everywhere. */
const decider = requirePermission('requests.decide_access', { scoped: true })

export const requestRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

  /** The form's live check: the same rules `POST /` enforces. */
  .post('/check', requirePermission('requests.create'), validate('json', Target), async (c) => c.json(await requests.check(c.req.valid('json'))))

  .post('/', requirePermission('requests.create'), validate('json', NewRequest), async (c) => {
    const request = await requests.submit(c.req.valid('json'), actor(c))
    return c.json(request, 201)
  })

  .get('/mine', async (c) => c.json(await requests.listMine(actor(c).uid)))

  // ---- deciding ---------------------------------------------------------
  // Reachable by anyone who may decide something — DevOps everywhere, a team
  // lead within their teams. Which requests is the service's call.

  .get('/pool', decider, async (c) => c.json(await requests.listPool(await accessFrom(c))))

  .get('/history', decider, async (c) => c.json(await requests.listHistory(await accessFrom(c))))

  .post('/:id/approve', decider, validate('json', Decision), async (c) =>
    c.json(await requests.approve(c.req.param('id'), actor(c), await accessFrom(c), c.req.valid('json').note)),
  )

  .post('/:id/reject', decider, validate('json', Decision), async (c) =>
    c.json(await requests.reject(c.req.param('id'), actor(c), await accessFrom(c), c.req.valid('json').note ?? '')),
  )

  /** Assess again: the directory and the catalog may have moved on since it was filed. */
  .post('/:id/assess', decider, async (c) => c.json(await requests.reassess(c.req.param('id'), await accessFrom(c))))

  .post('/:id/retry', decider, async (c) => c.json(await requests.retry(c.req.param('id'), await accessFrom(c))))

  // ---- the requester's own, or DevOps ------------------------------------

  .get('/:id', async (c) => c.json(await requests.get(c.req.param('id'), actor(c), await accessFrom(c))))

  .post('/:id/cancel', async (c) => c.json(await requests.cancel(c.req.param('id'), actor(c))))

function actor(c: { get: (key: 'jwtPayload') => { sub: string; name: string } }) {
  const claims = c.get('jwtPayload')
  return { uid: claims.sub, name: claims.name }
}
