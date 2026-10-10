/**
 * Jenkins: build history synced into Postgres, the live queue, actions, who
 * may see which job, retention, and AI explanations of failures (docs/jenkins.md).
 */
export * as jenkins from './service.ts'
export * as explainer from './explainer.ts'
export { accessState, grantsReaching, syncJenkinsAccess } from './access.ts'
export type { AccessState, Reach } from './access.ts'
export { syncJenkins, syncState } from './sync.ts'
export type { SyncState } from './sync.ts'
export { jobs } from './jobs.ts'
