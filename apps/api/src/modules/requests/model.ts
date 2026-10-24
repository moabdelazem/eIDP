import type { AccessLevel, RequestKind, Target as RequestBody } from '@eidp/contracts/requests'
import type { PipelineTarget } from './pipeline/check.ts'

/**
 * What a request is asked for with, and who asks.
 */

/** Enough for a team; a larger grant is a group's job, not a list of names. */
export const MAX_GRANTEES = 20

export type { Actor } from '../../lib/actor.ts'


/** What is being asked for in Azure DevOps. */
export type AdoTarget = {
  kind: Exclude<RequestKind, 'create_jira_project' | 'create_pipeline'>
  collection: string
  project: string
  repository?: string
  description?: string
  /** grant_access and revoke_access: who is given or loses access. */
  grantees?: string[]
  accessLevel?: AccessLevel
  /** create_project only: login names that get Contributor with the requester and their team. */
  developers?: string[]
}

/** A Jira project: `project` is its name, `projectKey` its key. */
export type JiraTarget = {
  kind: 'create_jira_project'
  project: string
  projectKey: string
  description?: string
  /** Who leads it, by login name, when not the requester. */
  lead?: string
}

export type { PipelineTarget } from './pipeline/check.ts'

export type Target = AdoTarget | JiraTarget | PipelineTarget

/** The web sends a contract Target; this stops compiling if one is ever something check() and submit() do not accept. */
export const asTarget = (body: RequestBody): Target => body

export type NewRequest = Target & {
  justification: string
  /** Creations only. */
  teamGroup?: string
}
