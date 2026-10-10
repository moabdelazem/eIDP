import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { config } from './lib/config.ts'
import { migrate } from './lib/db.ts'
import { schedule } from './lib/jobs.ts'
import { syncCatalog } from './services/catalog.ts'
import { syncJenkins } from './services/jenkins-sync.ts'
import { syncJenkinsAccess } from './services/jenkins-access.ts'
import { prune as pruneActivity } from './services/activity.ts'
import { pruneJenkins } from './services/jenkins-retention.ts'
import { generateDue } from './services/digest.ts'
import { explainNewFailures } from './services/auto-explain.ts'
import { recoverInterrupted } from './services/requests.ts'

const applied = await migrate()
if (applied.length) console.log(`database: applied ${applied.join(', ')}`)

const interrupted = await recoverInterrupted()
if (interrupted > 0) console.warn(`${interrupted} request(s) were interrupted by a restart; marked failed for retry`)

serve({ fetch: createApp().fetch, port: config.PORT })
console.log(`api on http://localhost:${config.PORT}`)

/*
 * Background work, through lib/jobs.ts: each job runs in one process per
 * interval however many API processes are up, a failure is logged and
 * recorded but never stops the API, and /health/jobs says how each last went.
 */

const MINUTE = 60_000
const jenkinsOn = Boolean(config.JENKINS_URL && config.JENKINS_USER && config.JENKINS_TOKEN)

/** The catalog. A stale or empty map is reported through /catalog, not by refusing to start. */
schedule({
  name: 'catalog-sync',
  everyMs: config.SYNC_INTERVAL_MINUTES * MINUTE,
  enabled: Boolean(config.INVENTORIES_PROJECT),
  run: async () => `ok at ${(await syncCatalog()).commit?.slice(0, 8)}`,
})
// With the timer off (0) the map is still built once at boot, as it always was.
if (config.INVENTORIES_PROJECT && config.SYNC_INTERVAL_MINUTES <= 0) {
  syncCatalog().catch((err) => console.error('catalog sync (boot) failed:', err instanceof Error ? err.message : err))
}

/**
 * Jenkins build history, then the failures it found explained (auto-explain.ts),
 * one at a time. Reported on the page (`jenkins_sync`) when it fails.
 */
schedule({
  name: 'jenkins-sync',
  everyMs: config.JENKINS_SYNC_SECONDS * 1000,
  enabled: jenkinsOn,
  run: async () => {
    await syncJenkins()
    const { explained, failed } = await explainNewFailures()
    return explained + failed > 0 ? `auto-explain: ${explained} explained, ${failed} could not be` : null
  },
})

/** Who Jenkins lets see which job. A failed read keeps the previous rules and says why. */
schedule({
  name: 'jenkins-access',
  everyMs: config.JENKINS_ACCESS_SYNC_MINUTES * MINUTE,
  enabled: jenkinsOn,
  run: async () => {
    const state = await syncJenkinsAccess()
    if (!state.ok) throw new Error(state.error ?? 'the read failed')
    return null
  },
})

/** Jenkins history past JENKINS_RETENTION_DAYS — whether or not Jenkins is still configured. */
schedule({
  name: 'jenkins-retention',
  everyMs: 60 * MINUTE,
  run: async () => {
    const gone = Object.entries(await pruneJenkins()).filter(([, n]) => n > 0)
    return gone.length ? `deleted ${gone.map(([what, n]) => `${n} ${what}`).join(', ')}` : null
  },
})

/** Platform activity older than ACTIVITY_RETENTION_DAYS. */
schedule({
  name: 'activity-retention',
  everyMs: 60 * MINUTE,
  run: async () => {
    const n = await pruneActivity()
    return n ? `deleted ${n} old event(s)` : null
  },
})

/** Last week's digest for every team, once the week is over; a restart over the weekend still writes Monday's. */
schedule({
  name: 'weekly-digests',
  everyMs: config.DIGEST_CHECK_MINUTES * MINUTE,
  run: async () => {
    const { made, failed } = await generateDue()
    return made + failed > 0 ? `${made} written, ${failed} could not be` : null
  },
})

/** Requests whose creation stopped heartbeating — a process that died mid-way, noticed without a restart. */
schedule({
  name: 'request-recovery',
  everyMs: MINUTE,
  run: async () => {
    const n = await recoverInterrupted()
    return n ? `${n} interrupted request(s) marked failed for retry` : null
  },
})
