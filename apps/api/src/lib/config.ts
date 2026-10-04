import { z } from 'zod'
import { schema } from './config-schema.ts'
import { secretsState } from './secrets-state.ts'

/**
 * The API's settings, parsed once at boot from the environment — which `.env`
 * fills, and Vault before it when configured (`integrations/vault`, loaded by
 * the entry points before anything imports this). The schema is in
 * `config-schema.ts`.
 */
export type Config = z.infer<typeof schema>

export const config: Config = load()

function load(): Config {
  // `KEY=` in .env means "not set yet", and .env.example ships several that
  // way. Read as an empty string it fails validation and stops the boot, so
  // blanks are dropped and defaults and optionals apply as if it were absent.
  const present = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  )
  const parsed = schema.safeParse(present)
  if (parsed.success) return parsed.data

  const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
  // A setting kept only in Vault is missing from .env by design; say so, or
  // the message sends people to fix the wrong file.
  const secrets = secretsState()
  const why = secrets.source === 'env-fallback' ? `\nVault could not be read (${secrets.error}), so only .env was used.` : ''
  throw new Error(`Environment is not usable:\n${problems.join('\n')}${why}`)
}
