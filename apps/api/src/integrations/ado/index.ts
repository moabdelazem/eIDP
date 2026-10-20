import { setTimeout as sleep } from 'node:timers/promises'
import { ApiError } from '../../lib/errors.ts'
import { adoConfig, adoGet, adoGetList, adoPost } from './client.ts'

export { cloneOrUpdate, commitAndPush, findCommit, freshCopy, headCommit, inventoriesRemote, ocpTemplatesRemote, type FileWrite, type Remote } from './git.ts'
export { adoConfig } from './client.ts'
export { addToProjectGroup, CONTRIBUTOR, findIdentity, grantRepository, READER, type Principal } from './access.ts'

export type AdoCollection = { id: string; name: string }

export type AdoProject = {
  id: string
  name: string
  description?: string
  state?: string
}

export type AdoRepository = {
  id: string
  name: string
  project: { id: string; name: string }
  defaultBranch?: string
  webUrl?: string
  remoteUrl?: string
  size?: number
}

type AdoProcess = { id: string; name: string; isDefault: boolean }

type AdoOperation = {
  id: string
  status: 'notSet' | 'queued' | 'inProgress' | 'cancelled' | 'succeeded' | 'failed'
  resultMessage?: string | null
}

/** Every collection on the server. */
export function listCollections(): Promise<AdoCollection[]> {
  return adoGetList<AdoCollection>('projectCollections', { collection: null, query: { $top: 1000 } })
}

/** Projects in a collection; the default collection when omitted. */
export function listProjects(collection?: string): Promise<AdoProject[]> {
  return adoGetList<AdoProject>('projects', { collection, query: { $top: 1000 } })
}

/** Repositories in one project, or across the collection when omitted. */
export function listRepositories(collection?: string, project?: string): Promise<AdoRepository[]> {
  return adoGetList<AdoRepository>('git/repositories', {
    collection,
    ...(project ? { project } : {}),
    query: { includeLinks: false },
  })
}

/** The process template a new project gets when nobody chooses one. */
export async function defaultProcess(collection: string): Promise<AdoProcess> {
  const processes = await adoGetList<AdoProcess>('process/processes', { collection })
  const chosen = processes.find((process) => process.isDefault) ?? processes[0]
  if (!chosen) {
    throw new ApiError(502, 'ado_no_process', `Collection ${collection} has no process templates.`)
  }
  return chosen
}

export async function createRepository(
  collection: string,
  project: string,
  name: string,
): Promise<AdoRepository> {
  // The body wants the project's id, not its name, so resolve it first.
  const projects = await listProjects(collection)
  const target = projects.find((p) => p.name.toLowerCase() === project.toLowerCase())
  if (!target) {
    throw new ApiError(404, 'ado_project_missing', `Project ${project} no longer exists in ${collection}.`)
  }
  return adoPost<AdoRepository>(
    'git/repositories',
    { name, project: { id: target.id } },
    { collection, project: target.name },
  )
}

type AdoRef = { name: string; objectId: string }
type RefUpdate = { name: string; success: boolean; updateStatus: string; customMessage?: string | null }

const NO_COMMIT = '0000000000000000000000000000000000000000'

/**
 * Makes sure `branches` exist in a repository, each new one starting at the
 * default branch's head — what createBranch.sh did with a clone, a
 * `checkout -b` and a push, in one call and without a working copy. A
 * branch that is already there is left as it is. A repository with no
 * commit yet has no default branch to start from, and says so.
 */
export async function ensureBranches(
  collection: string,
  project: string,
  repository: string,
  branches: string[],
): Promise<{ from: string; created: string[]; existing: string[] }> {
  const repo = (await listRepositories(collection, project)).find((r) => r.name.toLowerCase() === repository.toLowerCase())
  if (!repo) throw new ApiError(404, 'ado_repository_missing', `${project} has no repository called ${repository}.`)
  if (!repo.defaultBranch) {
    throw new ApiError(409, 'ado_repository_empty', `${repository} has no commits yet, so there is no branch to start the others from. Push a first commit to it, then run this again.`)
  }
  const scope = { collection, project: repo.project.name }
  const heads = await adoGetList<AdoRef>(`git/repositories/${repo.id}/refs`, { ...scope, query: { filter: 'heads/' } })
  const base = heads.find((ref) => ref.name === repo.defaultBranch)
  if (!base) throw new ApiError(409, 'ado_repository_empty', `${repository}'s default branch, ${repo.defaultBranch}, has no commit to start from.`)
  const from = repo.defaultBranch.replace(/^refs\/heads\//, '')
  const has = new Set(heads.map((ref) => ref.name.toLowerCase()))
  const missing = branches.filter((branch) => !has.has(`refs/heads/${branch}`.toLowerCase()))
  const existing = branches.filter((branch) => !missing.includes(branch))
  if (missing.length === 0) return { from, created: [], existing }

  const updates = await adoPost<{ value: RefUpdate[] }>(
    `git/repositories/${repo.id}/refs`,
    missing.map((branch) => ({ name: `refs/heads/${branch}`, oldObjectId: NO_COMMIT, newObjectId: base.objectId })),
    scope,
  )
  const refused = updates.value.filter((u) => !u.success)
  if (refused.length) {
    throw new ApiError(502, 'ado_branch_refused', refused.map((u) => `${u.name.replace('refs/heads/', '')}: ${u.customMessage || u.updateStatus}`).join('; '))
  }
  return { from, created: missing, existing }
}

/**
 * Creates a Git project and waits for it to actually exist.
 *
 * ADO answers the POST with a queued *operation*, not a project. Reporting
 * success at that point would tell someone their project is ready while the
 * server may still fail to create it, so this polls the operation to the end.
 *
 * ponytail: polls inline, up to `timeoutMs`. Project creation is usually
 * seconds; if a server routinely takes longer, move this to a background job
 * that records the operation id and resumes.
 */
export async function createProject(
  collection: string,
  name: string,
  description: string,
  { timeoutMs = 120_000, intervalMs = 2_000 } = {},
): Promise<AdoProject> {
  const process = await defaultProcess(collection)
  const operation = await adoPost<AdoOperation>(
    'projects',
    {
      name,
      description,
      visibility: 'private',
      capabilities: {
        versioncontrol: { sourceControlType: 'Git' },
        processTemplate: { templateTypeId: process.id },
      },
    },
    { collection },
  )

  const deadline = Date.now() + timeoutMs
  let state = operation
  while (state.status !== 'succeeded') {
    if (state.status === 'failed' || state.status === 'cancelled') {
      throw new ApiError(
        502,
        'ado_project_failed',
        state.resultMessage || `Azure DevOps could not create project ${name}.`,
      )
    }
    if (Date.now() > deadline) {
      throw new ApiError(
        504,
        'ado_project_timeout',
        `Azure DevOps is still creating ${name} (operation ${operation.id}). Check the collection before retrying.`,
      )
    }
    await sleep(intervalMs)
    state = await adoGet<AdoOperation>(`operations/${operation.id}`, { collection })
  }

  const created = (await listProjects(collection)).find(
    (p) => p.name.toLowerCase() === name.toLowerCase(),
  )
  if (!created) {
    throw new ApiError(502, 'ado_project_missing', `ADO reported ${name} created but does not list it.`)
  }
  return created
}

/** Where a person would open this in a browser. */
export function webUrlFor(collection: string, project: string, repository?: string): string {
  const { serverUrl } = adoConfig()
  const base = `${serverUrl}/${encodeURIComponent(collection)}/${encodeURIComponent(project)}`
  return repository ? `${base}/_git/${encodeURIComponent(repository)}` : base
}
