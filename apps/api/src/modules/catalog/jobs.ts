import { config } from '../../lib/config.ts'
import type { Job } from '../../lib/jobs.ts'
import { errorFields, log } from '../../lib/log.ts'
import { syncCatalog } from './service.ts'

/** The catalog. A stale or empty map is reported through /catalog, not by refusing to start. */
export const jobs: Job[] = [
  {
    name: 'catalog-sync',
    everyMs: config.SYNC_INTERVAL_MINUTES * 60_000,
    enabled: Boolean(config.INVENTORIES_PROJECT),
    run: async () => `ok at ${(await syncCatalog()).commit?.slice(0, 8)}`,
  },
]

/**
 * With the timer off (0) the map is still built once at boot, as it always was —
 * once however many replicas boot together: the others join that sync.
 */
export function atBoot(): void {
  if (config.INVENTORIES_PROJECT && config.SYNC_INTERVAL_MINUTES <= 0) {
    syncCatalog().catch((err) => log.error('catalog sync at boot failed', errorFields(err)))
  }
}
