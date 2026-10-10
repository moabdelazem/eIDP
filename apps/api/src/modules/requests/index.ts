/** Self-service requests: asked for, decided, carried out in Azure DevOps and Jira (docs/requests.md). */
export { get, listMine, listPool, recoverInterrupted } from './service.ts'
export type { RequestKind, RequestRecord, RequestStatus } from './service.ts'
export { jiraKeyProblem, jiraNameProblem } from './rules.ts'
export { jobs } from './jobs.ts'
/** Read by Platform activity and the digest; written here alone. */
export { requests } from './schema.ts'
