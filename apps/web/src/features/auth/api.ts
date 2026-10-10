import { api, ApiError } from '@/lib/api-client.ts'
import { tokenStore } from '@/lib/token-store.ts'
import { decode, type Session } from './session.ts'

import type { LoginResponse } from '@eidp/contracts/auth'

/** Exchanges directory credentials for a session. Throws ApiError on failure. */
export async function login(username: string, password: string): Promise<Session> {
  const { token } = await api<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })

  const session = decode(token)
  if (!session) {
    throw new ApiError(500, 'bad_token', 'The portal returned a session we could not read.')
  }

  tokenStore.set(token)
  return session
}

export function logout(): void {
  tokenStore.clearAll()
}
