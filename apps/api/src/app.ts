import { Hono } from 'hono'
import { onError } from './lib/errors.ts'
import type { AppEnv } from './middleware/auth.ts'
import { observe } from './middleware/observe.ts'
import { authRoutes } from './routes/auth.ts'
import { activityRoutes } from './routes/activity.ts'
import { adoRoutes } from './routes/ado.ts'
import { jiraRoutes } from './routes/jira.ts'
import { jenkinsRoutes } from './routes/jenkins.ts'
import { pipelineRoutes } from './routes/pipelines.ts'
import { chatbotRoutes } from './routes/chatbot.ts'
import { catalogRoutes } from './routes/catalog.ts'
import { requestRoutes } from './routes/requests.ts'
import { rbacRoutes } from './routes/rbac.ts'
import { digestRoutes } from './routes/digests.ts'
import { healthRoutes } from './routes/health.ts'

/**
 * Builds the app without listening, so tests can drive it through
 * `app.request()` instead of a real socket. Mount new route modules here.
 */
export function createApp() {
  const app = new Hono<AppEnv>()

  app.use(observe)
  app.onError(onError)

  app.route('/health', healthRoutes)
  app.route('/auth', authRoutes)
  app.route('/catalog', catalogRoutes)
  app.route('/requests', requestRoutes)
  app.route('/ado', adoRoutes)
  app.route('/jira', jiraRoutes)
  app.route('/jenkins', jenkinsRoutes)
  app.route('/pipelines', pipelineRoutes)
  app.route('/chatbot', chatbotRoutes)
  app.route('/rbac', rbacRoutes)
  app.route('/digests', digestRoutes)
  app.route('/activity', activityRoutes)

  return app
}

export type AppType = ReturnType<typeof createApp>
