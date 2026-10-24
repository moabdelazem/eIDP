/** A project's page: its code and who can work in it (apps/api modules/projects). */
import type { RequestStatus } from './requests.ts'

/** One Git repository in the project's Azure DevOps project. */
export type ProjectRepository = {
  name: string
  /** Where to open it in Azure DevOps. */
  url: string | null
  /** The applications the catalog builds from it: it has a pipeline when there is one. */
  applications: string[]
  /** An open request for a pipeline from it, when there is one. */
  pipelineRequest: { id: string; status: RequestStatus; application: string } | null
}

/** Someone, or a group, with access to the project — directly in its Contributors or Readers. */
export type ProjectMember = {
  /** The account name, as a removal request names it. */
  account: string
  displayName: string
  group: boolean
  /** Which of the project's groups they are in. */
  in: ('Contributors' | 'Readers')[]
  /** An open request to remove them, when there is one. */
  removal: { id: string; requestedByName: string } | null
}

/**
 * `GET /projects/:system`: a system of the catalog as a project to work in.
 * What Azure DevOps could not answer is said beside an empty list rather
 * than failing the page: the catalog half still stands.
 */
export type ProjectView = {
  system: { id: string; projectName: string; company: string | null; teams: Record<string, string> }
  /** Its Azure DevOps project; null when no collection has one by that name. */
  ado: { collection: string; project: string; url: string } | null
  repositories: ProjectRepository[]
  /** Why the repositories could not be read, or why there are none to read. */
  repositoriesError: string | null
  members: ProjectMember[]
  membersError: string | null
}
