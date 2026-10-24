import type { RequestRecord } from '@eidp/contracts/requests'
import { addToProjectGroup, CONTRIBUTOR, findIdentity, grantRepository, READER, removeFromProjectGroup, webUrlFor, type Principal } from '../../integrations/ado/index.ts'
import { existingRepository, recordCompleted } from './steps.ts'

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
  await recordCompleted(request.id, resultUrl)
}

/**
 * Takes access away: everyone named out of the project's Contributors and
 * Readers. As with granting, every name is resolved before anything is
 * removed, so one unknown name removes nobody; removing someone already out
 * is not an error, so a retry simply runs it again.
 */
export async function executeRevoke(request: RequestRecord): Promise<void> {
  const collection = request.collection!
  const principals: Principal[] = []
  for (const name of request.grantees ?? []) principals.push(await findIdentity(collection, name))
  for (const group of ['Contributors', 'Readers'] as const) await removeFromProjectGroup(collection, request.project, group, principals)
  await recordCompleted(request.id, webUrlFor(collection, request.project))
}
