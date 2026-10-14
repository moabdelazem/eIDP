import type { Profile } from '@eidp/contracts/auth'
import type { Datum } from './charts.tsx'

/** The Overview's cards: their names and what they are for, and which someone gets. The cards themselves are cards.tsx. */

export type CardId = 'needs-you' | 'approvals' | 'jenkins' | 'pipelines' | 'requests' | 'projects' | 'catalog'

export type CardInfo = { id: CardId; title: string; description: string; wide?: boolean }

export const CARDS: Record<CardId, CardInfo> = {
  'needs-you': { id: 'needs-you', title: 'Needs you', description: 'What is waiting on you, across the portal.', wide: true },
  approvals: { id: 'approvals', title: 'Waiting on you', description: 'Requests you can decide, oldest first.' },
  jenkins: { id: 'jenkins', title: 'Jenkins now', description: 'Failing, running, queued, and agents down.' },
  pipelines: { id: 'pipelines', title: 'Your pipelines', description: 'Yours and your teams’, broken first, over 7 days.' },
  requests: { id: 'requests', title: 'Your requests', description: 'What you asked for, newest first.' },
  projects: { id: 'projects', title: 'Your teams’ projects', description: 'Systems in the inventories a group of yours owns.' },
  catalog: { id: 'catalog', title: 'The catalog', description: 'Every system and application, by technology and size.', wide: true },
}

/** Who someone is, as the cards need it. */
export type Viewer = {
  profile: Profile | undefined
  decider: boolean
  jenkins: boolean
  pipelines: boolean
  catalog: boolean
  syncs: boolean
}

/** The cards this person may see, in the default order; and the ones that start hidden for them. */
export function cardsFor(v: Viewer): { available: CardId[]; hiddenByDefault: Set<CardId> } {
  const available: CardId[] = ['needs-you']
  if (v.decider) available.push('approvals')
  if (v.jenkins) available.push('jenkins')
  if (v.pipelines) available.push('pipelines')
  available.push('requests')
  if (v.catalog) available.push('projects', 'catalog')
  // The whole catalog's charts are DevOps' view; anyone else can turn them on.
  return { available, hiddenByDefault: new Set(v.syncs ? [] : ['catalog']) }
}

/**
 * The top `limit` by count, and everything past it folded into one "Other"
 * bar. A long tail gets a single bar, never more colours or more bars than
 * anyone can read.
 */
export function topWithOther(counts: Map<string, number>, limit: number): Datum[] {
  const ranked = [...counts.entries()].map(([name, count]) => ({ name: String(name), count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  if (ranked.length <= limit + 1) return ranked
  const rest = ranked.slice(limit).reduce((total, row) => total + row.count, 0)
  return [...ranked.slice(0, limit), { name: 'Other', count: rest }]
}
