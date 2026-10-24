import { ApiError } from '../../lib/errors.ts'
import { adoDelete, adoGetList, adoPost, adoPut } from './client.ts'

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
  /** With `queryMembership=Direct`: the descriptors of a group's own members. */
  members?: string[]
}

/** Someone, or a group, in one of a project's groups. */
export type GroupMember = {
  /** The account name — what an access request names. */
  account: string
  displayName: string
  group: boolean
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

/** Read and clone, nothing more. */
export const READER = 2

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

/** `allow` on one repository, for each principal. Merged, so nothing else on the repo changes. */
export async function grantRepository(
  collection: string,
  projectId: string,
  repositoryId: string,
  principals: Principal[],
  allow: number = CONTRIBUTOR,
): Promise<void> {
  await adoPost(
    `accesscontrolentries/${GIT_NAMESPACE}`,
    {
      token: `repoV2/${projectId}/${repositoryId}`,
      merge: true,
      accessControlEntries: principals.map((p) => ({ descriptor: p.descriptor, allow, deny: 0 })),
    },
    { collection },
  )
}

/**
 * Adds each principal to one of the project's own groups — Contributors is how
 * ADO means "works on this project" (boards, repos and pipelines together),
 * Readers is "can see it".
 */
export async function addToProjectGroup(
  collection: string,
  project: string,
  group: ProjectGroup,
  principals: Principal[],
): Promise<void> {
  const container = await findIdentity(collection, `[${project}]\\${group}`)
  for (const principal of principals) {
    await adoPut(`identities/${container.id}/members/${principal.id}`, { collection })
  }
}

/** A project's own group, Contributors or Readers. */
export type ProjectGroup = 'Contributors' | 'Readers'

/**
 * Who is directly in one of a project's groups — people and the groups added
 * whole. Members of a member group are not listed: removing access is done
 * where it was given, and a team's group is removed as one.
 */
export async function projectGroupMembers(collection: string, project: string, group: ProjectGroup): Promise<GroupMember[]> {
  const container = await findIdentity(collection, `[${project}]\\${group}`)
  const [withMembers] = await adoGetList<AdoIdentity>('identities', { collection, query: { identityIds: container.id, queryMembership: 'Direct' } })
  const descriptors = withMembers?.members ?? []
  const found: AdoIdentity[] = []
  // A long descriptor list makes a long URL; ask in batches.
  for (let i = 0; i < descriptors.length; i += 50) {
    found.push(...(await adoGetList<AdoIdentity>('identities', { collection, query: { descriptors: descriptors.slice(i, i + 50).join(','), queryMembership: 'None' } })))
  }
  return found
    .map((identity) => ({
      account: identity.properties?.Account?.$value || identity.providerDisplayName,
      displayName: identity.providerDisplayName,
      group: identity.isContainer === true,
    }))
    .sort((a, b) => Number(a.group) - Number(b.group) || a.displayName.localeCompare(b.displayName))
}

/**
 * Takes each principal out of one of the project's groups. Someone already
 * out of it is not an error: removing is idempotent, so a retry runs again.
 */
export async function removeFromProjectGroup(collection: string, project: string, group: ProjectGroup, principals: Principal[]): Promise<void> {
  const container = await findIdentity(collection, `[${project}]\\${group}`)
  for (const principal of principals) {
    try {
      await adoDelete(`identities/${container.id}/members/${principal.id}`, { collection })
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'ado_not_found')) throw err
    }
  }
}
