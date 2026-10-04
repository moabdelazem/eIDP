/**
 * The API's entry point. Secrets come first: Vault, when configured, fills the
 * environment before anything reads `lib/config.ts` — which is why the rest is
 * a dynamic import. A static one would be evaluated before this file's
 * `await`, and config would parse `.env` alone.
 */
import { loadSecrets } from './integrations/vault/index.ts'

const secrets = await loadSecrets()
if (secrets.source === 'vault') {
  console.log(`secrets: ${secrets.loaded.length} setting(s) from Vault (${secrets.paths.join(', ')}): ${secrets.loaded.join(', ') || 'none'}`)
  if (secrets.ignored.length) console.warn(`secrets: ignored names the API does not read: ${secrets.ignored.join(', ')}`)
} else if (secrets.source === 'env-fallback') {
  console.warn(`secrets: ${secrets.error} Using .env.`)
}

await import('./server.ts')
