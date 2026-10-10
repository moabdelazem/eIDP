import type { RequestRecord } from '@eidp/contracts/requests'
import { can, teamsOwning, type Access } from '../rbac.ts'
import { ApiError } from '../../lib/errors.ts'
import { find } from './rows.ts'

/**
 * Whether `access` may decide this request. Creations are DevOps' alone
 * (`requests.decide`); an access request may also be decided by whoever holds
 * `requests.decide_access` for its project or for a team that owns it.
 *
 * Deciding your own request is allowed: the team chose speed over a second
 * pair of eyes, and decided_by still records who approved what.
 */
export async function mayDecide(request: RequestRecord, access: Access): Promise<boolean> {
  if (can(access, 'requests.decide')) return true
  if (request.kind !== 'grant_access') return false
  return can(access, 'requests.decide_access', { project: request.project, teams: await teamsOwning(request.project) })
}

/** The ids among `requests` that `access` may decide, looking each project's teams up once. */
export async function decidableBy(access: Access, requests: RequestRecord[]): Promise<Set<string>> {
  const teams = new Map<string, string[]>()
  const ids = new Set<string>()
  for (const request of requests) {
    if (request.kind !== 'grant_access') continue
    const key = request.project.toLowerCase()
    if (!teams.has(key)) teams.set(key, await teamsOwning(request.project))
    if (can(access, 'requests.decide_access', { project: request.project, teams: teams.get(key)! })) ids.add(request.id)
  }
  return ids
}

export async function assertCanDecide(id: string, access: Access): Promise<void> {
  const request = await find(id) // 404 when it does not exist
  if (!(await mayDecide(request, access))) {
    throw new ApiError(
      403,
      'forbidden',
      request.kind === 'grant_access'
        ? 'You can’t decide this request: it is for a project outside the teams you approve for.'
        : 'Only DevOps can decide requests to create repositories and projects.',
    )
  }
}
