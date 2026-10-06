import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { config } from './config.ts'
import { ensureSchema } from './db.ts'
import { startSampling } from './sampler.ts'

/**
 * The health service on its own: applies its schema, starts sampling, and
 * answers on HEALTH_PORT. It needs the portal for nothing but the portal's
 * own health — when the portal is down, it goes on sampling and says so.
 */
await ensureSchema()
startSampling()
serve({ fetch: createApp().fetch, port: config.HEALTH_PORT }, (info) => {
  console.log(`health service on http://localhost:${info.port} — sampling every ${config.HEALTH_SAMPLE_MINUTES} min, the portal at ${config.PORTAL_URL}`)
})
