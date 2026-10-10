import { InsufficientAccessError, InvalidCredentialsError, NoSuchObjectError } from 'ldapts'
import { config } from '../../lib/config.ts'
import { ApiError } from '../../lib/errors.ts'
import { bindAsService, first, userFilter, withClient } from './client.ts'
import { readBindFailure } from './ad-errors.ts'
import { identifyServer } from './identify.ts'

export { dnOf, groupFilter, groupsOf, isApproverGroup } from './groups.ts'
export { profileOf, type Profile } from './profile.ts'

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
    // The service bind is our configuration, not the user's credentials.
    // Letting it fall through as "wrong password" hides a broken deployment
    // behind a message that blames the person signing in.
    try {
      await bindAsService(client)
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        throw new ApiError(
          503,
          'ldap_service_bind_failed',
          'The portal could not authenticate to the directory. Check LDAP_BIND_DN and LDAP_BIND_PASSWORD.',
        )
      }
      throw err
    }

    // A base DN the server does not serve, or one the service account may not
    // read, is a deployment problem. Reporting it as a bad password would send
    // people to reset a password that was never wrong.
    let searchEntries
    try {
      ;({ searchEntries } = await client.search(config.LDAP_BASE_DN, {
        scope: 'sub',
        filter: userFilter(uid),
          attributes: [
          config.LDAP_USER_ATTRIBUTE,
          'sAMAccountName',
          'displayName',
          'cn',
          'mail',
          'userPrincipalName',
        ],
      }))
    } catch (err) {
      if (err instanceof NoSuchObjectError) {
        throw new ApiError(
          503,
          'ldap_base_dn_not_found',
          `The directory has no entry at ${config.LDAP_BASE_DN}. Check LDAP_BASE_DN.`,
        )
      }
      if (err instanceof InsufficientAccessError) {
        throw new ApiError(
          503,
          'ldap_search_denied',
          'The service account is not allowed to search the directory. Check its permissions.',
        )
      }
      throw err
    }

    if (searchEntries.length === 0) {
      // Not "wrong password" — the directory has no such account under this
      // base DN and filter. Worth saying out loud: it is usually config.
      console.warn(
        `ldap: no account matched ${userFilter(uid)} under ${config.LDAP_BASE_DN}`,
      )
      return null
    }
    if (searchEntries.length > 1) {
      console.warn(`ldap: ${searchEntries.length} accounts matched ${userFilter(uid)}`)
      return null
    }

    const entry = searchEntries[0]!

    try {
      await client.unbind()
      await client.bind(entry.dn, password)
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        // Active Directory hides the real reason in a sub-code. An expired or
        // locked account is worth saying out loud; a wrong password is not.
        const failure = readBindFailure(err)
        if (failure?.code) throw new ApiError(401, failure.code, failure.message)
        return null
      }
      throw err
    }

    return {
      uid: first(entry[config.LDAP_USER_ATTRIBUTE]) || first(entry.sAMAccountName) || uid,
      dn: entry.dn,
      // displayName is the one AD actually shows; cn is the fallback elsewhere.
      name: first(entry.displayName) || first(entry.cn) || uid,
      mail: first(entry.mail) || first(entry.userPrincipalName),
    }
  })
}

