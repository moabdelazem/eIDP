export type { AccessLevel, Check, RequestKind, RequestRecord, RequestStatus } from '@eidp/contracts/requests'

/**
 * Requests, from the form to the thing existing: `check` (what the form asks
 * as someone types, and what `submit` runs), the lifecycle (pending →
 * approved → completed or failed, or rejected or cancelled), and one
 * executor per kind — `execute.ts` runs the Azure DevOps creations and
 * dispatches the rest (`grant.ts`, `jira-project.ts`) while it heartbeats.
 * Who may decide is `deciding.ts`; rows and their shape are `rows.ts`.
 * A new kind is a new executor file and a branch in `execute.ts`.
 */

export { asTarget } from './requests/model.ts'
export type { Actor, AdoTarget, JiraTarget, NewRequest, Target } from './requests/model.ts'
export { check } from './requests/check.ts'
export { HISTORY_LIMIT, approve, cancel, get, listHistory, listMine, listPool, reassess, reject, retry, submit } from './requests/lifecycle.ts'
export { recoverInterrupted } from './requests/execute.ts'
