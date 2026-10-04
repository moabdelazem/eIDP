import { api } from '@/lib/api-client.ts'

/** Mirrors the API's services/activity.ts. */

export type ActivityWindow = '24h' | '7d' | '30d'
export const WINDOW_LABEL: Record<ActivityWindow, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' }

export type Group = 'sign-in' | 'requests' | 'access' | 'jenkins' | 'ai'

export type Activity = {
  id: string
  at: string
  uid: string
  name: string
  kind: string
  group: Group
  verb: string
  target: string | null
  link: string | null
  ok: boolean
  note: string | null
}

type Count = { now: number; before: number }

export type Overview = {
  window: ActivityWindow
  totals: Record<'people' | 'signIns' | 'failedSignIns' | 'visits' | 'requests' | 'decisions' | 'actions' | 'ai', Count>
  series: { at: string; people: number; events: number }[]
  sections: { label: string; value: number; people: number }[]
  people: { uid: string; name: string; value: number }[]
  refused: { uid: string; count: number; reasons: string[]; last: string }[]
  retentionDays: number
}

export type Person = {
  uid: string
  name: string
  lastSeen: string
  signIns: number
  failedSignIns: number
  visits: number
  requests: number
  decisions: number
  actions: number
  ai: number
  topSection: string | null
}

export type FeedQuery = { window: ActivityWindow; who?: string; group?: Group; q?: string; before?: string }

export const activityApi = {
  overview: (window: ActivityWindow) => api<Overview>(`/activity/overview?window=${window}`),
  people: (window: ActivityWindow) => api<Person[]>(`/activity/people?window=${window}`),
  feed: (query: FeedQuery) => {
    const params = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => Boolean(e[1])))
    return api<{ items: Activity[]; next: string | null }>(`/activity/feed?${params}`)
  },
}
