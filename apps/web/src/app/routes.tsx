import { Navigate, Route, Routes, useParams } from 'react-router'
import { LoginPage } from '@/features/auth/login-page.tsx'
import { OverviewPage } from '@/features/overview/overview-page.tsx'
import { isAvailable, REQUEST_TYPES } from '@/features/requests/kinds.ts'
import { AppShell } from './app-shell.tsx'
import { NotFoundPage } from './not-found-page.tsx'
import { RequirePermission } from './require-permission.tsx'
import { RequireSession } from './require-session.tsx'
import { lazyPage } from './lazy-page.ts'

// Every page but the landing one and sign-in is its own chunk, fetched when first opened.
const ActivityPage = lazyPage(() => import('@/features/activity/activity-page.tsx'), 'ActivityPage')
const ProfilePage = lazyPage(() => import('@/features/auth/profile-page.tsx'), 'ProfilePage')
const ProjectMapPage = lazyPage(() => import('@/features/projects/map-page.tsx'), 'ProjectMapPage')
const ProjectPage = lazyPage(() => import('@/features/projects/project-page.tsx'), 'ProjectPage')
const ApprovalsPage = lazyPage(() => import('@/features/requests/approvals-page.tsx'), 'ApprovalsPage')
const MyRequestsPage = lazyPage(() => import('@/features/requests/my-requests-page.tsx'), 'MyRequestsPage')
const NewRequestPage = lazyPage(() => import('@/features/requests/new-request-page.tsx'), 'NewRequestPage')
const GrantAccessPage = lazyPage(() => import('@/features/requests/grant-access-page.tsx'), 'GrantAccessPage')
const JiraProjectPage = lazyPage(() => import('@/features/requests/jira-project-page.tsx'), 'JiraProjectPage')
const RequestPage = lazyPage(() => import('@/features/requests/request-page.tsx'), 'RequestPage')
const AccessPage = lazyPage(() => import('@/features/admin/access-page.tsx'), 'AccessPage')
const JenkinsPage = lazyPage(() => import('@/features/jenkins/jenkins-page.tsx'), 'JenkinsPage')
const ChatbotPage = lazyPage(() => import('@/features/chatbot/chatbot-page.tsx'), 'ChatbotPage')
const BuildPage = lazyPage(() => import('@/features/jenkins/build-page.tsx'), 'BuildPage')
const PipelinesPage = lazyPage(() => import('@/features/pipelines/pipelines-page.tsx'), 'PipelinesPage')
const DigestPage = lazyPage(() => import('@/features/digest/digest-page.tsx'), 'DigestPage')

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireSession />}>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="map" element={<ProjectMapPage />} />
          <Route path="projects/:projectId" element={<ProjectPage />} />
          <Route path="requests" element={<MyRequestsPage />} />
          {/* One route per request type that has a form — see features/requests/kinds.ts. */}
          {REQUEST_TYPES.filter(isAvailable).map((type) => (
            <Route
              key={type.path}
              path={type.path.slice(1)}
              element={
                type.kind === 'grant_access' ? (
                  <GrantAccessPage />
                ) : type.kind === 'create_jira_project' ? (
                  <JiraProjectPage />
                ) : (
                  <NewRequestPage key={type.path} kind={type.kind!} />
                )
              }
            />
          ))}
          {/* Where these lived before request types were grouped by provider. */}
          <Route path="requests/new/repository" element={<Navigate to="/requests/new/azure-devops/repository" replace />} />
          <Route path="requests/new/project" element={<Navigate to="/requests/new/azure-devops/project" replace />} />
          <Route path="requests/:requestId" element={<RequestPage />} />
          <Route path="me" element={<ProfilePage />} />
          <Route path="digest" element={<DigestPage />} />
          {/* One route with an optional id: a new chat gets its URL mid-answer, and must not remount while it streams. */}
          {/* A build of your own pipeline opens on the Jenkins build page; the API checks it is yours. */}
          <Route element={<RequirePermission permission="pipelines.view" />}>
            <Route path="pipelines" element={<PipelinesPage />} />
            <Route path="pipelines/build" element={<BuildPage />} />
          </Route>
          <Route element={<RequirePermission permission="ai.chat" />}>
            <Route path="chatbot/:conversationId?" element={<ChatbotPage />} />
          </Route>
          {/* Where the chatbot lived when it was the assistant. */}
          <Route path="assistant/:conversationId?" element={<ToChatbot />} />

          {/* Every path in `manageItems` belongs here, behind the same permission. */}
          <Route element={<RequirePermission permission="requests.decide_access" scoped />}>
            <Route path="approvals" element={<ApprovalsPage />} />
          </Route>
          <Route element={<RequirePermission permission="jenkins.view" />}>
            <Route path="jenkins" element={<JenkinsPage />} />
            <Route path="jenkins/build" element={<BuildPage />} />
          </Route>
          <Route element={<RequirePermission permission="rbac.manage" />}>
            <Route path="access" element={<AccessPage />} />
          </Route>
          <Route element={<RequirePermission permission="activity.view" />}>
            <Route path="activity" element={<ActivityPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}

function ToChatbot() {
  const { conversationId } = useParams()
  return <Navigate to={conversationId ? `/chatbot/${conversationId}` : '/chatbot'} replace />
}
