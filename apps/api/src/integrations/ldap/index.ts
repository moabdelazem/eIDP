import { InvalidCredentialsError } from 'ldapts'
import { config } from '../../lib/config.ts'
import { bindAsService, escapeFilter, first, withClient } from './client.ts'

/** A person as the directory knows them. */
export type DirectoryUser = {
  uid: string
  dn: string
  name: string
  mail: string
}

/**
 * Verifies a username and password against the directory.
 *
 * Service-binds, finds the account by uid, then re-binds as that account's own
 * DN — the uid is never assumed to map to a DN pattern, so this keeps working
 * when accounts live under different branches.
 *
 * Returns null for every "not you" outcome; throws only when the directory
 * itself is unreachable or misbehaving.
 */
export async function authenticate(uid: string, password: string): Promise<DirectoryUser | null> {
  // An empty password makes an *unauthenticated* bind, which succeeds against
  // any DN. Reject before we ever reach the server.
  if (!uid || !password) return null

  return withClient(async (client) => {
    try {
      await bindAsService(client)
      const { searchEntries } = await client.search(config.LDAP_BASE_DN, {
        scope: 'sub',
        filter: `(&(objectClass=inetOrgPerson)(uid=${escapeFilter(uid)}))`,
        attributes: ['uid', 'cn', 'mail'],
      })

      // More than one match means the uid is not the unique handle we assume
      // it is; refusing beats guessing which account was meant.
      if (searchEntries.length !== 1) return null
      const entry = searchEntries[0]!

      await client.unbind()
      await client.bind(entry.dn, password)

      return {
        uid: first(entry.uid),
        dn: entry.dn,
        name: first(entry.cn),
        mail: first(entry.mail),
      }
    } catch (err) {
      if (err instanceof InvalidCredentialsError) return null
      throw err
    }
  })
}
