/**
 * A small stand-in for Jira Data Center, for tests and for running the request
 * flow locally without a real server.
 *
 *   pnpm --filter @eidp/api jira:fake
 *   JIRA_BASE_URL=http://localhost:4020/jira JIRA_TOKEN=fake
 *
 * It implements only what e-IDP calls, with the response shapes Jira uses —
 * including the ErrorCollection its refusals come back as, and refusing a role
 * actor that is already in the role.
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

type Project = { id: string; key: string; name: string; description: string; lead: string; archived: boolean }
type Actor = { name: string; type: 'atlassian-user-role-actor' | 'atlassian-group-role-actor' }

const ROLES = { Users: 10000, Developers: 10001, Administrators: 10002 } as const
/** Jira's default `jira.projectkey.pattern` and `jira.maxlength.projectkey`. */
const KEY_PATTERN = /^[A-Z][A-Z]+$/
const MAX_KEY = 10
const RESERVED = new Set(['AND', 'OR', 'NOT', 'EMPTY', 'NULL', 'ORDER', 'BY', 'CON', 'PRN', 'AUX', 'NUL'])

export function createFakeJira(options: { denyRoles?: boolean; failCreate?: boolean } = {}) {
  /** A service account allowed to create projects but not to manage their roles. */
  const setDenyRoles = (deny: boolean) => {
    options.denyRoles = deny
  }
  /** Flip at runtime to make the next creations fail, as Jira can. */
  const setFailCreate = (fail: boolean) => {
    options.failCreate = fail
  }

  const users = new Map<string, { name: string; active: boolean }>()
  const groups = new Set<string>()
  const projects: Project[] = []
  /** Role actors by project key, then role id. */
  const roles = new Map<string, Map<number, Actor[]>>()
  let nextId = 10100

  for (const name of ['alice', 'bob', 'carol']) users.set(name, { name, active: true })
  users.set('mallory', { name: 'mallory', active: false })
  for (const name of ['Payments', 'DEVOPS', 'Payments-Contractors']) groups.add(name)

  function addProject(key: string, name: string, lead = 'alice', archived = false) {
    const project: Project = { id: String(nextId++), key, name, description: '', lead, archived }
    projects.push(project)
    roles.set(key, new Map(Object.values(ROLES).map((id) => [id, []])))
    return project
  }
  addProject('AGRI', 'AgriLand')
  // Archived: missing from the project list, but its key is still taken.
  addProject('OLD', 'Old Portal', 'alice', true)

  const ci = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const refuse = (errors: Record<string, string>, errorMessages: string[] = []) => ({ errorMessages, errors })
  const byKey = (key: string) => projects.find((p) => ci(p.key, key))

  function keyErrors(key: string): Record<string, string> {
    if (!KEY_PATTERN.test(key)) {
      return { projectKey: 'Project keys must start with an uppercase letter, followed by one or more uppercase alphanumeric characters.' }
    }
    if (key.length > MAX_KEY) return { projectKey: `The project key must not exceed ${MAX_KEY} characters in length.` }
    if (RESERVED.has(key)) return { projectKey: `This keyword is invalid as it is a reserved word on this operating system.` }
    if (byKey(key)) return { projectKey: `Project '${byKey(key)!.name}' uses this project key.` }
    return {}
  }

  const app = new Hono().basePath('/jira/rest/api/2')

  app.use('*', async (c, next) => {
    if (!c.req.header('authorization')?.startsWith('Bearer ')) {
      c.header('X-Seraph-LoginReason', 'AUTHENTICATED_FAILED')
      return c.json(refuse({}, ['You are not authenticated. Authentication required to perform this operation.']), 401)
    }
    await next()
  })

  app.get('/serverInfo', (c) => c.json({ baseUrl: 'http://jira.example.com', serverTitle: 'Jira (fake)', version: '9.12.0' }))

  app.get('/project', (c) => c.json(projects.filter((p) => !p.archived).map(({ id, key, name }) => ({ id, key, name }))))

  app.get('/projectvalidate/key', (c) => c.json(refuse(keyErrors(c.req.query('key') ?? ''))))

  app.post('/project', async (c) => {
    const body = await c.req.json<{ key: string; name: string; description?: string; lead: string; projectTypeKey: string }>()
    const errors: Record<string, string> = { ...keyErrors(body.key) }
    if (projects.some((p) => ci(p.name, body.name))) errors.projectName = 'A project with that name already exists.'
    if (!users.get(body.lead)?.active) errors.projectLead = 'The project lead specified does not exist.'
    if (body.projectTypeKey !== 'software') errors.projectType = 'Unknown project type.'
    if (options.failCreate) return c.json(refuse({}, ['Internal server error creating the project.']), 500)
    if (Object.keys(errors).length > 0) return c.json(refuse(errors), 400)
    const project = addProject(body.key, body.name, body.lead)
    project.description = body.description ?? ''
    return c.json({ self: `/rest/api/2/project/${project.id}`, id: Number(project.id), key: project.key }, 201)
  })

  app.get('/user', (c) => {
    const user = users.get(c.req.query('username') ?? '')
    if (!user) return c.json(refuse({}, [`The user named '${c.req.query('username')}' does not exist`]), 404)
    return c.json({ name: user.name, key: user.name, active: user.active, displayName: user.name })
  })

  app.get('/groups/picker', (c) => {
    const query = (c.req.query('query') ?? '').toLowerCase()
    const found = [...groups].filter((g) => g.toLowerCase().includes(query)).map((name) => ({ name, html: name }))
    return c.json({ header: `Showing ${found.length} of ${found.length} matching groups`, total: found.length, groups: found })
  })

  app.get('/project/:key/role', (c) => {
    if (!byKey(c.req.param('key'))) return c.json(refuse({}, ['No project could be found with key.']), 404)
    return c.json(Object.fromEntries(Object.entries(ROLES).map(([name, id]) => [name, `http://jira.example.com/rest/api/2/project/${c.req.param('key')}/role/${id}`])))
  })

  app.get('/project/:key/role/:id', (c) => {
    const project = byKey(c.req.param('key'))
    const actors = project && roles.get(project.key)?.get(Number(c.req.param('id')))
    if (!actors) return c.json(refuse({}, ['Not found.']), 404)
    return c.json({ id: Number(c.req.param('id')), actors })
  })

  app.post('/project/:key/role/:id', async (c) => {
    if (options.denyRoles) return c.json(refuse({}, ['You cannot edit the configuration of this project.']), 403)
    const project = byKey(c.req.param('key'))
    const actors = project && roles.get(project.key)?.get(Number(c.req.param('id')))
    if (!actors) return c.json(refuse({}, ['Not found.']), 404)
    const body = await c.req.json<{ user?: string[]; group?: string[] }>()
    const adding: Actor[] = [
      ...(body.user ?? []).map((name) => ({ name, type: 'atlassian-user-role-actor' as const })),
      ...(body.group ?? []).map((name) => ({ name, type: 'atlassian-group-role-actor' as const })),
    ]
    for (const actor of adding) {
      const known = actor.type === 'atlassian-user-role-actor' ? users.has(actor.name) : groups.has(actor.name)
      if (!known) return c.json(refuse({}, [`We can't find '${actor.name}'.`]), 400)
      if (actors.some((a) => a.name === actor.name && a.type === actor.type)) {
        return c.json(refuse({}, [`'${actor.name}' is already a member of the project role.`]), 400)
      }
    }
    actors.push(...adding)
    return c.json({ id: Number(c.req.param('id')), actors })
  })

  return { app, users, groups, projects, roles, roleIds: ROLES, setDenyRoles, setFailCreate }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_JIRA_PORT ?? 4020)
  serve({ fetch: createFakeJira().app.fetch, port })
  console.log(`fake Jira Data Center on http://localhost:${port}/jira`)
  console.log(`  JIRA_BASE_URL=http://localhost:${port}/jira JIRA_TOKEN=fake`)
}
