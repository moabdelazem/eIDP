import { z } from 'zod'

/**
 * Every environment variable the API reads, in one place. Parsed once at boot
 * so a missing or malformed value fails immediately with a readable message
 * instead of surfacing as a confusing runtime error on the first request.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1).default('postgresql://eidp:eidp@localhost:5432/eidp'),
  /** Sync on boot and then on this interval. 0 disables the timer. */
  SYNC_INTERVAL_MINUTES: z.coerce.number().min(0).default(30),

  JWT_SECRET: z.string().min(16, 'must be at least 16 characters'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(8),

  LDAP_URL: z
    .string()
    .regex(/^ldaps?:\/\//, 'must start with ldap:// or ldaps://')
    .default('ldap://localhost:389'),
  LDAP_BASE_DN: z.string().min(1).default('dc=eidp,dc=local'),
  LDAP_BIND_DN: z.string().min(1).default('cn=admin,dc=eidp,dc=local'),
  LDAP_BIND_PASSWORD: z.string().min(1).default('admin'),
  /**
   * How an account is recognised. OpenLDAP usually means inetOrgPerson/uid;
   * Active Directory means user/sAMAccountName. Wrong values here look exactly
   * like a wrong password, so they are config rather than constants.
   */
  LDAP_USER_OBJECT_CLASS: z.string().min(1).default('inetOrgPerson'),
  LDAP_USER_ATTRIBUTE: z.string().min(1).default('uid'),
  /**
   * Overrides the two settings above when a directory needs a filter they
   * cannot express — Active Directory wants objectCategory=person to keep
   * computer accounts out. `{username}` is replaced, already escaped.
   */
  LDAP_USER_FILTER: z.string().min(1).optional(),
  /**
   * Finds the groups an account belongs to. `{dn}` is the account's DN, escaped.
   * Unset, it is chosen from what the server says it is (see `groupFilter`):
   * a hardcoded default is wrong for one of AD or OpenLDAP, and wrong here
   * means nobody is ever an approver.
   */
  LDAP_GROUP_FILTER: z.string().min(1).optional(),
  /** Members of this group decide requests, and nobody else can. */
  APPROVER_GROUP: z.string().min(1).default('DEVOPS'),

  // Azure DevOps Server (on-prem). Optional so the API still boots without
  // them; the integration reports what is missing when something asks it to
  // work. ADO_BASE_URL includes the collection, e.g.
  // https://tfs.example.com/tfs/DefaultCollection
  ADO_BASE_URL: z.string().url().optional(),
  /**
   * The server root, above any collection, for discovering collections.
   * Defaults to ADO_BASE_URL minus its last segment — the collection.
   */
  ADO_SERVER_URL: z.string().url().optional(),
  ADO_PAT: z.string().min(1).optional(),
  /** Pinned to the server release — it decides which endpoints exist. */
  ADO_API_VERSION: z.string().default('6.0'),

  /** Where the inventories repo lives inside that collection. */
  INVENTORIES_PROJECT: z.string().min(1).optional(),
  INVENTORIES_REPO: z.string().min(1).default('inventories'),
  /** Working copy the sync clones into and pulls on later runs. */
  INVENTORIES_CHECKOUT: z.string().min(1).default('.cache/inventories'),
})

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
  throw new Error(`Environment is not usable:\n${problems.join('\n')}`)
}
