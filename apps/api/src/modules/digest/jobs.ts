import { config } from '../../lib/config.ts'
import type { Job } from '../../lib/jobs.ts'
import { generateDue } from './service.ts'

/** Last week's digest for every team, once the week is over; a restart over the weekend still writes Monday's. */
export const jobs: Job[] = [
  {
    name: 'weekly-digests',
    everyMs: config.DIGEST_CHECK_MINUTES * 60_000,
    run: async () => {
      const { made, failed } = await generateDue()
      return made + failed > 0 ? `${made} written, ${failed} could not be` : null
    },
  },
]
