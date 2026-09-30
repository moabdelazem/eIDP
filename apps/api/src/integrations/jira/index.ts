import { ApiError } from '../../lib/errors.ts'
import { jiraConfig, jiraGet, jiraPost } from './client.ts'

export { jiraConfig } from './client.ts'

export type JiraProject = { id: string; key: string; name: string }

export type JiraServer = { baseUrl: string; serverTitle: string; version: string }

/** A user or group as Jira names it — the exact spelling a role actor needs. */
export type JiraPrincipal = { type: 'user' | 'group'; name: string }

type RoleActor = { name: string; type: 'atlassian-user-role-actor' | 'atlassian-group-role-actor' }

/** Who the portal is talking to; also the form's "is Jira reachable" probe. */
export async function serverInfo(): Promise<JiraServer> {
  const info = await jiraGet<{ baseUrl: string; serverTitle: string; version: string }>('serverInfo')
  return { baseUrl: jiraConfig().baseUrl, serverTitle: info.serverTitle, version: info.version }
}

export async function listProjects(): Promise<JiraProject[]> {
  const projects = await jiraGet<JiraProject[]>('project')
  return projects.map(({ id, key, name }) => ({ id, key, name }))
}

/**
 * Jira's own opinion of a key: its configured pattern and length, reserved
 * words, and whether a project — including an archived one, which the project
 * list leaves out — already uses it. Null when it would accept it.
 */
export async function keyProblem(key: string): Promise<string | null> {
  const verdict = await jiraGet<{ errorMessages?: string[]; errors?: Record<string, string> }>('projectvalidate/key', { key })
  const messages = [...(verdict.errorMessages ?? []), ...Object.values(verdict.errors ?? {})]
  return messages.length > 0 ? messages.join(' ') : null
}

/**
 * The Jira account for a directory login name. Jira is joined to the same
 * directory, so the names match; one it does not know, or has deactivated, is
 * an error rather than a guess.
 */
export async function findUser(username: string): Promise<JiraPrincipal> {
  let user: { name: string; active: boolean }
  try {
    user = await jiraGet('user', { username })
  } catch (err) {
    if (err instanceof ApiError && err.code === 'jira_not_found') {
      throw new ApiError(502, 'jira_identity_missing', `Jira does not know an account called ${username}.`)
    }
    throw err
  }
  if (!user.active) throw new ApiError(502, 'jira_identity_inactive', `The Jira account ${user.name} is deactivated.`)
  return { type: 'user', name: user.name }
}

/** A directory group as Jira spells it. The picker matches substrings, so only an exact name counts. */
export async function findGroup(name: string): Promise<JiraPrincipal> {
  const { groups } = await jiraGet<{ groups: { name: string }[] }>('groups/picker', { query: name, maxResults: 100 })
  const exact = groups.filter((group) => group.name.toLowerCase() === name.toLowerCase())
  if (exact.length !== 1) {
    throw new ApiError(502, 'jira_identity_missing', `Jira does not know a group called ${name}.`)
  }
  return { type: 'group', name: exact[0]!.name }
}

/**
 * Creates a software project led by `lead`. Unlike Azure DevOps this is
 * synchronous: the answer is the project, or the reason there is none.
 */
export async function createProject(input: {
  key: string
  name: string
  description: string
  lead: string
}): Promise<JiraProject> {
  const { projectTemplate } = jiraConfig()
  const created = await jiraPost<{ id: number | string; key: string }>('project', {
    key: input.key,
    name: input.name,
    description: input.description,
    lead: input.lead,
    projectTypeKey: 'software',
    projectTemplateKey: projectTemplate,
  })
  return { id: String(created.id), key: created.key, name: input.name }
}

/**
 * Puts each principal in one of the project's roles — how Jira says "works on
 * this project". Only those not already in it are added: Jira refuses the whole
 * call if any actor is already there, which would make a retry fail forever.
 */
export async function addToRole(projectKey: string, roleName: string, principals: JiraPrincipal[]): Promise<void> {
  const roles = await jiraGet<Record<string, string>>(`project/${encodeURIComponent(projectKey)}/role`)
  const url = Object.entries(roles).find(([name]) => name.toLowerCase() === roleName.toLowerCase())?.[1]
  if (!url) {
    throw new ApiError(502, 'jira_role_missing', `Project ${projectKey} has no ${roleName} role. Check JIRA_MEMBER_ROLE.`)
  }
  const rolePath = `project/${encodeURIComponent(projectKey)}/role/${url.split('/').pop()}`
  const { actors } = await jiraGet<{ actors: RoleActor[] }>(rolePath)
  const has = (principal: JiraPrincipal) =>
    actors.some(
      (actor) =>
        actor.name.toLowerCase() === principal.name.toLowerCase() &&
        actor.type === (principal.type === 'user' ? 'atlassian-user-role-actor' : 'atlassian-group-role-actor'),
    )
  const missing = principals.filter((principal) => !has(principal))
  if (missing.length === 0) return
  const user = missing.filter((p) => p.type === 'user').map((p) => p.name)
  const group = missing.filter((p) => p.type === 'group').map((p) => p.name)
  await jiraPost(rolePath, { ...(user.length ? { user } : {}), ...(group.length ? { group } : {}) })
}

/** Where a person would open the project in a browser. */
export function browseUrl(key: string): string {
  return `${jiraConfig().baseUrl}/browse/${encodeURIComponent(key)}`
}
