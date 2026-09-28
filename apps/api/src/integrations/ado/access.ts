import { ApiError } from '../../lib/errors.ts'
import { adoGetList, adoPost, adoPut } from './client.ts'

/**
 * Granting access in Azure DevOps Server. Two steps, because ADO grants to
 * identities, not names: find the identity a name belongs to, then give it
 * permissions on a repository or a place in a project's group.
 */

type AdoIdentity = {
  id: string
  /** `<identityType>;<identifier>` — what an access control entry names. */
  descriptor: string
  providerDisplayName: string
  isContainer?: boolean
  properties?: { Account?: { $value?: string } }
}

export type Principal = { name: string; id: string; descriptor: string }

/** The Git Repositories security namespace — the same id on every server. */
const GIT_NAMESPACE = '2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87'

/**
 * What a project's Contributors group has on a repository by default: read,
 * contribute, create branch, create tag, manage notes, contribute to pull
 * requests. Not force-push, policy exemption, or managing permissions — those
 * stay with DevOps.
 */
export const CONTRIBUTOR = 2 | 4 | 16 | 32 | 64 | 16384

/**
 * The ADO identity for a directory account or group, by its account name
 * (sAMAccountName for a person, the group's name for a group).
 *
 * ADO searches the directory it is joined to, so an AD group nobody has used
 * in ADO before is still found. A name matching nothing, or matching accounts
 * in two domains, is an error rather than a guess — granting to the wrong
 * identity is worse than not granting.
 */
export async function findIdentity(collection: string, name: string): Promise<Principal> {
  const found = await adoGetList<AdoIdentity>('identities', {
    collection,
    query: { searchFilter: 'General', filterValue: name, queryMembership: 'None' },
  })
  const exact = found.filter(
    (identity) =>
      identity.properties?.Account?.$value?.toLowerCase() === name.toLowerCase() ||
      identity.providerDisplayName.toLowerCase() === name.toLowerCase(),
  )
  if (exact.length === 0) {
    throw new ApiError(502, 'ado_identity_missing', `Azure DevOps does not know an account or group called ${name}.`)
  }
  if (exact.length > 1) {
    throw new ApiError(
      502,
      'ado_identity_ambiguous',
      `More than one account or group in Azure DevOps is called ${name}: ${exact.map((i) => i.providerDisplayName).join(', ')}.`,
    )
  }
  const { id, descriptor } = exact[0]!
  return { name, id, descriptor }
}

/** Contributor on one repository, for each principal. Merged, so nothing else on the repo changes. */
export async function grantRepository(
  collection: string,
  projectId: string,
  repositoryId: string,
  principals: Principal[],
): Promise<void> {
  await adoPost(
    `accesscontrolentries/${GIT_NAMESPACE}`,
    {
      token: `repoV2/${projectId}/${repositoryId}`,
      merge: true,
      accessControlEntries: principals.map((p) => ({ descriptor: p.descriptor, allow: CONTRIBUTOR, deny: 0 })),
    },
    { collection },
  )
}

/**
 * Adds each principal to the project's own Contributors group, which is how
 * ADO means "works on this project": boards, repos and pipelines together.
 */
export async function addToContributors(collection: string, project: string, principals: Principal[]): Promise<void> {
  const group = await findIdentity(collection, `[${project}]\\Contributors`)
  for (const principal of principals) {
    await adoPut(`identities/${group.id}/members/${principal.id}`, { collection })
  }
}
