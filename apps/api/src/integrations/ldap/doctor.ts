/**
 * Reports which stage of an LDAP login fails, because the API deliberately
 * tells a caller nothing beyond "those credentials did not work".
 *
 *   pnpm --filter @eidp/api ldap:doctor <username> [password]
 *
 * Prints no attribute values beyond the ones that identify an account.
 */
import { Client, InvalidCredentialsError } from 'ldapts'
import { config } from '../../lib/config.ts'
import { escapeFilter, userFilter } from './client.ts'

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

if (config.LDAP_URL.includes('localhost') || config.LDAP_URL.includes('127.0.0.1')) {
  hint('LDAP_URL points at this machine. If you meant your organization directory, it is not set.')
}

const client = new Client({ url: config.LDAP_URL, timeout: 10_000, connectTimeout: 10_000 })

console.log('\nstages')
try {
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
  const { searchEntries } = await client.search(config.LDAP_BASE_DN, {
    scope: 'sub',
    filter,
    attributes: ['dn'],
  })

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
      (a) => entry[a] && [entry[a]].flat().some((v) => String(v).toLowerCase() === username.toLowerCase()),
    )
    const objectClass = classes.includes('user') ? 'user' : classes.at(-1)
    hint(`Set LDAP_USER_OBJECT_CLASS=${objectClass} and LDAP_USER_ATTRIBUTE=${matched ?? 'uid'}`)
  }
}
