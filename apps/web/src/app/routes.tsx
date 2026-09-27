import { Route, Routes } from 'react-router'
import { LoginPage } from '@/features/auth/login-page.tsx'
import { ProjectMapPage } from '@/features/projects/map-page.tsx'
import { ProjectPage } from '@/features/projects/project-page.tsx'
import { RequestsPage } from '@/features/requests/requests-page.tsx'
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
          <Route path="requests" element={<RequestsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}
