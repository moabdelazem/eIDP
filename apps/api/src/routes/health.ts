import { Hono } from 'hono'
import { jobStates } from '../lib/jobs.ts'
import { secretsState } from '../lib/secrets-state.ts'

/**
 * Liveness only — it says the process is up, not that LDAP or Postgres are.
 * It also says where the settings came from, so a boot that fell back to
 * `.env` because Vault could not be read is visible from outside. The source
 * only: the reason and the names stay in the log.
 *
 * `/health/jobs` is the background jobs (lib/jobs.ts) for a monitor to read —
 * which ran, when, whether it worked — names and times only, never an error's
 * text. It reads Postgres, so it fails when Postgres does; `/` never does.
 */
export const healthRoutes = new Hono()
  .get('/', (c) => c.json({ ok: true, secrets: secretsState().source }))
  .get('/jobs', async (c) => c.json({ jobs: await jobStates() }))
