import type { RequestRecord } from '@eidp/contracts/requests'
import { log } from '../../../lib/log.ts'
import { syncCatalog } from '../../catalog/index.ts'
import { recordCompleted } from '../steps.ts'
import { commitUrl, writePipeline } from './write.ts'

/**
 * An approved pipeline request: its files pushed to inventories (`write.ts`),
 * the request completed with the commit as its result, and the catalog synced
 * so the map shows the application at once rather than at the next sync.
 */
export async function executePipeline(request: RequestRecord): Promise<void> {
  const { commit, files } = await writePipeline(request)
  log.info('pipeline written to inventories', { request: request.id, commit, files: files.map((f) => f.path) })
  await recordCompleted(request.id, commitUrl(commit))
  void syncCatalog().catch(() => {})
}
