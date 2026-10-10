import type { Job } from '../../lib/jobs.ts'
import { prune } from './service.ts'

/** Platform activity older than ACTIVITY_RETENTION_DAYS. */
export const jobs: Job[] = [
  {
    name: 'activity-retention',
    everyMs: 60 * 60_000,
    run: async () => {
      const n = await prune()
      return n ? `deleted ${n} old event(s)` : null
    },
  },
]
