import { api } from '@/lib/api-client.ts'

// The JSON's shapes are the API's, from @eidp/contracts — one definition, so the two cannot drift.
import type { Feed, FeedQuery, Overview, Person, Window as ActivityWindow } from '@eidp/contracts/activity'
export type { Activity, FeedQuery, Group, Overview, Person, Window as ActivityWindow } from '@eidp/contracts/activity'

export const WINDOW_LABEL: Record<ActivityWindow, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' }

export const activityApi = {
  overview: (window: ActivityWindow) => api<Overview>(`/activity/overview?window=${window}`),
  people: (window: ActivityWindow) => api<Person[]>(`/activity/people?window=${window}`),
  feed: (query: FeedQuery) => {
    const params = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => Boolean(e[1])))
    return api<Feed>(`/activity/feed?${params}`)
  },
}
