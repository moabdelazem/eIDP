import { Hono } from 'hono'
import { secretsState } from '../lib/secrets-state.ts'

/**
 * Liveness only — it says the process is up, not that LDAP or Postgres are.
 * It also says where the settings came from, so a boot that fell back to
 * `.env` because Vault could not be read is visible from outside. The source
 * only: the reason and the names stay in the log.
 */
export const healthRoutes = new Hono().get('/', (c) => c.json({ ok: true, secrets: secretsState().source }))
