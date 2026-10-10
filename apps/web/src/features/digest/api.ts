import { api } from '@/lib/api-client.ts'

// The JSON's shapes are the API's, from @eidp/contracts — one definition, so the two cannot drift.
import type { Digest as Stored, DigestIndex, DigestView } from '@eidp/contracts/digest'
export type { BuildFacts, DigestFacts, DigestIndex, FailingPipeline, RequestItem, Totals } from '@eidp/contracts/digest'

/** A digest as the page reads it: with the weeks on offer. */
export type Digest = DigestView

export const digestApi = {
  index: () => api<DigestIndex>('/digests'),
  digest: (team: string, week: string) => api<DigestView>(`/digests/${encodeURIComponent(team)}?week=${week}`),
  /** The week written again — without the weeks on offer, which have not changed. */
  regenerate: (team: string, week: string) =>
    api<Stored>(`/digests/${encodeURIComponent(team)}/regenerate`, { method: 'POST', body: JSON.stringify({ week }) }),
}
