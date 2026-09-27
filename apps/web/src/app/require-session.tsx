import { Navigate, Outlet, useLocation } from 'react-router'
import { useSession } from '@/features/auth/session-context.tsx'

/** Guards everything behind it. Remembers where you were headed. */
export function RequireSession() {
  const { session } = useSession()
  const location = useLocation()

  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <Outlet />
}
