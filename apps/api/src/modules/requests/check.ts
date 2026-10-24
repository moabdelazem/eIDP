import type { Check } from '@eidp/contracts/requests'
import { listProjects, listRepositories, projectGroupMembers } from '../../integrations/ado/index.ts'
import * as jira from '../../integrations/jira/index.ts'
import { dnOf } from '../../integrations/ldap/index.ts'
import { ApiError } from '../../lib/errors.ts'
import { and, eq, inArray, ne, or, sql, type SQLWrapper } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { jiraKeyProblem, jiraNameProblem, nameProblem } from './rules.ts'
import { type AdoTarget, type JiraTarget, MAX_GRANTEES, type Target } from './model.ts'
import { checkPipeline } from './pipeline/check.ts'
import { requests } from './schema.ts'
import { same } from './rows.ts'

/** A request still waiting, or being carried out: one of these for the same thing is a duplicate. */
const open = inArray(requests.status, ['pending', 'approved'])

/** Every request but `except` — the one a decider is adjusting is not a duplicate of itself. */
export const others = (except?: string) => (except ? ne(requests.id, except) : undefined)

/**
 * Whether a request could be filed as it stands: the name is one ADO accepts,
 * the target does not exist yet, and nobody has already asked for it. The form
 * calls this as someone types, and `submit` runs the same thing, so the answer
 * on screen is the answer on submit.
 */
export async function check(input: Target, except?: string): Promise<Check> {
  if (input.kind === 'create_jira_project') return checkJiraProject(input, except)
  if (input.kind === 'create_pipeline') return checkPipeline(input, except)
  if (input.kind === 'grant_access') return checkGrant(input)
  if (input.kind === 'revoke_access') return checkRevoke(input, except)
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
  } else {
    const developers = await developersProblem(input.developers ?? [])
    if (developers) return { ok: false, reason: developers }
  }

  const lower = (column: SQLWrapper) => sql`lower(${column})`
  const [waiting] = await db
    .select({ by: requests.requestedByName })
    .from(requests)
    .where(
      and(
        eq(requests.kind, input.kind),
        eq(lower(requests.collection), input.collection.toLowerCase()),
        eq(lower(requests.project), input.project.toLowerCase()),
        eq(sql`lower(coalesce(${requests.repository}, ''))`, (input.repository ?? '').toLowerCase()),
        open,
        others(except),
      ),
    )
  if (waiting) {
    return { ok: false, reason: `${waiting.by} has already asked for this; it is waiting on approval.` }
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

  const unknown = await unknownAccounts(grantees)
  return unknown ? { ok: false, reason: unknown } : { ok: true }
}

/**
 * Removing access: each name must be someone, or a group, in the project's
 * Contributors or Readers now — the list the project page shows — and not
 * already waiting to be removed, so two people asking for the same removal
 * file one request, not two.
 */
async function checkRevoke(input: AdoTarget, except?: string): Promise<Check> {
  const names = uniqueNames(input.grantees ?? [])
  if (names.length === 0) return { ok: false, reason: 'Name at least one person to remove.' }
  if (names.length > MAX_GRANTEES) return { ok: false, reason: `At most ${MAX_GRANTEES} people per request.` }

  const project = (await listProjects(input.collection)).find((p) => same(p.name, input.project))
  if (!project) return { ok: false, reason: `There is no project ${input.project} in ${input.collection}.` }
  const members = [...(await projectGroupMembers(input.collection, project.name, 'Contributors')), ...(await projectGroupMembers(input.collection, project.name, 'Readers'))]
  const outside = names.filter((name) => !members.some((m) => same(m.account, name)))
  if (outside.length > 0) {
    return { ok: false, reason: `${outside.join(', ')} ${outside.length === 1 ? 'has' : 'have'} no access to ${project.name} to remove.` }
  }

  const waiting = await db
    .select({ by: requests.requestedByName, grantees: requests.grantees })
    .from(requests)
    .where(and(eq(requests.kind, 'revoke_access'), eq(sql`lower(${requests.project})`, project.name.toLowerCase()), open, others(except)))
  for (const row of waiting) {
    const both = names.filter((name) => (row.grantees ?? []).some((g) => same(g, name)))
    if (both.length > 0) return { ok: false, reason: `${row.by} has already asked to remove ${both.join(', ')}; it is waiting on approval.` }
  }
  return { ok: true }
}

/** The names the directory does not know, said as a reason — or null when it knows them all. */
async function unknownAccounts(names: string[]): Promise<string | null> {
  const unknown: string[] = []
  for (const name of names) if (!(await dnOf(name))) unknown.push(name)
  return unknown.length > 0 ? `The directory has no account called ${unknown.join(', ')}. Use login names, like jsmith.` : null
}

/**
 * A new project's developers — the old form's "development team usernames":
 * login names, not display names, each one the directory knows, so a typo is
 * caught on the form rather than after approval.
 */
async function developersProblem(names: string[]): Promise<string | null> {
  const developers = uniqueNames(names)
  if (developers.length > MAX_GRANTEES) return `At most ${MAX_GRANTEES} developers; for more, use their team's group.`
  const spaced = developers.find((name) => /\s/.test(name))
  if (spaced) return `${spaced} has a space in it. Use login names, like jsmith, not display names.`
  return unknownAccounts(developers)
}

/**
 * A Jira project needs a name and a key nobody has, and a key Jira's own rules
 * accept — which only the server knows, since the pattern, the length and the
 * reserved words are its configuration. It also sees archived projects, whose
 * keys stay taken though the project list leaves them out.
 */
async function checkJiraProject(input: JiraTarget, except?: string): Promise<Check> {
  const problem = jiraNameProblem(input.project) ?? jiraKeyProblem(input.projectKey)
  if (problem) return { ok: false, reason: problem }

  const existing = (await jira.listProjects()).find((p) => same(p.name, input.project))
  if (existing) return { ok: false, reason: `Jira already has a project called ${existing.name} (${existing.key}).` }
  const keyProblem = await jira.keyProblem(input.projectKey)
  if (keyProblem) return { ok: false, reason: keyProblem }
  const lead = input.lead?.trim()
  if (lead) {
    if (/\s/.test(lead)) return { ok: false, reason: 'The project lead is a Jira username, like jsmith — not a display name.' }
    try {
      await jira.findUser(lead)
    } catch (err) {
      if (err instanceof ApiError && err.code.startsWith('jira_identity')) return { ok: false, reason: err.message }
      throw err
    }
  }

  const [waiting] = await db
    .select({ by: requests.requestedByName })
    .from(requests)
    .where(
      and(
        eq(requests.kind, 'create_jira_project'),
        or(eq(sql`lower(${requests.project})`, input.project.toLowerCase()), eq(sql`lower(${requests.projectKey})`, input.projectKey.toLowerCase())),
        open,
        others(except),
      ),
    )
  if (waiting) {
    return { ok: false, reason: `${waiting.by} has already asked for this; it is waiting on approval.` }
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
