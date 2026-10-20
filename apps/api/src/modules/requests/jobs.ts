import type { Job } from '../../lib/jobs.ts'
import { advanceSteps } from './pipeline/follow-up.ts'
import { recoverInterrupted } from './service.ts'

/** Requests whose creation stopped heartbeating — a process that died mid-way, noticed without a restart. */
export const jobs: Job[] = [
  {
    name: 'request-recovery',
    everyMs: 60_000,
    run: async () => {
      const n = await recoverInterrupted()
      return n ? `${n} interrupted request(s) marked failed for retry` : null
    },
  },
  {
    // An approved pipeline's provisioning and test build, through Jenkins' queue to a result.
    name: 'pipeline-steps',
    everyMs: 10_000,
    run: async () => {
      const n = await advanceSteps()
      return n ? `${n} pipeline step(s) moved on` : null
    },
  },
]
