import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { jwt, sign, type JwtVariables } from 'hono/jwt'
import { authenticate } from './ldap.ts'

const secret = process.env.JWT_SECRET
if (!secret) throw new Error('JWT_SECRET is required')

const app = new Hono<{ Variables: JwtVariables }>()

app.get('/health', (c) => c.json({ ok: true }))

app.post('/auth/login', async (c) => {
  const { username, password } = await c.req.json<{ username?: string; password?: string }>()
  const user = await authenticate(username ?? '', password ?? '')
  if (!user) return c.json({ error: 'invalid credentials' }, 401)

  const token = await sign(
    { sub: user.uid, name: user.name, mail: user.mail, exp: Math.floor(Date.now() / 1000) + 8 * 3600 },
    secret,
  )
  return c.json({ token })
})

app.use('/auth/me', jwt({ secret, alg: 'HS256' }))
app.get('/auth/me', (c) => c.json(c.get('jwtPayload')))

const port = Number(process.env.PORT ?? 3000)
serve({ fetch: app.fetch, port })
console.log(`api on http://localhost:${port}`)
