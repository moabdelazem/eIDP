import type { AccessLevel, RequestKind, Target as RequestBody } from '@eidp/contracts/requests'

/**
 * What a request is asked for with, and who asks.
 */

/** Enough for a team; a larger grant is a group's job, not a list of names. */
export const MAX_GRANTEES = 20

export type { Actor } from '../../lib/actor.ts'


/** What is being asked for in Azure DevOps. */
export type AdoTarget = {
  kind: Exclude<RequestKind, 'create_jira_project'>
  collection: string
  project: string
  repository?: string
  description?: string
  /** grant_access only. */
  grantees?: string[]
  accessLevel?: AccessLevel
}

/** A Jira project: `project` is its name, `projectKey` its key. */
export type JiraTarget = {
  kind: 'create_jira_project'
  project: string
  projectKey: string
  description?: string
}

export type Target = AdoTarget | JiraTarget

/** The web sends a contract Target; this stops compiling if one is ever something check() and submit() do not accept. */
export const asTarget = (body: RequestBody): Target => body

export type NewRequest = Target & {
  justification: string
  /** Creations only. */
  teamGroup?: string
}
