import { z } from 'zod'

/**
 * Every environment variable the API reads, in one place. Parsed once at boot
 * so a missing or malformed value fails immediately with a readable message
 * instead of surfacing as a confusing runtime error on the first request.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),

  JWT_SECRET: z.string().min(16, 'must be at least 16 characters'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(8),

  LDAP_URL: z
    .string()
    .regex(/^ldaps?:\/\//, 'must start with ldap:// or ldaps://')
    .default('ldap://localhost:389'),
  LDAP_BASE_DN: z.string().min(1).default('dc=eidp,dc=local'),
  LDAP_BIND_DN: z.string().min(1).default('cn=admin,dc=eidp,dc=local'),
  LDAP_BIND_PASSWORD: z.string().min(1).default('admin'),
})

export type Config = z.infer<typeof schema>

export const config: Config = load()

function load(): Config {
  const parsed = schema.safeParse(process.env)
  if (parsed.success) return parsed.data

  const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
  throw new Error(`Environment is not usable:\n${problems.join('\n')}`)
}
