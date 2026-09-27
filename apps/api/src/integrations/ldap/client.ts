import { Client } from 'ldapts'
import { config } from '../../lib/config.ts'

/**
 * Runs `fn` against a connected client and always unbinds, including when the
 * caller re-binds as somebody else partway through. Every LDAP call goes
 * through here so no code path can leak a connection.
 */
export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ url: config.LDAP_URL })
  try {
    return await fn(client)
  } finally {
    await client.unbind().catch(() => {})
  }
}

/** Binds as the service account. The starting point for any search. */
export async function bindAsService(client: Client): Promise<void> {
  await client.bind(config.LDAP_BIND_DN, config.LDAP_BIND_PASSWORD)
}

/** RFC 4515 §3 — keeps user input out of the filter grammar. */
export function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'))
}

/** LDAP attributes arrive as a value or an array of values. */
export function first(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
}
