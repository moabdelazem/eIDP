export type Session = { token: string; sub: string; name: string; mail: string }

const KEY = 'eidp.token'

export function storedSession(): Session | null {
  const token = localStorage.getItem(KEY)
  return token ? decode(token) : null
}

export async function login(username: string, password: string): Promise<Session> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (res.status === 401) throw new Error("That username and password don't match.")
  if (!res.ok) throw new Error('The directory is not responding. Try again in a moment.')

  const { token } = (await res.json()) as { token: string }
  const session = decode(token)
  if (!session) throw new Error('The directory returned a token we could not read.')
  localStorage.setItem(KEY, token)
  return session
}

export function logout() {
  localStorage.removeItem(KEY)
}

function decode(token: string): Session | null {
  try {
    const p = JSON.parse(atob(token.split('.')[1])) as Record<string, unknown>
    if (typeof p.exp === 'number' && p.exp * 1000 < Date.now()) return null
    return { token, sub: String(p.sub), name: String(p.name), mail: String(p.mail) }
  } catch {
    return null
  }
}
