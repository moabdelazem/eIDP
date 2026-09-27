import { Hono } from 'hono'

/** Liveness only — it says the process is up, not that LDAP or Postgres are. */
export const healthRoutes = new Hono().get('/', (c) => c.json({ ok: true }))
