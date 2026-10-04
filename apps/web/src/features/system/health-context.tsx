import { createContext, useCallback, useContext, useState } from 'react'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { useResource } from '@/lib/use-resource.ts'
import { systemApi, type Health } from './api.ts'

type Value = {
  /** The latest answer, or null for anyone without `system.health`, and until the first one lands. */
  health: Health | null
  /** A fresher answer from somewhere else — the health page's Check again — so the sidebar never lags it. */
  publish: (health: Health) => void
}

const HealthContext = createContext<Value>({ health: null, publish: () => {} })

/**
 * The portal's health for the chrome around every page: asked once a minute,
 * shared by everything that shows it (the sidebar's alert and the badge on
 * System health), and only for people who may see it — nobody else's browser
 * asks at all. The API keeps one answer per 15 seconds, so a minute's poll
 * from every open tab costs the checked systems nothing extra.
 */
export function SystemHealthProvider({ children }: { children: React.ReactNode }) {
  const { can, loaded } = useProfile()
  const allowed = loaded && can('system.health')
  const polled = useResource(() => (allowed ? systemApi.health() : Promise.resolve(null)), [allowed], { pollMs: allowed ? 60_000 : null })
  const [published, setPublished] = useState<Health | null>(null)
  const publish = useCallback((health: Health) => setPublished(health), [])
  // Whichever was checked last.
  const latest = polled.data && (!published || polled.data.checkedAt >= published.checkedAt) ? polled.data : published
  return <HealthContext.Provider value={{ health: allowed ? latest : null, publish }}>{children}</HealthContext.Provider>
}

export function useSystemHealth(): Value {
  return useContext(HealthContext)
}
