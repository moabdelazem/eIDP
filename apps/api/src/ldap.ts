import { Client, InvalidCredentialsError } from 'ldapts'

const url = process.env.LDAP_URL ?? 'ldap://localhost:389'
const baseDN = process.env.LDAP_BASE_DN ?? 'dc=eidp,dc=local'
const bindDN = process.env.LDAP_BIND_DN ?? 'cn=admin,dc=eidp,dc=local'
const bindPassword = process.env.LDAP_BIND_PASSWORD ?? 'admin'

export type LdapUser = { uid: string; dn: string; name: string; mail: string }

/** Service-bind, find the user by uid, then re-bind as them to check the password. */
export async function authenticate(uid: string, password: string): Promise<LdapUser | null> {
  // An empty password is an unauthenticated bind in LDAP: it succeeds against
  // any DN. Reject before we ever reach the server.
  if (!uid || !password) return null

  const client = new Client({ url })
  try {
    await client.bind(bindDN, bindPassword)
    const { searchEntries } = await client.search(baseDN, {
      scope: 'sub',
      filter: `(&(objectClass=inetOrgPerson)(uid=${escapeFilter(uid)}))`,
      attributes: ['uid', 'cn', 'mail'],
    })
    const entry = searchEntries[0]
    if (!entry || searchEntries.length > 1) return null

    await client.unbind()
    await client.bind(entry.dn, password)
    return {
      uid: str(entry.uid),
      dn: entry.dn,
      name: str(entry.cn),
      mail: str(entry.mail),
    }
  } catch (err) {
    if (err instanceof InvalidCredentialsError) return null
    throw err
  } finally {
    await client.unbind().catch(() => {})
  }
}

/** RFC 4515 §3 — keep user input out of the filter grammar. */
function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'))
}

function str(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
}
