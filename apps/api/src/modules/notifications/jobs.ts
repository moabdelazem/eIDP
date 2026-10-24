import { mailConfigured } from '../../integrations/mail/index.ts'
import type { Job } from '../../lib/jobs.ts'
import { sendDue } from './service.ts'

/** Sends queued mail, and retries what the server refused, one process at a time. */
export const jobs: Job[] = [
  {
    name: 'mail-outbox',
    everyMs: 15_000,
    enabled: mailConfigured(),
    run: async () => {
      const { sent, failed } = await sendDue()
      return sent || failed ? `${sent} mail(s) sent${failed ? `, ${failed} failed for good` : ''}` : null
    },
  },
]
