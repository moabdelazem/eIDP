import { config } from '../../lib/config.ts'
import { bindAsService, first, userFilter, withClient } from './client.ts'
import { groupFilter, groupsOf, isApproverGroup } from './groups.ts'

/** A person as the directory describes them, read fresh. */
export type Profile = {
  uid: string
  name: string
  mail: string
  title: string | null
  department: string | null
  /** AD has no single "team" field; division is the usual home for it. */
  division: string | null
  company: string | null
  office: string | null
  manager: string | null
  groups: string[]
  approverGroup: string
  isApprover: boolean
  /** How groups were looked up — shown when someone expected to approve and can't. */
  groupLookup: string
}

const ATTRIBUTES = [
  'displayName',
  'cn',
  'mail',
  'userPrincipalName',
  'title',
  'department',
  // inetOrgPerson's name for the same thing, so OpenLDAP shows it too.
  'departmentNumber',
  'division',
  'company',
  'physicalDeliveryOfficeName',
  'manager',
]

export async function profileOf(uid: string): Promise<Profile | null> {
  const entry = await withClient(async (client) => {
    await bindAsService(client)
    const { searchEntries } = await client.search(config.LDAP_BASE_DN, {
      scope: 'sub',
      filter: userFilter(uid),
      attributes: ATTRIBUTES,
    })
    if (searchEntries.length !== 1) return null
    const found = searchEntries[0]!

    // manager is a DN; people want the name.
    let manager: string | null = null
    const managerDn = first(found.manager)
    if (managerDn) {
      const { searchEntries: managers } = await client
        .search(managerDn, { scope: 'base', attributes: ['displayName', 'cn'] })
        .catch(() => ({ searchEntries: [] }))
      manager = first(managers[0]?.displayName) || first(managers[0]?.cn) || null
    }
    return { found, manager }
  })
  if (!entry) return null

  const { found, manager } = entry
  const [groups, lookup] = await Promise.all([groupsOf(found.dn), groupFilter()])
  const text = (value: unknown) => first(value) || null

  return {
    uid,
    name: first(found.displayName) || first(found.cn) || uid,
    mail: first(found.mail) || first(found.userPrincipalName),
    title: text(found.title),
    department: text(found.department) ?? text(found.departmentNumber),
    division: text(found.division),
    company: text(found.company),
    office: text(found.physicalDeliveryOfficeName),
    manager,
    groups,
    approverGroup: config.APPROVER_GROUP,
    isApprover: groups.some(isApproverGroup),
    groupLookup: lookup.source,
  }
}
