/** Platform activity: what `/activity` sends (apps/api modules/activity/service.ts). */

export type Window = '24h' | '7d' | '30d'

/** What the feed can be narrowed to. */
export type Group = 'sign-in' | 'requests' | 'access' | 'jenkins' | 'ai'

/** One line of the feed, said in words, with where it leads. */
export type Activity = {
  id: string
  at: string
  uid: string
  name: string
  kind: string
  group: Group
  /** What they did, after their name: "filed a request for a repository". */
  verb: string
  /** What it was done to, in the mono face: "loan-scoring-api". */
  target: string | null
  /** Where the line leads in the portal, when it leads anywhere. */
  link: string | null
  /** A refused sign-in or a Jenkins action that failed. */
  ok: boolean
  note: string | null
}

export type Overview = {
  window: Window
  /** This window, and the one before it for the deltas. */
  totals: Record<'people' | 'signIns' | 'failedSignIns' | 'visits' | 'requests' | 'decisions' | 'actions' | 'ai', { now: number; before: number }>
  /** Distinct people active in each hour (24h) or day (7d, 30d), oldest first. */
  series: { at: string; people: number; events: number }[]
  /** Pages by visits, top eight plus "Other". */
  sections: { label: string; value: number; people: number }[]
  /** The most active people by what they did (visits not counted). */
  people: { uid: string; name: string; value: number }[]
  /** Names refused five or more times in the window: a lockout in the making, or someone guessing. */
  refused: { uid: string; count: number; reasons: string[]; last: string }[]
  /** How long sign-ins, visits and chatbot questions are kept. */
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
  /** The part of the portal they opened most. */
  topSection: string | null
}

/** The feed's filters, as the query string carries them. */
export type FeedQuery = { window: Window; who?: string; group?: Group; q?: string; before?: string }

/** A page of the feed, newest first; `next` asks for the page before it. */
export type Feed = { items: Activity[]; next: string | null }
