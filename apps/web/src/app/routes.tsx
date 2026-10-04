import { Navigate, Route, Routes } from 'react-router'
import { LoginPage } from '@/features/auth/login-page.tsx'
import { ProfilePage } from '@/features/auth/profile-page.tsx'
import { OverviewPage } from '@/features/overview/overview-page.tsx'
import { ProjectMapPage } from '@/features/projects/map-page.tsx'
import { ProjectPage } from '@/features/projects/project-page.tsx'
import { ApprovalsPage } from '@/features/requests/approvals-page.tsx'
import { isAvailable, REQUEST_TYPES } from '@/features/requests/kinds.ts'
import { MyRequestsPage } from '@/features/requests/my-requests-page.tsx'
import { NewRequestPage } from '@/features/requests/new-request-page.tsx'
import { GrantAccessPage } from '@/features/requests/grant-access-page.tsx'
import { JiraProjectPage } from '@/features/requests/jira-project-page.tsx'
import { RequestPage } from '@/features/requests/request-page.tsx'
import { AppShell } from './app-shell.tsx'
import { NotFoundPage } from './not-found-page.tsx'
import { RequirePermission } from './require-permission.tsx'
import { AccessPage } from '@/features/admin/access-page.tsx'
import { JenkinsPage } from '@/features/jenkins/jenkins-page.tsx'
import { AssistantPage } from '@/features/assistant/assistant-page.tsx'
import { BuildPage } from '@/features/jenkins/build-page.tsx'
import { PipelinesPage } from '@/features/pipelines/pipelines-page.tsx'
import { DigestPage } from '@/features/digest/digest-page.tsx'
import { SystemHealthPage } from '@/features/system/health-page.tsx'
import { RequireSession } from './require-session.tsx'

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
            <Route path="assistant/:conversationId?" element={<AssistantPage />} />
          </Route>

          {/* Every path in `manageItems` belongs here, behind the same permission. */}
          <Route element={<RequirePermission permission="requests.decide_access" scoped />}>
            <Route path="approvals" element={<ApprovalsPage />} />
          </Route>
          <Route element={<RequirePermission permission="jenkins.view" />}>
            <Route path="jenkins" element={<JenkinsPage />} />
            <Route path="jenkins/build" element={<BuildPage />} />
          </Route>
          <Route element={<RequirePermission permission="system.health" />}>
            <Route path="system" element={<SystemHealthPage />} />
          </Route>
          <Route element={<RequirePermission permission="rbac.manage" />}>
            <Route path="access" element={<AccessPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}
