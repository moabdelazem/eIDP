import { z } from 'zod'

/**
 * The health service's settings, from the environment (and the repository's
 * `.env`, which `--env-file-if-exists` reads). It needs little: the database
 * it shares with the portal, the token the two use with each other, and where
 * the portal is. Blank values count as unset, as they do in the portal.
 */
const TOKEN_HELP =
  'not set, or shorter than 16 characters. Put the same long random value in .env as HEALTH_TOKEN for the portal and the health service, and HEALTH_SERVICE_URL=http://localhost:3100 for the portal (see .env.example) — `openssl rand -hex 24` makes one. scripts/dev.sh fills both in.'

const schema = z.object({
  DATABASE_URL: z.string({ error: 'not set — the health service keeps its samples in the portal’s Postgres; use the portal’s DATABASE_URL.' }),
  /** Shared with the portal: it is how each knows the other. At least 16 characters. */
  HEALTH_TOKEN: z
    .string({ error: TOKEN_HELP })
    .min(16, TOKEN_HELP),
  HEALTH_PORT: z.coerce.number().int().positive().default(3100),
  /** Where the portal API answers; its dependencies are read from `<PORTAL_URL>/internal/health`. */
  PORTAL_URL: z.string().url().default('http://localhost:3000'),
  /** How often everything is sampled. 0 stops sampling (the API still answers). */
  HEALTH_SAMPLE_MINUTES: z.coerce.number().min(0).default(5),
  HEALTH_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  /** How many samples in a row must say down or degraded before an alert is raised — one blip is not an outage. */
  HEALTH_ALERT_AFTER: z.coerce.number().int().min(1).default(2),
  /** Who hears about every alert, comma-separated; a machine can name more. The mail service will send to them. */
  HEALTH_ALERT_TO: z
    .string()
    .default('')
    .transform((s) => s.split(/[\s,;]+/).filter(Boolean)),
  /** How long a machine's port, URL or exporter has to answer. */
  MACHINE_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
})

export type Config = z.infer<typeof schema>

export const config: Config = load()

function load(): Config {
  const present = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ''))
  const parsed = schema.safeParse(present)
  if (parsed.success) return parsed.data
  throw new Error(`The health service’s environment is not usable:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`)
}
