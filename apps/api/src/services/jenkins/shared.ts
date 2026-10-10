import type { Run } from '@eidp/contracts/jenkins'
import * as jenkins from '../../integrations/jenkins/index.ts'
import type { Parameter, Result } from '../../integrations/jenkins/index.ts'
import { ignore } from './actions.ts'
import { parameters } from './search.ts'

/**
 * What every part of the Jenkins page shares: which ignores hold, the windows, the server, and a stored build as a Run.
 */

/**
 * Whether the ignore row `i` still holds: until the job passes after the build
 * it was ignored at, or until it expires. SQL, so every reader agrees.
 */
export const IGNORE_HOLDS = `((i.until_pass and not exists (
    select 1 from jenkins_builds p where p.server = i.server and p.job = i.job and p.number > i.from_number and p.result = 'success'))
  or (not i.until_pass and (i.expires_at is null or i.expires_at > now())))`

export const WINDOWS = { '24h': { hours: 24, bucket: 1 }, '7d': { hours: 168, bucket: 6 } } as const

export const server = () => jenkins.jenkinsConfig().url

export type RunRow = {
  job: string
  number: number
  result: Result
  started_at: Date
  duration_ms: string
  url: string
  built_on: string | null
  parameters: Parameter[]
  causes: string[]
}

export function toRun(row: RunRow): Run {
  return {
    job: row.job,
    number: row.number,
    result: row.result,
    startedAt: row.started_at.toISOString(),
    durationMs: Number(row.duration_ms),
    url: row.url,
    builtOn: row.built_on,
    causes: row.causes,
    parameters: row.parameters,
  }
}
