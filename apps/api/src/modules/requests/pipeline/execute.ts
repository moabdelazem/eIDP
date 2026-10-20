import type { RequestRecord } from '@eidp/contracts/requests'
import { errorFields, log } from '../../../lib/log.ts'
import { syncCatalog } from '../../catalog/index.ts'
import { recordCompleted } from '../steps.ts'
import { startSteps } from './follow-up.ts'
import { commitUrl, writePipeline } from './write.ts'

/**
 * An approved pipeline request: its files pushed to inventories (`write.ts`),
 * the request completed with the commit as its result, the catalog synced so
 * the map shows the application at once rather than at the next sync, and
 * its Jenkins steps started — provisioning, then a first test build
 * (`follow-up.ts`). Those run on their own: the request is complete with the
 * push, and a step failing later never makes it failed.
 */
export async function executePipeline(request: RequestRecord): Promise<void> {
  const { commit, manifestsCommit, files, system } = await writePipeline(request)
  log.info('pipeline written', { request: request.id, commit, manifestsCommit, files: files.map((f) => f.path) })
  await recordCompleted(request.id, commitUrl(commit))
  await startSteps(request, system).catch((err) => log.error('pipeline steps not started', { request: request.id, ...errorFields(err) }))
  void syncCatalog().catch(() => {})
}
