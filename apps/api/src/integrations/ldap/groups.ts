import { config } from '../../lib/config.ts'
import { bindAsService, escapeFilter, first, userFilter, withClient } from './client.ts'
import { identifyServer } from './identify.ts'

/** Direct membership. What OpenLDAP and 389-ds understand. */
const GROUP_OF_NAMES = '(&(objectClass=groupOfNames)(member={dn}))'

/**
 * Active Directory's in-chain rule (LDAP_MATCHING_RULE_IN_CHAIN) follows nested
 * groups: someone in a team that is itself inside DEVOPS still counts.
 */
const AD_IN_CHAIN = '(&(objectClass=group)(member:1.2.840.113556.1.4.1941:={dn}))'

let resolved: Promise<{ filter: string; source: string }> | null = null

/**
 * The filter that finds an account's groups, and why it was chosen.
 *
 * An explicit LDAP_GROUP_FILTER wins. Otherwise the server is asked what it
 * is, because a hardcoded default is wrong for one of AD and OpenLDAP — and
 * wrong here is silent: no groups are found, so nobody is ever an approver.
 *
 * Asked once per process; the directory product does not change underneath us.
 */
export function groupFilter(): Promise<{ filter: string; source: string }> {
  if (config.LDAP_GROUP_FILTER) {
    return Promise.resolve({ filter: config.LDAP_GROUP_FILTER, source: 'LDAP_GROUP_FILTER' })
  }
  resolved ??= withClient(async (client) => {
    await bindAsService(client)
    return chooseGroupFilter(await identifyServer(client), config.LDAP_USER_FILTER)
  }).catch((err) => {
    resolved = null // let a later call try again rather than caching a failure
    throw err
  })
  return resolved
}

/** The decision behind `groupFilter`, pure so every branch can be tested. */
export function chooseGroupFilter(
  identity: { vendor: string; isActiveDirectory: boolean } | null,
  userFilter: string | undefined,
): { filter: string; source: string } {
  if (identity?.isActiveDirectory) {
    return { filter: AD_IN_CHAIN, source: `detected ${identity.vendor}` }
  }
  // Some directories refuse the rootDSE. An AD-style user filter is a reliable
  // second signal: it is only ever written for Active Directory.
  if (!identity && /sAMAccountName|objectCategory/i.test(userFilter ?? '')) {
    return { filter: AD_IN_CHAIN, source: 'inferred Active Directory from LDAP_USER_FILTER' }
  }
  return { filter: GROUP_OF_NAMES, source: identity ? `detected ${identity.vendor}` : 'default' }
}

/** Names (cn) of every group the account at `dn` belongs to. */
export async function groupsOf(dn: string): Promise<string[]> {
  const { filter } = await groupFilter()
  return withClient(async (client) => {
    await bindAsService(client)
    const { searchEntries } = await client.search(config.LDAP_BASE_DN, {
      scope: 'sub',
      filter: filter.replaceAll('{dn}', escapeFilter(dn)),
      attributes: ['cn'],
      // A user in hundreds of AD groups is normal; a page cap is not an answer.
      paged: true,
    })
    return searchEntries
      .map((entry) => first(entry.cn))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
  })
}

export function isApproverGroup(group: string): boolean {
  return group.toLowerCase() === config.APPROVER_GROUP.toLowerCase()
}

/** The DN for a login name, or null when there is not exactly one. */
export async function dnOf(uid: string): Promise<string | null> {
  return withClient(async (client) => {
    await bindAsService(client)
    const { searchEntries } = await client.search(config.LDAP_BASE_DN, {
      scope: 'sub',
      filter: userFilter(uid),
      attributes: ['dn'],
    })
    return searchEntries.length === 1 ? searchEntries[0]!.dn : null
  })
}

