import { Route, Routes } from 'react-router'
import { LoginPage } from '@/features/auth/login-page.tsx'
import { ProjectMapPage } from '@/features/projects/map-page.tsx'
import { ProjectPage } from '@/features/projects/project-page.tsx'
import { ApprovalsPage } from '@/features/requests/approvals-page.tsx'
import { MyRequestsPage } from '@/features/requests/my-requests-page.tsx'
import { NewRequestPage } from '@/features/requests/new-request-page.tsx'
import { RequestPage } from '@/features/requests/request-page.tsx'
import { AppShell } from './app-shell.tsx'
import { NotFoundPage } from './not-found-page.tsx'
import { RequireSession } from './require-session.tsx'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireSession />}>
        <Route element={<AppShell />}>
          <Route index element={<ProjectMapPage />} />
          <Route path="projects/:projectId" element={<ProjectPage />} />
          <Route path="requests" element={<MyRequestsPage />} />
          <Route path="requests/new/repository" element={<NewRequestPage key="repo" kind="create_repository" />} />
          <Route path="requests/new/project" element={<NewRequestPage key="project" kind="create_project" />} />
          <Route path="requests/:requestId" element={<RequestPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}
