/**
 * Where the settings came from this boot — `.env` alone, or Vault over it —
 * written once by whichever loader ran, and read by `/health` and by the
 * config error message. Names and a reason only, never a value.
 */
export type SecretsState =
  | { source: 'env' }
  | { source: 'vault'; paths: string[]; loaded: string[]; ignored: string[] }
  /** Vault was configured and could not be read: `.env` stood in. */
  | { source: 'env-fallback'; paths: string[]; error: string }

let state: SecretsState = { source: 'env' }

export function secretsState(): SecretsState {
  return state
}

export function setSecretsState(next: SecretsState): void {
  state = next
}
