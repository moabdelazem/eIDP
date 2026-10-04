import { z } from 'zod'

/**
 * Every environment variable the API reads, in one place. Parsed once at boot
 * so a missing or malformed value fails immediately with a readable message
 * instead of surfacing as a confusing runtime error on the first request.
 */
export const schema = z.object({
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

  // Jira Data Center / Server (on-prem). Optional like ADO: the API boots
  // without them and `jiraConfig()` names what is missing when asked to work.
  JIRA_BASE_URL: z.string().url().optional(),
  /**
   * A personal access token, sent as a Bearer token. With JIRA_USERNAME set it
   * is sent as that user's password instead (Basic), for servers older than
   * PATs (8.14).
   */
  JIRA_TOKEN: z.string().min(1).optional(),
  JIRA_USERNAME: z.string().min(1).optional(),
  /** What a new project is made from. Scrum by default; see `.env.example`. */
  JIRA_PROJECT_TEMPLATE: z.string().min(1).default('com.pyxis.greenhopper.jira:gh-simplified-scrum-classic'),
  /** The project role the requester and their team are put in. */
  JIRA_MEMBER_ROLE: z.string().min(1).default('Developers'),

  // Jenkins. Optional: the Jenkins page says what is missing rather than the
  // API failing to boot. JENKINS_TOKEN is an API token of JENKINS_USER — API
  // token calls are exempt from Jenkins' CSRF crumbs, a password is not.
  JENKINS_URL: z.string().url().optional(),
  JENKINS_USER: z.string().min(1).optional(),
  JENKINS_TOKEN: z.string().min(1).optional(),
  /** How often build history is pulled from Jenkins. 0 turns the timer off. */
  JENKINS_SYNC_SECONDS: z.coerce.number().min(0).default(60),
  /** Build history older than this is dropped. The page looks back 7 days. */
  JENKINS_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  /** How often who-may-see-which-job is read from Jenkins' authorization. 0 turns the timer off. */
  JENKINS_ACCESS_SYNC_MINUTES: z.coerce.number().min(0).default(15),

  /** How often every component's health is sampled for the history on System health. 0 turns it off. */
  HEALTH_SAMPLE_MINUTES: z.coerce.number().min(0).default(5),
  /** How long health samples are kept — the uptime bars show this many days. */
  HEALTH_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  /** How long Platform activity keeps sign-ins, page visits and chatbot questions. */
  ACTIVITY_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  // Ollama, for the portal's AI features. Optional: without it they hide
  // themselves. Runs on our own machines, so what it reads stays inside.
  OLLAMA_URL: z.string().url().optional(),
  /** An Ollama tag. `qwen2.5` is Qwen 2.5 7B; name a larger one if the host can carry it. */
  OLLAMA_MODEL: z.string().min(1).default('qwen2.5'),
  /**
   * The context window asked for on every call. Ollama's own default is
   * small and it cuts a longer prompt silently — from the front, where the
   * instructions are — so this is always sent, and input is trimmed to fit it.
   */
  OLLAMA_NUM_CTX: z.coerce.number().int().min(2048).default(8192),
  /** How long one answer may take. A 7B model on CPU needs most of a minute. */
  OLLAMA_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),
  /**
   * Explain failed builds as they happen, not only when someone asks. Only
   * each job's latest failure, one at a time, after each Jenkins sync.
   */
  OLLAMA_AUTO_EXPLAIN: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** How far back automatic explaining looks. Older failures are explained on request. */
  OLLAMA_AUTO_EXPLAIN_HOURS: z.coerce.number().positive().default(24),

  /** How often to look for last week's missing team digests (0 turns it off). */
  DIGEST_CHECK_MINUTES: z.coerce.number().min(0).default(60),

  /** Where the inventories repo lives inside that collection. */
  INVENTORIES_PROJECT: z.string().min(1).optional(),
  INVENTORIES_REPO: z.string().min(1).default('inventories'),
  /** Working copy the sync clones into and pulls on later runs. */
  INVENTORIES_CHECKOUT: z.string().min(1).default('.cache/inventories'),
})

/**
 * The names the API reads. Secrets loaded from Vault are taken only under
 * these names: a secret store must not be able to set NODE_OPTIONS or PATH
 * for the API and every git it starts.
 */
export const CONFIG_KEYS: readonly string[] = Object.keys(schema.shape)
