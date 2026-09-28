import { config } from '../../lib/config.ts'
import { bindAsService, escapeFilter, first, userFilter, withClient } from './client.ts'

/** Names (cn) of every group the account at `dn` belongs to. */
export async function groupsOf(dn: string): Promise<string[]> {
  return withClient(async (client) => {
    await bindAsService(client)
    const { searchEntries } = await client.search(config.LDAP_BASE_DN, {
      scope: 'sub',
      filter: config.LDAP_GROUP_FILTER.replaceAll('{dn}', escapeFilter(dn)),
      attributes: ['cn'],
      // A user in hundreds of AD groups is normal; a page cap is not an answer.
      paged: true,
    })
    return searchEntries.map((entry) => first(entry.cn)).filter(Boolean)
  })
}

/**
 * Whether `uid` is in the approver group *right now*.
 *
 * Asked live at the moment of approval rather than trusted from the session,
 * so someone removed from DEVOPS loses the power immediately, not when their
 * token expires eight hours later.
 */
export async function isApprover(uid: string): Promise<boolean> {
  const dn = await withClient(async (client) => {
    await bindAsService(client)
    const { searchEntries } = await client.search(config.LDAP_BASE_DN, {
      scope: 'sub',
      filter: userFilter(uid),
      attributes: ['dn'],
    })
    return searchEntries.length === 1 ? searchEntries[0]!.dn : null
  })
  if (!dn) return false

  const wanted = config.APPROVER_GROUP.toLowerCase()
  return (await groupsOf(dn)).some((group) => group.toLowerCase() === wanted)
}
