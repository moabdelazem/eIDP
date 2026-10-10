import type { AuditEntry, Category, Failure, ParameterFacet, RunDetail, Ignore, IgnoreFor, Overview, Recovery, Run, Stats, Totals, Window } from '@eidp/contracts/jenkins'
export type { AuditEntry, Failure, Ignore, IgnoreFor, Overview, Recovery, Run, Stats, Totals, Window }

/**
 * Jenkins as DevOps need to see it: what is broken now, how the last day or
 * week went, every build searchable by what it was given — and the few
 * things worth doing about it from here (run again, stop, dequeue).
 *
 * History comes from `jenkins_builds`, which `jenkins-sync.ts` keeps current;
 * the queue and agents are asked of Jenkins live, since only "now" matters
 * for them. Every action goes to Jenkins as the service account, so
 * `jenkins_audit` records who actually asked, refusals included.
 */

export { IGNORE_HOLDS, WINDOWS, toRun } from './jenkins/shared.ts'
export type { RunRow } from './jenkins/shared.ts'
export { overview, queueNow } from './jenkins/now.ts'
export { stats } from './jenkins/stats.ts'
export { PAGE_LIMIT, parameters, run, runs } from './jenkins/search.ts'
export type { RunFilter } from './jenkins/search.ts'
export { IGNORE_FOR, cancel, ignore, listAudit, rebuild, stop, unignore } from './jenkins/actions.ts'
