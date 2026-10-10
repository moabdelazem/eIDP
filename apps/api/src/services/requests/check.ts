import type { Check } from '@eidp/contracts/requests'
import { listProjects, listRepositories } from '../../integrations/ado/index.ts'
import * as jira from '../../integrations/jira/index.ts'
import { dnOf } from '../../integrations/ldap/index.ts'
import { query } from '../../lib/db.ts'
import { jiraKeyProblem, jiraNameProblem, nameProblem } from '../request-rules.ts'
import { type AdoTarget, type JiraTarget, MAX_GRANTEES, type Target } from './model.ts'
import { same } from './rows.ts'

/**
 * Whether a request could be filed as it stands: the name is one ADO accepts,
 * the target does not exist yet, and nobody has already asked for it. The form
 * calls this as someone types, and `submit` runs the same thing, so the answer
 * on screen is the answer on submit.
 */
export async function check(input: Target): Promise<Check> {
  if (input.kind === 'create_jira_project') return checkJiraProject(input)
  if (input.kind === 'grant_access') return checkGrant(input)
  const creatingRepo = input.kind === 'create_repository'
  const name = creatingRepo ? (input.repository ?? '') : input.project
  const problem = nameProblem(name, creatingRepo ? 'repository' : 'project')
  if (problem) return { ok: false, reason: problem }

  const projects = await listProjects(input.collection)
  const existingProject = projects.find((p) => same(p.name, input.project))

  if (creatingRepo) {
    if (!existingProject) {
      return { ok: false, reason: `There is no project ${input.project} in ${input.collection}.` }
    }
    const repos = await listRepositories(input.collection, existingProject.name)
    if (repos.some((r) => same(r.name, name))) {
      return { ok: false, reason: `${existingProject.name} already has a repository called ${name}.` }
    }
  } else if (existingProject) {
    return { ok: false, reason: `${input.collection} already has a project called ${existingProject.name}.` }
  }

  const { rows } = await query<{ requested_by_name: string }>(
    `select requested_by_name from requests
      where kind = $1 and lower(collection) = lower($2) and lower(project) = lower($3)
        and lower(coalesce(repository, '')) = lower(coalesce($4, ''))
        and status in ('pending', 'approved')`,
    [input.kind, input.collection, input.project, input.repository ?? null],
  )
  if (rows[0]) {
    return { ok: false, reason: `${rows[0].requested_by_name} has already asked for this; it is waiting on approval.` }
  }

  return { ok: true }
}

/**
 * Access to something that already exists: the project, and the repository if
 * one is named, must be there, and every grantee must be an account the
 * directory knows — ADO would otherwise fail it only after approval.
 */
async function checkGrant(input: AdoTarget): Promise<Check> {
  const grantees = uniqueNames(input.grantees ?? [])
  if (grantees.length === 0) return { ok: false, reason: 'Name at least one person to grant access to.' }
  if (grantees.length > MAX_GRANTEES) {
    return { ok: false, reason: `At most ${MAX_GRANTEES} people per request; for more, grant their group.` }
  }

  const project = (await listProjects(input.collection)).find((p) => same(p.name, input.project))
  if (!project) return { ok: false, reason: `There is no project ${input.project} in ${input.collection}.` }
  if (input.repository) {
    const repos = await listRepositories(input.collection, project.name)
    if (!repos.some((r) => same(r.name, input.repository!))) {
      return { ok: false, reason: `${project.name} has no repository called ${input.repository}.` }
    }
  }

  const unknown: string[] = []
  for (const name of grantees) if (!(await dnOf(name))) unknown.push(name)
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `The directory has no account called ${unknown.join(', ')}. Use login names, like jsmith.`,
    }
  }
  return { ok: true }
}

/**
 * A Jira project needs a name and a key nobody has, and a key Jira's own rules
 * accept — which only the server knows, since the pattern, the length and the
 * reserved words are its configuration. It also sees archived projects, whose
 * keys stay taken though the project list leaves them out.
 */
async function checkJiraProject(input: JiraTarget): Promise<Check> {
  const problem = jiraNameProblem(input.project) ?? jiraKeyProblem(input.projectKey)
  if (problem) return { ok: false, reason: problem }

  const existing = (await jira.listProjects()).find((p) => same(p.name, input.project))
  if (existing) return { ok: false, reason: `Jira already has a project called ${existing.name} (${existing.key}).` }
  const keyProblem = await jira.keyProblem(input.projectKey)
  if (keyProblem) return { ok: false, reason: keyProblem }

  const { rows } = await query<{ requested_by_name: string }>(
    `select requested_by_name from requests
      where kind = 'create_jira_project' and (lower(project) = lower($1) or lower(project_key) = lower($2))
        and status in ('pending', 'approved')`,
    [input.project, input.projectKey],
  )
  if (rows[0]) {
    return { ok: false, reason: `${rows[0].requested_by_name} has already asked for this; it is waiting on approval.` }
  }
  return { ok: true }
}

export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, string>()
  for (const raw of names) {
    const name = raw.trim()
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name)
  }
  return [...seen.values()]
}
