/**
 * Reports which stage of an LDAP login fails, because the API deliberately
 * tells a caller nothing beyond "those credentials did not work".
 *
 *   pnpm --filter @eidp/api ldap:doctor <username> [password]
 *
 * Prints no attribute values beyond the ones that identify an account.
 */
import { Client, InsufficientAccessError, InvalidCredentialsError, NoSuchObjectError } from 'ldapts'
import { config } from '../../lib/config.ts'
import { escapeFilter, userFilter } from './client.ts'
import { identifyServer, suggestedSettings, type ServerIdentity } from './identify.ts'

const [username, password] = process.argv.slice(2)
if (!username) {
  console.error('usage: ldap:doctor <username> [password]')
  process.exit(2)
}

const ok = (message: string) => console.log(`  \x1b[32mok\x1b[0m    ${message}`)
const bad = (message: string) => console.log(`  \x1b[31mfail\x1b[0m  ${message}`)
const hint = (message: string) => console.log(`        \x1b[33m${message}\x1b[0m`)

console.log('\nconfiguration')
console.log(`  LDAP_URL               ${config.LDAP_URL}`)
console.log(`  LDAP_BASE_DN           ${config.LDAP_BASE_DN}`)
console.log(`  LDAP_BIND_DN           ${config.LDAP_BIND_DN}`)
console.log(`  LDAP_BIND_PASSWORD     ${config.LDAP_BIND_PASSWORD ? '(set)' : '(empty)'}`)
console.log(`  LDAP_USER_OBJECT_CLASS ${config.LDAP_USER_OBJECT_CLASS}`)
console.log(`  LDAP_USER_ATTRIBUTE    ${config.LDAP_USER_ATTRIBUTE}`)
console.log(`  LDAP_USER_FILTER       ${config.LDAP_USER_FILTER ?? '(unset — built from the two above)'}`)

if (config.LDAP_URL.includes('localhost') || config.LDAP_URL.includes('127.0.0.1')) {
  hint('LDAP_URL points at this machine. If you meant your organization directory, it is not set.')
}

const client = new Client({ url: config.LDAP_URL, timeout: 10_000, connectTimeout: 10_000 })

let identity: ServerIdentity | null = null

console.log('\nstages')
try {
  // 0. what are we even talking to
  identity = await identifyServer(client)
  if (identity) {
    ok(`server is ${identity.vendor}`)
    if (identity.namingContexts.length > 0) {
      console.log(`        serves: ${identity.namingContexts.join(', ')}`)
      const known = identity.namingContexts.some(
        (context) => context.toLowerCase() === config.LDAP_BASE_DN.toLowerCase(),
      )
      if (!known) {
        hint(`LDAP_BASE_DN (${config.LDAP_BASE_DN}) is not one of those suffixes.`)
        hint(`Try LDAP_BASE_DN=${identity.defaultNamingContext ?? identity.namingContexts[0]}`)
      }
    }
    if (identity.isActiveDirectory && !config.LDAP_USER_FILTER) {
      const suggestion = suggestedSettings(identity)
      hint('This is Active Directory, but the filter is the OpenLDAP one. Use:')
      hint(`  LDAP_USER_FILTER=${suggestion.filter}`)
    }
  } else {
    console.log('  ----  the server would not describe itself anonymously')
  }

  // 1. reachable
  try {
    await client.bind(config.LDAP_BIND_DN, config.LDAP_BIND_PASSWORD)
    ok('connected and bound as the service account')
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      bad('connected, but the service account was rejected')
      hint('LDAP_BIND_DN or LDAP_BIND_PASSWORD is wrong. This alone makes every login fail.')
    } else {
      bad(`could not reach or bind: ${(err as Error).message}`)
      hint('Check LDAP_URL, the port, and whether this host can route to the directory.')
    }
    process.exit(1)
  }

  // 2. the configured filter finds exactly one account
  const filter = userFilter(username)
  let searchEntries
  try {
    ;({ searchEntries } = await client.search(config.LDAP_BASE_DN, {
      scope: 'sub',
      filter,
      attributes: ['dn'],
    }))
  } catch (err) {
    const message = (err as Error).message
    if (err instanceof NoSuchObjectError) {
      bad(`the server has no entry at ${config.LDAP_BASE_DN}`)
      hint('LDAP_BASE_DN is wrong. Use one of the suffixes listed above.')
    } else if (err instanceof InsufficientAccessError) {
      bad('the service account is not allowed to search there')
      hint('It can bind but not read. Ask for read access to the user subtree.')
    } else {
      bad(`the search failed: ${message}`)
    }
    process.exit(1)
  }

  if (searchEntries.length === 1) {
    ok(`found exactly one account: ${searchEntries[0]!.dn}`)
  } else {
    bad(`${searchEntries.length} accounts matched ${filter}`)
    if (searchEntries.length === 0) await suggestSchema()
    else hint('The username is not unique under this base DN. Narrow LDAP_BASE_DN.')
    if (searchEntries.length === 0) process.exit(1)
  }

  // 3. the user's own password
  if (!password) {
    console.log('\n  (no password given, so the final bind was not attempted)')
  } else {
    const entry = searchEntries[0]!
    await client.unbind()
    try {
      await client.bind(entry.dn, password)
      ok('the account accepted that password — login should work')
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        bad('the account rejected that password')
        hint('This is the one case where a 401 really does mean wrong credentials.')
      } else throw err
    }
  }

  // 4. groups — whether this person can approve requests
  const { groupFilter, groupsOf, isApproverGroup } = await import('./groups.ts')
  const lookup = await groupFilter()
  const groups = await groupsOf(searchEntries[0]!.dn)
  console.log(`\n  groups (${lookup.source})`)
  if (groups.length === 0) {
    bad('no groups found for this account')
    hint(`Filter used: ${lookup.filter}`)
    hint('Active Directory needs objectClass=group; OpenLDAP needs groupOfNames.')
    hint('If the groups live outside LDAP_BASE_DN, they are not searched at all.')
  } else {
    ok(`${groups.length} group${groups.length === 1 ? '' : 's'}: ${groups.slice(0, 12).join(', ')}${groups.length > 12 ? ', …' : ''}`)
    if (groups.some(isApproverGroup)) {
      ok(`in ${config.APPROVER_GROUP} — can approve and reject requests`)
    } else {
      console.log(`  ----  not in ${config.APPROVER_GROUP}, so cannot approve requests`)
      const close = groups.filter((g) => g.toLowerCase().includes(config.APPROVER_GROUP.toLowerCase()))
      if (close.length > 0) hint(`Did you mean APPROVER_GROUP=${close[0]}?`)
    }
  }
} finally {
  await client.unbind().catch(() => {})
  console.log()
}

/**
 * When nothing matched, look the account up without assuming a schema and
 * report what it actually is — that names the settings to use.
 */
async function suggestSchema(): Promise<void> {
  const candidates = ['uid', 'sAMAccountName', 'userPrincipalName', 'cn', 'mail']
  const wide = `(|${candidates.map((a) => `(${a}=${escapeFilter(username)})`).join('')})`

  const { searchEntries } = await client.search(config.LDAP_BASE_DN, {
    scope: 'sub',
    filter: wide,
    attributes: ['objectClass', ...candidates],
  })

  if (searchEntries.length === 0) {
    hint(`Nothing under ${config.LDAP_BASE_DN} matches "${username}" on any of ${candidates.join(', ')}.`)
    hint('Either the base DN is wrong, or the service account cannot see user objects.')
    return
  }

  console.log('\n  the directory does hold this account:')
  for (const entry of searchEntries.slice(0, 3)) {
    console.log(`    dn           ${entry.dn}`)
    const classes = [entry.objectClass].flat().filter(Boolean)
    console.log(`    objectClass  ${classes.join(', ')}`)
    for (const attribute of candidates) {
      const values = [entry[attribute]].flat().filter((v) => v !== undefined && v !== '')
      if (values.length > 0) console.log(`    ${attribute.padEnd(18)} ${values.join(', ')}`)
    }
    const matched = candidates.find(
      (a) =>
        entry[a] &&
        [entry[a]].flat().some((v) => String(v).toLowerCase() === username.toLowerCase()),
    )
    if (identity?.isActiveDirectory) {
      const suggestion = suggestedSettings(identity)
      hint(`Set LDAP_USER_FILTER=${suggestion.filter!.replace('sAMAccountName', matched ?? 'sAMAccountName')}`)
    } else {
      const objectClass = classes.includes('user') ? 'user' : classes.at(-1)
      hint(`Set LDAP_USER_OBJECT_CLASS=${objectClass} and LDAP_USER_ATTRIBUTE=${matched ?? 'uid'}`)
    }
  }
}
