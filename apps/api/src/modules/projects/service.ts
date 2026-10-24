import type { ProjectMember, ProjectRepository, ProjectView } from '@eidp/contracts/projects'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { findProject, listRepositories, projectGroupMembers, webUrlFor } from '../../integrations/ado/index.ts'
import { db } from '../../lib/db.ts'
import { ApiError } from '../../lib/errors.ts'
import { catalogReach, type Access } from '../access/index.ts'
import { catalogApplications, catalogSystems } from '../catalog/index.ts'
import { requests } from '../requests/index.ts'

/**
 * A project as a place to work: the repositories in its Azure DevOps project,
 * each with whether it has a pipeline — from the catalog, so no per-repository
 * lookups — or one asked for; and who can work in it, with removals asked
 * for. It reads; asking for anything is a request (`/requests`).
 *
 * Shown only to someone who sees the system on the map (`catalogReach`):
 * another team's project answers as one that does not exist.
 */
export async function projectView(dir: string, access: Access): Promise<ProjectView> {
  const [system] = await db.select().from(catalogSystems).where(eq(catalogSystems.dir, dir))
  if (!system || !catalogReach(access).sees({ project: system.projectName, teams: system.teams, approvers: system.approvers, managers: system.managers, opsTeams: system.opsTeams })) {
    throw new ApiError(404, 'project_not_found', 'There is no such project in the catalog.')
  }
  const view: ProjectView = {
    system: { id: system.dir, projectName: system.projectName, company: system.company, teams: system.teams },
    ado: null,
    repositories: [],
    repositoriesError: null,
    members: [],
    membersError: null,
  }

  let found: Awaited<ReturnType<typeof findProject>>
  try {
    found = await findProject(system.projectName)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Azure DevOps did not answer.'
    return { ...view, repositoriesError: reason, membersError: reason }
  }
  if (!found) {
    const reason = `Azure DevOps has no project called ${system.projectName} yet.`
    return { ...view, repositoriesError: reason, membersError: reason }
  }
  const { collection, project } = found
  view.ado = { collection, project: project.name, url: webUrlFor(collection, project.name) }

  const [repositories, members] = await Promise.allSettled([repositoriesOf(dir, collection, project.name), membersOf(collection, project.name)])
  if (repositories.status === 'fulfilled') view.repositories = repositories.value
  else view.repositoriesError = repositories.reason instanceof Error ? repositories.reason.message : 'Could not read the repositories.'
  if (members.status === 'fulfilled') view.members = members.value
  else view.membersError = members.reason instanceof Error ? members.reason.message : 'Could not read who has access.'
  return view
}

/** A request still waiting, or being carried out. */
const open = inArray(requests.status, ['pending', 'approved'])
const lower = (value: string) => value.toLowerCase()

async function repositoriesOf(dir: string, collection: string, project: string): Promise<ProjectRepository[]> {
  const [repos, applications, asked] = await Promise.all([
    listRepositories(collection, project),
    db.selectDistinct({ name: catalogApplications.name, repository: catalogApplications.repository }).from(catalogApplications).where(eq(catalogApplications.systemDir, dir)),
    db
      .select({ id: requests.id, status: requests.status, repository: requests.repository, pipeline: requests.pipeline })
      .from(requests)
      .where(and(eq(requests.kind, 'create_pipeline'), eq(sql`lower(${requests.project})`, lower(project)), open)),
  ])
  return repos
    .map((repo) => ({
      name: repo.name,
      url: repo.webUrl ?? webUrlFor(collection, project, repo.name),
      applications: [...new Set(applications.filter((a) => a.repository && lower(a.repository) === lower(repo.name)).map((a) => a.name))].sort(),
      pipelineRequest: (() => {
        const request = asked.find((r) => r.repository && lower(r.repository) === lower(repo.name))
        return request ? { id: request.id, status: request.status, application: request.pipeline?.application ?? repo.name } : null
      })(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function membersOf(collection: string, project: string): Promise<ProjectMember[]> {
  const [contributors, readers, removals] = await Promise.all([
    projectGroupMembers(collection, project, 'Contributors'),
    projectGroupMembers(collection, project, 'Readers'),
    db
      .select({ id: requests.id, by: requests.requestedByName, grantees: requests.grantees })
      .from(requests)
      .where(and(eq(requests.kind, 'revoke_access'), eq(sql`lower(${requests.project})`, lower(project)), open)),
  ])
  const byAccount = new Map<string, ProjectMember>()
  for (const [group, list] of [['Contributors', contributors], ['Readers', readers]] as const) {
    for (const member of list) {
      const key = lower(member.account)
      const known = byAccount.get(key)
      if (known) known.in.push(group)
      else {
        const removal = removals.find((r) => (r.grantees ?? []).some((g) => lower(g) === key))
        byAccount.set(key, { ...member, in: [group], removal: removal ? { id: removal.id, requestedByName: removal.by } : null })
      }
    }
  }
  // People first, then the groups added whole; each by name.
  return [...byAccount.values()].sort((a, b) => Number(a.group) - Number(b.group) || a.displayName.localeCompare(b.displayName))
}
