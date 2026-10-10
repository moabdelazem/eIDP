import { Hono } from 'hono'
import { onError } from './lib/errors.ts'
import type { AppEnv } from './middleware/auth.ts'
import { observe } from './middleware/observe.ts'
import { authRoutes } from './modules/auth/routes.ts'
import { activityRoutes } from './modules/activity/routes.ts'
import { adoRoutes } from './modules/requests/ado-routes.ts'
import { jiraRoutes } from './modules/requests/jira-routes.ts'
import { jenkinsRoutes } from './modules/jenkins/routes.ts'
import { pipelineRoutes } from './modules/pipelines/routes.ts'
import { chatbotRoutes } from './modules/chatbot/routes.ts'
import { catalogRoutes } from './modules/catalog/routes.ts'
import { requestRoutes } from './modules/requests/routes.ts'
import { rbacRoutes } from './modules/access/routes.ts'
import { digestRoutes } from './modules/digest/routes.ts'
import { healthRoutes } from './modules/health/routes.ts'

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
