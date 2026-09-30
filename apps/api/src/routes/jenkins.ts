import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate.ts'
import { requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
import * as jenkins from '../services/jenkins.ts'
import { syncJenkins } from '../services/jenkins-sync.ts'
import * as explainer from '../services/build-explainer.ts'
import { ollamaConfig } from '../integrations/ollama/index.ts'

// A job's full name carries its folders ("payments/loan-api"), so it travels
// as a value rather than as path segments.
const BuildRef = z.object({ job: z.string().min(1).max(1024), number: z.coerce.number().int().positive() })
const Window = z.object({ window: z.enum(['24h', '7d']).default('24h') })
const RESULTS = ['success', 'failure', 'unstable', 'aborted', 'not_built', 'running'] as const
const RunFilter = Window.extend({
  q: z.string().max(500).optional(),
  result: z.enum(RESULTS).optional(),
  job: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(jenkins.PAGE_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
})

/** The Jenkins page's API. Reading needs `jenkins.view`; acting, `jenkins.operate`. */
export const jenkinsRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

  .get('/', requirePermission('jenkins.view'), async (c) =>
    c.json(await jenkins.overview({ fresh: c.req.query('fresh') === '1' })),
  )

  .get('/stats', requirePermission('jenkins.view'), validate('query', Window), async (c) =>
    c.json(await jenkins.stats(c.req.valid('query').window)),
  )

  .get('/runs', requirePermission('jenkins.view'), validate('query', RunFilter), async (c) => c.json(await jenkins.runs(c.req.valid('query'))))

  .get('/parameters', requirePermission('jenkins.view'), validate('query', Window), async (c) =>
    c.json(await jenkins.parameters(c.req.valid('query').window)),
  )

  .get('/run', requirePermission('jenkins.view'), validate('query', BuildRef), async (c) => {
    const { job, number } = c.req.valid('query')
    return c.json(await jenkins.run(job, number))
  })

  // "What went wrong?" — the kept explanation, and whether the AI is there to
  // make one. Seeing the build is not enough: asking the model is `ai.use`.
  .get('/explain', requirePermission('jenkins.view'), requirePermission('ai.use'), validate('query', BuildRef), async (c) => {
    const { job, number } = c.req.valid('query')
    const ai = ollamaConfig()
    return c.json({
      ai: { configured: ai !== null, model: ai?.model ?? null },
      explanation: ai ? await explainer.cached(job, number) : null,
    })
  })

  .post('/explain', requirePermission('jenkins.view'), requirePermission('ai.use'), validate('json', BuildRef.extend({ fresh: z.boolean().optional() })), async (c) => {
    const { job, number, fresh } = c.req.valid('json')
    return c.json(await explainer.explain(job, number, actor(c), { fresh }))
  })

  .get('/audit', requirePermission('jenkins.view'), async (c) => c.json(await jenkins.listAudit()))

  // Reading history sooner is a read, not an act on Jenkins: a viewer may ask.
  // It still runs as a POST, because it writes the portal's own tables.
  .post('/sync', requirePermission('jenkins.view'), async (c) => c.json(await syncJenkins()))

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
