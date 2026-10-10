import type { Job } from '../../lib/jobs.ts'
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
]
