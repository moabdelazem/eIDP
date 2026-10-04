import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate.ts'
import { accessFrom, requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
import { can } from '../services/rbac.ts'
import * as jenkins from '../services/jenkins.ts'
import * as pipelines from '../services/pipelines.ts'
import { syncJenkins } from '../services/jenkins-sync.ts'
import * as explainer from '../services/build-explainer.ts'
import * as autoExplain from '../services/auto-explain.ts'
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

/**
 * The Jenkins page's API. Reading needs `jenkins.view`. One build, and acting
 * on it, are also open to people whose pipeline it is (`services/pipelines.ts`):
 * seeing it to anyone it is theirs, acting to `jenkins.operate` bound
 * globally or to its team or project.
 */
export const jenkinsRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

  .get('/', requirePermission('jenkins.view'), async (c) =>
    c.json(
      await jenkins.overview({
        fresh: c.req.query('fresh') === '1',
        // The one-line explanation of each failure, for those who may read them.
        withExplanations: can(await accessFrom(c), 'ai.use'),
      }),
    ),
  )

  .get('/stats', requirePermission('jenkins.view'), validate('query', Window), async (c) =>
    c.json(await jenkins.stats(c.req.valid('query').window)),
  )

  .get('/runs', requirePermission('jenkins.view'), validate('query', RunFilter), async (c) => c.json(await jenkins.runs(c.req.valid('query'))))

  .get('/parameters', requirePermission('jenkins.view'), validate('query', Window), async (c) =>
    c.json(await jenkins.parameters(c.req.valid('query').window)),
  )

  .get('/run', validate('query', BuildRef), async (c) => {
    const { job, number } = c.req.valid('query')
    const { operate } = await pipelines.demandView(await accessFrom(c), me(c), job, number)
    return c.json({ ...(await jenkins.run(job, number)), canOperate: operate })
  })

  // "What went wrong?" — the kept explanation, and whether the AI is there to
  // make one. Seeing the build is not enough: asking the model is `ai.use`.
  .get('/explain', requirePermission('ai.use'), validate('query', BuildRef), async (c) => {
    const { job, number } = c.req.valid('query')
    await pipelines.demandView(await accessFrom(c), me(c), job, number)
    const ai = ollamaConfig()
    const explanation = ai ? await explainer.cached(job, number) : null
    return c.json({
      ai: { configured: ai !== null, model: ai?.model ?? null },
      explanation,
      // Whether one is on its way without anyone asking.
      auto: explanation ? { state: 'off', error: null } : await autoExplain.status(job, number),
    })
  })

  .post('/explain', requirePermission('ai.use'), validate('json', BuildRef.extend({ fresh: z.boolean().optional() })), async (c) => {
    const { job, number, fresh } = c.req.valid('json')
    await pipelines.demandView(await accessFrom(c), me(c), job, number)
    return c.json(await explainer.explain(job, number, actor(c), { fresh }))
  })

  .get('/audit', requirePermission('jenkins.view'), async (c) => c.json(await jenkins.listAudit()))

  // Reading history sooner is a read, not an act on Jenkins: a viewer may ask.
  // It still runs as a POST, because it writes the portal's own tables.
  .post('/sync', requirePermission('jenkins.view'), async (c) => {
    const state = await syncJenkins()
    // Explaining what the sync found runs on after the answer; the page polls for it.
    void autoExplain.explainNewFailures().catch(() => {})
    return c.json(state)
  })

  // Setting a failure aside changes what everyone sees as broken: global operators only.
  .post(
    '/ignore',
    requirePermission('jenkins.operate'),
    validate(
      'json',
      z.object({
        job: z.string().min(1).max(1024),
        until: z.enum(Object.keys(jenkins.IGNORE_FOR) as [jenkins.IgnoreFor, ...jenkins.IgnoreFor[]]),
        reason: z.string().trim().min(3, 'Say why it is being ignored, so the next person knows.').max(500),
      }),
    ),
    async (c) => {
      const { job, until, reason } = c.req.valid('json')
      await jenkins.ignore(job, until, reason, actor(c))
      return c.json({ ok: true })
    },
  )

  .post('/unignore', requirePermission('jenkins.operate'), validate('json', z.object({ job: z.string().min(1).max(1024) })), async (c) => {
    await jenkins.unignore(c.req.valid('json').job, actor(c))
    return c.json({ ok: true })
  })

  // Acting needs `jenkins.operate` somewhere to get past the guard; the
  // service then checks it covers this pipeline's team or project.
  .post('/rebuild', requirePermission('jenkins.operate', { scoped: true }), validate('json', BuildRef), async (c) => {
    const { job, number } = c.req.valid('json')
    return c.json(await pipelines.rebuild(await accessFrom(c), me(c), job, number, actor(c)), 202)
  })

  .post('/stop', requirePermission('jenkins.operate', { scoped: true }), validate('json', BuildRef), async (c) => {
    const { job, number } = c.req.valid('json')
    await pipelines.stop(await accessFrom(c), me(c), job, number, actor(c))
    return c.json({ ok: true }, 202)
  })

  .post('/queue/:id/cancel', requirePermission('jenkins.operate', { scoped: true }), async (c) => {
    await pipelines.cancel(await accessFrom(c), me(c), Number(c.req.param('id')) || 0, actor(c))
    return c.json({ ok: true })
  })

function actor(c: { get: (key: 'jwtPayload') => { sub: string; name: string } }) {
  const claims = c.get('jwtPayload')
  return { uid: claims.sub, name: claims.name }
}

/** Who the caller is, every way Jenkins may name them: "Started by user …", or a commit's author. */
function me(c: { get: (key: 'jwtPayload') => { sub: string; name: string; mail?: string } }) {
  const claims = c.get('jwtPayload')
  return { uid: claims.sub, name: claims.name, mail: claims.mail }
}
