/**
 * Runs a script the way the API boots: secrets from Vault first, when
 * configured, then the script — so `ldap:doctor` tests the bind password the
 * API would actually use.
 *
 *   node src/with-secrets.ts src/integrations/ldap/doctor.ts [args…]
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSecrets } from './integrations/vault/index.ts'

const [script, ...rest] = process.argv.slice(2)
if (!script) {
  console.error('usage: node src/with-secrets.ts <script.ts> [args…]')
  process.exit(2)
}
const secrets = await loadSecrets()
if (secrets.source === 'env-fallback') console.warn(`secrets: ${secrets.error} Using .env.`)
// The script reads its own arguments from argv[2] on, as if run directly.
process.argv = [process.argv[0]!, resolve(script), ...rest]
await import(pathToFileURL(resolve(script)).href)
