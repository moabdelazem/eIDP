import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { onError } from './lib/errors.ts'
import type { AppEnv } from './middleware/auth.ts'
import { authRoutes } from './routes/auth.ts'
import { catalogRoutes } from './routes/catalog.ts'
import { healthRoutes } from './routes/health.ts'

/**
 * Builds the app without listening, so tests can drive it through
 * `app.request()` instead of a real socket. Mount new route modules here.
 */
export function createApp() {
  const app = new Hono<AppEnv>()

  app.use(logger())
  app.onError(onError)

  app.route('/health', healthRoutes)
  app.route('/auth', authRoutes)
  app.route('/catalog', catalogRoutes)

  return app
}

export type AppType = ReturnType<typeof createApp>
