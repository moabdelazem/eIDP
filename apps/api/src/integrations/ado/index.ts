import { adoGetList } from './client.ts'

export { cloneOrUpdate, headCommit } from './git.ts'

export type AdoProject = {
  id: string
  name: string
  description?: string
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

/** Every project in the configured collection. */
export function listProjects(): Promise<AdoProject[]> {
  return adoGetList<AdoProject>('projects', { query: { $top: 1000 } })
}

/** Repositories in one project, or across the collection when omitted. */
export function listRepositories(project?: string): Promise<AdoRepository[]> {
  return adoGetList<AdoRepository>('git/repositories', {
    ...(project ? { project } : {}),
    query: { includeLinks: false },
  })
}
