import { api } from '@/lib/api-client.ts'

// The JSON's shapes are the API's, from @eidp/contracts.
import type { OverviewLayout, OverviewPreference } from '@eidp/contracts/preferences'
export type { OverviewLayout, OverviewPreference } from '@eidp/contracts/preferences'

/** Your own Overview arrangement, kept with your account (apps/api modules/preferences). */
export const preferencesApi = {
  overview: () => api<OverviewPreference>('/preferences/overview'),
  saveOverview: (layout: OverviewLayout) => api<OverviewPreference>('/preferences/overview', { method: 'PUT', body: JSON.stringify(layout) }),
  resetOverview: () => api<void>('/preferences/overview', { method: 'DELETE' }),
}
