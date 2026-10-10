import { Hono } from 'hono'
import { pingDb } from '../lib/db.ts'
import { isDraining } from '../lib/instance.ts'
import { jobStates } from '../lib/jobs.ts'
import { log } from '../lib/log.ts'
import { secretsState } from '../lib/secrets-state.ts'

/**
 * Liveness only — it says the process is up, not that LDAP or Postgres are.
 * It also says where the settings came from, so a boot that fell back to
 * `.env` because Vault could not be read is visible from outside. The source
 * only: the reason and the names stay in the log.
 *
 * `/health/ready` is whether to send this process requests: Postgres answers,
 * and it is not shutting down. A replica that cannot reach the database is
 * taken out of the Gateway's rotation rather than restarted — restarting
 * would not bring Postgres back, and every replica would do it at once.
 *
 * `/health/jobs` is the background jobs (lib/jobs.ts) for a monitor to read —
 * which ran, when, whether it worked — names and times only, never an error's
 * text. It reads Postgres, so it fails when Postgres does; `/` never does.
 */
export const healthRoutes = new Hono()
  .get('/', (c) => c.json({ ok: true, secrets: secretsState().source }))
  .get('/ready', async (c) => {
    if (isDraining()) return c.json({ ok: false, reason: 'shutting_down' }, 503)
    if (!(await pingDb())) {
      log.warn('not ready: Postgres does not answer')
      return c.json({ ok: false, reason: 'database_unreachable' }, 503)
    }
    return c.json({ ok: true })
  })
  .get('/jobs', async (c) => c.json({ jobs: await jobStates() }))
