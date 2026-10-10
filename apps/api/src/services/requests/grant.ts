import type { RequestRecord } from '@eidp/contracts/requests'
import { addToProjectGroup, CONTRIBUTOR, findIdentity, grantRepository, READER, webUrlFor, type Principal } from '../../integrations/ado/index.ts'
import { query } from '../../lib/db.ts'
import { existingRepository } from './steps.ts'

/**
 * Grants access to something that exists. Every grantee is resolved first, so
 * one unknown name grants nobody rather than half the list. Granting is
 * idempotent in ADO — a merged ACE, a group someone may already be in — so a
 * retry simply runs it again.
 */
export async function executeGrant(request: RequestRecord): Promise<void> {
  const collection = request.collection!
  const principals: Principal[] = []
  for (const name of request.grantees ?? []) principals.push(await findIdentity(collection, name))
  const read = request.accessLevel === 'read'

  let resultUrl: string
  if (request.repository) {
    const repo = await existingRepository(request)
    await grantRepository(collection, repo.project.id, repo.id, principals, read ? READER : CONTRIBUTOR)
    resultUrl = repo.webUrl ?? webUrlFor(collection, request.project, repo.name)
  } else {
    await addToProjectGroup(collection, request.project, read ? 'Readers' : 'Contributors', principals)
    resultUrl = webUrlFor(collection, request.project)
  }
  await query(
    `update requests set status = 'completed', completed_at = now(), result_url = $2, error = null
      where id = $1`,
    [request.id, resultUrl],
  )
}
