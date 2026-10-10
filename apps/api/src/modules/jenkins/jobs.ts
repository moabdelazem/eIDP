import { config } from '../../lib/config.ts'
import type { Job } from '../../lib/jobs.ts'
import { syncJenkinsAccess } from './access.ts'
import { explainNewFailures } from './auto-explain.ts'
import { pruneJenkins } from './retention.ts'
import { syncJenkins } from './sync.ts'

const jenkinsOn = Boolean(config.JENKINS_URL && config.JENKINS_USER && config.JENKINS_TOKEN)

export const jobs: Job[] = [
  /**
   * Jenkins build history, then the failures it found explained (auto-explain.ts),
   * one at a time. Reported on the page (`jenkins_sync`) when it fails.
   */
  {
    name: 'jenkins-sync',
    everyMs: config.JENKINS_SYNC_SECONDS * 1000,
    enabled: jenkinsOn,
    run: async () => {
      await syncJenkins()
      const { explained, failed } = await explainNewFailures()
      return explained + failed > 0 ? `auto-explain: ${explained} explained, ${failed} could not be` : null
    },
  },
  /** Who Jenkins lets see which job. A failed read keeps the previous rules and says why. */
  {
    name: 'jenkins-access',
    everyMs: config.JENKINS_ACCESS_SYNC_MINUTES * 60_000,
    enabled: jenkinsOn,
    run: async () => {
      const state = await syncJenkinsAccess()
      if (!state.ok) throw new Error(state.error ?? 'the read failed')
      return null
    },
  },
  /** Jenkins history past JENKINS_RETENTION_DAYS — whether or not Jenkins is still configured. */
  {
    name: 'jenkins-retention',
    everyMs: 60 * 60_000,
    run: async () => {
      const gone = Object.entries(await pruneJenkins()).filter(([, n]) => n > 0)
      return gone.length ? `deleted ${gone.map(([what, n]) => `${n} ${what}`).join(', ')}` : null
    },
  },
]
