/**
 * The API's entry point. Secrets come first: Vault, when configured, fills the
 * environment before anything reads `lib/config.ts` — which is why the rest is
 * a dynamic import. A static one would be evaluated before this file's
 * `await`, and config would parse `.env` alone.
 */
import { loadSecrets } from './integrations/vault/index.ts'
import { log } from './lib/log.ts'

const secrets = await loadSecrets()
if (secrets.source === 'vault') {
  log.info('secrets read from Vault', { paths: secrets.paths, names: secrets.loaded })
  if (secrets.ignored.length) log.warn('secrets: ignored names the API does not read', { names: secrets.ignored })
} else if (secrets.source === 'env-fallback') {
  log.warn('secrets: Vault could not be read; using .env', { error: secrets.error })
}

await import('./server.ts')
