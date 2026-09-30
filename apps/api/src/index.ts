import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { config } from './lib/config.ts'
import { ensureSchema } from './lib/db.ts'
import { syncCatalog } from './services/catalog.ts'
import { syncJenkins } from './services/jenkins-sync.ts'
import { explainNewFailures } from './services/auto-explain.ts'
import { recoverInterrupted } from './services/requests.ts'

await ensureSchema()

const interrupted = await recoverInterrupted()
if (interrupted > 0) console.warn(`${interrupted} request(s) were interrupted by a restart; marked failed for retry`)

serve({ fetch: createApp().fetch, port: config.PORT })
console.log(`api on http://localhost:${config.PORT}`)

/**
 * The catalog refreshes in the background. A failure here must never stop the
 * API from serving — a stale or empty map is reported through /catalog, not by
 * refusing to start.
 */
function refreshCatalog(reason: string): void {
  if (!config.INVENTORIES_PROJECT) return
  syncCatalog()
    .then((state) => console.log(`catalog sync (${reason}) ok at ${state.commit?.slice(0, 8)}`))
    .catch((err) => console.error(`catalog sync (${reason}) failed:`, err.message))
}

refreshCatalog('boot')
if (config.SYNC_INTERVAL_MINUTES > 0) {
  setInterval(() => refreshCatalog('timer'), config.SYNC_INTERVAL_MINUTES * 60_000).unref()
}

/**
 * Jenkins build history, pulled in the background for the Jenkins page. Like
 * the catalog, a failure is reported on the page (`jenkins_sync`), never by
 * refusing to serve.
 */
if (config.JENKINS_URL && config.JENKINS_USER && config.JENKINS_TOKEN && config.JENKINS_SYNC_SECONDS > 0) {
  // Each sync is followed by explaining the failures it found (auto-explain.ts),
  // one at a time; a slow model never holds up the next sync's timer.
  const refreshJenkins = () =>
    syncJenkins()
      .then(() => explainNewFailures())
      .then(({ explained, failed }) => explained + failed > 0 && console.log(`auto-explain: ${explained} explained, ${failed} could not be`))
      .catch((err) => console.error('jenkins sync failed:', err instanceof Error ? err.message : err))
  void refreshJenkins()
  setInterval(refreshJenkins, config.JENKINS_SYNC_SECONDS * 1000).unref()
}
