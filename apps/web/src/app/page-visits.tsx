import { useEffect } from 'react'
import { useLocation } from 'react-router'
import { useSession } from '@/features/auth/session-context.tsx'
import { api } from '@/lib/api-client.ts'

/**
 * Tells the portal which page was opened, for Platform activity: the path
 * only — never the query, which can carry what someone searched for. A
 * search-param change is not a new page, so it is not reported.
 *
 * Not while viewing as someone: what an admin looks at must never be put down
 * to the person they view as (the API refuses it too). A visit that cannot be
 * reported is simply not counted; nobody is told.
 */
export function PageVisits() {
  const { pathname } = useLocation()
  const { session } = useSession()
  const viewing = Boolean(session?.actor)
  useEffect(() => {
    if (viewing) return
    api('/activity/visit', { method: 'POST', body: JSON.stringify({ path: pathname }) }).catch(() => {})
  }, [pathname, viewing])
  return null
}
