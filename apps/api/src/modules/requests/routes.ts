import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { validate } from '../../lib/validate.ts'
import { accessFrom, requireAuth, requirePermission, type AppEnv } from '../../middleware/auth.ts'
import * as requests from './service.ts'

const names = z.array(z.string().trim().min(1).max(256)).max(100)

const TemplateDir = z.object({ dir: z.string().min(1).max(128) })
/** A template's size, as a whole; each file's is the service's to check. */
const templateLimit = bodyLimit({
  maxSize: 8 * 1024 * 1024,
  onError: (c) => c.json({ error: { code: 'template_too_big', message: 'A template is at most 8 MB.' } }, 413),
})
/** Paths and sizes are checked by the service, which says which file and why. */
const TemplateFiles = z.object({ files: z.array(z.object({ path: z.string().max(512), content: z.string() })).max(500) })

/** A pipeline: what is checked against the technology registry is the service's (`pipeline/check.ts`). */
const Pipeline = z.object({
  application: z.string().max(64),
  deployTarget: z.enum(['OCP', 'K8s']),
  technology: z.string().min(1).max(64),
  version: z.string().max(32).nullable(),
  library: z.boolean(),
  fields: z.record(z.string().max(64), z.string().max(512)),
  newProject: z
    .object({
      teams: z.object({
        company: z.string().max(256),
        devTeam: z.string().max(256),
        qcTeam: z.string().max(256),
        uatTeam: z.string().max(256),
        prdTeam: z.string().max(256),
        automaticDeployToQc: z.boolean().nullable(),
        devTeamList: names,
        opsTeamList: names,
        prdOnly: names,
        prdApprovers: names,
        projectManagers: names,
      }),
      namespaces: z.record(z.string().max(32), z.object({ name: z.string().max(253), user: z.string().max(256).nullable() })),
    })
    .nullable(),
})

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
    kind: z.literal('create_pipeline'),
    collection: z.string().min(1),
    project: z.string().min(1),
    repository: z.string().min(1),
    pipeline: Pipeline,
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

const Name = z.string().max(256)
/** A decider's changes: at most the templates' own limits for files (200, 256 KB each). */
const Changes = z
  .object({
    collection: Name.optional(),
    project: Name.optional(),
    repository: Name.optional(),
    projectKey: z.string().max(20).optional(),
    application: Name.optional(),
    version: z.string().max(40).optional(),
    files: z.array(z.object({ path: z.string().min(1).max(512), content: z.string() })).max(200).optional(),
  })
  .strict()
const changesLimit = bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: { code: 'too_large', message: 'The changes are over 4 MB.' } }, 413) })

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

  // ---- pipelines ----------------------------------------------------------

  /** The technologies a pipeline can be asked for, and what each asks — the form is built from it. */
  .get('/pipeline/technologies', requirePermission('requests.create'), async (c) => c.json(await requests.listTechnologies()))

  /** Whether inventories has the project yet, so the form knows to ask for its teams and namespaces. */
  .get('/pipeline/project', requirePermission('requests.create'), validate('query', z.object({ project: z.string().min(1).max(256) })), async (c) =>
    c.json(await requests.pipelineProject(c.req.valid('query').project)),
  )

  // ---- pipeline templates: DevOps ------------------------------------------
  // What approved pipelines are written from, edited on the Pipeline
  // templates page. `dir` names the template (`DotNetCore/OCP`, `project`…).

  .get('/pipeline/templates', requirePermission('pipelines.templates'), async (c) => c.json(await requests.listTemplates()))

  .get('/pipeline/template', requirePermission('pipelines.templates'), validate('query', TemplateDir), async (c) => c.json(await requests.getTemplate(c.req.valid('query').dir)))

  .put('/pipeline/template', requirePermission('pipelines.templates'), templateLimit, validate('query', TemplateDir), validate('json', TemplateFiles), async (c) =>
    c.json(await requests.saveTemplate(c.req.valid('query').dir, c.req.valid('json').files, actor(c))),
  )

  .delete('/pipeline/template', requirePermission('pipelines.templates'), validate('query', TemplateDir), async (c) => {
    await requests.removeTemplate(c.req.valid('query').dir, actor(c))
    return c.body(null, 204)
  })

  /** The template's reference, read as a template for the editor — not saved. */
  .post('/pipeline/template/import', requirePermission('pipelines.templates'), validate('query', TemplateDir), async (c) =>
    c.json(await requests.importReference(c.req.valid('query').dir)),
  )

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

  /** Change a waiting request before approving it: names, a pipeline's version, the files it writes — each checked and recorded. */
  .patch('/:id', decider, changesLimit, validate('json', Changes), async (c) =>
    c.json(await requests.adjust(c.req.param('id'), c.req.valid('json'), actor(c), await accessFrom(c))),
  )

  /** Run one of a pushed pipeline's steps again: its branches, or its test build. */
  .post('/:id/steps/:step/retry', decider, validate('param', z.object({ id: z.string(), step: z.enum(['branches', 'hooks', 'test']) })), async (c) =>
    c.json(await requests.retryPipelineStep(c.req.param('id'), c.req.valid('param').step, await accessFrom(c))),
  )

  /** What approving a pipeline request would write into inventories, as they are now. */
  .get('/:id/pipeline', decider, async (c) => c.json(await requests.pipelinePreview(c.req.param('id'), await accessFrom(c))))

  // ---- the requester's own, or DevOps ------------------------------------

  .get('/:id', async (c) => c.json(await requests.get(c.req.param('id'), actor(c), await accessFrom(c))))

  .post('/:id/cancel', async (c) => c.json(await requests.cancel(c.req.param('id'), actor(c))))

function actor(c: { get: (key: 'jwtPayload') => { sub: string; name: string } }) {
  const claims = c.get('jwtPayload')
  return { uid: claims.sub, name: claims.name }
}
