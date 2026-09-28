/**
 * A small stand-in for Azure DevOps Server, for tests and for running the
 * request flow locally without access to a real server.
 *
 *   pnpm --filter @eidp/api ado:fake
 *   ADO_BASE_URL=http://localhost:4010/tfs/DefaultCollection ADO_PAT=fake
 *
 * It implements only what e-IDP calls, with the response shapes ADO Server
 * uses — including the queued operation a project creation returns.
 */
import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

type Project = { id: string; name: string; description: string; state: 'wellFormed' }
type Repo = { id: string; name: string; project: { id: string; name: string } }
type Operation = { id: string; status: string; resultMessage: string | null; pending: () => void }

export function createFakeAdo(options: { failProjects?: boolean; denyServerScope?: boolean } = {}) {
  /** A PAT scoped to one collection is refused at the server root. */
  const setDenyServerScope = (deny: boolean) => {
    options.denyServerScope = deny
  }
  /** Flip at runtime to make the next project creations fail, as ADO can. */
  const setFailProjects = (fail: boolean) => {
    options.failProjects = fail
  }
  const collections = new Map<string, { id: string; projects: Project[]; repos: Repo[] }>()
  const operations = new Map<string, Operation>()

  function addCollection(name: string) {
    collections.set(name, { id: randomUUID(), projects: [], repos: [] })
  }
  function addProject(collection: string, name: string) {
    const project: Project = { id: randomUUID(), name, description: '', state: 'wellFormed' }
    collections.get(collection)!.projects.push(project)
    return project
  }
  function addRepo(collection: string, project: string, name: string) {
    const c = collections.get(collection)!
    const p = c.projects.find((x) => x.name === project)!
    c.repos.push({ id: randomUUID(), name, project: { id: p.id, name: p.name } })
  }

  addCollection('DefaultCollection')
  addCollection('Legacy')
  addProject('DefaultCollection', 'AgriLand')
  addProject('DefaultCollection', 'NBFS_LoanManagementSystem')
  addProject('Legacy', 'OldPortal')
  addRepo('DefaultCollection', 'AgriLand', 'agriland-api')

  const list = <T>(value: T[]) => ({ count: value.length, value })
  const ci = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

  const app = new Hono().basePath('/tfs')

  // ADO answers an unauthenticated call with a sign-in page, not a 401 JSON.
  app.use('*', async (c, next) => {
    if (!c.req.header('authorization')?.startsWith('Basic ')) {
      return c.html('<html>Sign in</html>', 200)
    }
    await next()
  })

  app.get('/_apis/projectCollections', (c) =>
    options.denyServerScope
      ? c.json({ message: 'TF400813: The user is not authorized to access this resource.' }, 403)
      : c.json(list([...collections].map(([name, { id }]) => ({ id, name })))),
  )

  app.get('/:collection/_apis/projects', (c) => {
    const coll = collections.get(c.req.param('collection'))
    if (!coll) return c.json({ message: 'Collection not found' }, 404)
    return c.json(list(coll.projects))
  })

  app.get('/:collection/_apis/process/processes', (c) =>
    c.json(list([{ id: 'adcc42ab-9882-485e-a3ed-7678f01f66bc', name: 'Agile', isDefault: true }])),
  )

  app.post('/:collection/_apis/projects', async (c) => {
    const coll = collections.get(c.req.param('collection'))
    if (!coll) return c.json({ message: 'Collection not found' }, 404)
    const body = await c.req.json<{ name: string; description?: string }>()
    if (coll.projects.some((p) => ci(p.name, body.name))) {
      return c.json({ message: `TF200019: The project ${body.name} already exists.` }, 409)
    }
    const id = randomUUID()
    const collectionName = c.req.param('collection')
    // Queued first, finished on the next poll — the shape a real server has.
    const operation: Operation = {
      id,
      status: 'queued',
      resultMessage: null,
      pending: () => {
        if (options.failProjects) {
          operation.status = 'failed'
          operation.resultMessage = 'TF30177: Team Project Creation Failed.'
          return
        }
        addProject(collectionName, body.name).description = body.description ?? ''
        operation.status = 'succeeded'
      },
    }
    operations.set(id, operation)
    return c.json({ id, status: operation.status, url: `/operations/${id}` }, 202)
  })

  app.get('/:collection/_apis/operations/:id', (c) => {
    const operation = operations.get(c.req.param('id'))
    if (!operation) return c.json({ message: 'Operation not found' }, 404)
    if (operation.status === 'queued') operation.pending()
    return c.json({ id: operation.id, status: operation.status, resultMessage: operation.resultMessage })
  })

  const repos = (collection: string, project?: string) => {
    const coll = collections.get(collection)
    if (!coll) return null
    return project ? coll.repos.filter((r) => ci(r.project.name, project)) : coll.repos
  }

  app.get('/:collection/_apis/git/repositories', (c) => {
    const found = repos(c.req.param('collection'))
    return found ? c.json(list(found)) : c.json({ message: 'Collection not found' }, 404)
  })

  app.get('/:collection/:project/_apis/git/repositories', (c) => {
    const found = repos(c.req.param('collection'), c.req.param('project'))
    return found ? c.json(list(found)) : c.json({ message: 'Collection not found' }, 404)
  })

  app.post('/:collection/:project/_apis/git/repositories', async (c) => {
    const coll = collections.get(c.req.param('collection'))
    const project = coll?.projects.find((p) => ci(p.name, c.req.param('project')))
    if (!coll || !project) return c.json({ message: 'Project not found' }, 404)
    const body = await c.req.json<{ name: string }>()
    if (coll.repos.some((r) => r.project.id === project.id && ci(r.name, body.name))) {
      return c.json(
        { message: `TF400948: A Git repository with the name ${body.name} already exists.` },
        409,
      )
    }
    const repo: Repo = { id: randomUUID(), name: body.name, project: { id: project.id, name: project.name } }
    coll.repos.push(repo)
    return c.json(repo, 201)
  })

  return { app, collections, setFailProjects, setDenyServerScope }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_ADO_PORT ?? 4010)
  serve({ fetch: createFakeAdo().app.fetch, port })
  console.log(`fake Azure DevOps Server on http://localhost:${port}/tfs`)
  console.log(`  ADO_BASE_URL=http://localhost:${port}/tfs/DefaultCollection`)
}
