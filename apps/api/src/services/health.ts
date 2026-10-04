import { InvalidCredentialsError } from 'ldapts'
import * as ado from '../integrations/ado/index.ts'
import * as jenkins from '../integrations/jenkins/index.ts'
import * as jira from '../integrations/jira/index.ts'
import { probe as probeDirectory } from '../integrations/ldap/index.ts'
import * as ollama from '../integrations/ollama/index.ts'
import { vaultHealth } from '../integrations/vault/index.ts'
import { config } from '../lib/config.ts'
import { query } from '../lib/db.ts'
import { ApiError } from '../lib/errors.ts'
import { secretsState } from '../lib/secrets-state.ts'
import { readSyncState } from './catalog.ts'
import { accessState } from './jenkins-access.ts'
import { syncState } from './jenkins-sync.ts'

/**
 * The portal's health: everything it depends on, each asked now.
 *
 * Three groups. **Core** — Postgres and the directory — is what the portal
 * cannot work without: either down is the portal down. Secrets (Vault) sit
 * with them, but a Vault that goes away after boot does not stop a running
 * API; it makes the next restart fall back to .env, so it is a warning.
 * **Integrations** each power some pages, so one down is the portal degraded
 * and the card says which pages. **Background** jobs are judged by when they
 * last succeeded against how often they should run.
 *
 * Every check runs at once, each within `CHECK_TIMEOUT_MS`; a check that does
 * not answer is down, never a page that hangs. Answers are kept for
 * `CACHE_MS` and shared, so a room of people with the page open asks each
 * system once. Nothing secret is returned: names, versions, counts, ages.
 */

export type Status = 'ok' | 'degraded' | 'down' | 'off'
export type Group = 'core' | 'integration' | 'background'

export type Component = {
  id: string
  name: string
  group: Group
  status: Status
  /** One line: what is true now, and what to do when it is not. */
  summary: string
  facts: { label: string; value: string }[]
  /** How long the check took, for those that call out. */
  latencyMs: number | null
  /** What in the portal depends on it — what breaks when it does. */
  uses: string
}

export type Health = { status: 'ok' | 'degraded' | 'down'; checkedAt: string; components: Component[] }

const CHECK_TIMEOUT_MS = 8_000
const CACHE_MS = 15_000

let cached: { at: number; value: Health } | null = null
let inFlight: Promise<Health> | null = null

export function health({ fresh = false } = {}): Promise<Health> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.value)
  inFlight ??= checkAll()
    .then((value) => {
      cached = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

type Check = Omit<Component, 'latencyMs' | 'status' | 'summary' | 'facts'> & {
  run: () => Promise<Pick<Component, 'status' | 'summary'> & { facts?: Component['facts'] }>
}

const CHECKS: Check[] = [
  { id: 'postgres', name: 'Postgres', group: 'core', uses: 'Everything: requests, the catalog, access bindings, Jenkins history.', run: checkPostgres },
  { id: 'directory', name: 'Directory (LDAP)', group: 'core', uses: 'Sign-in, groups, and so every permission.', run: checkDirectory },
  { id: 'vault', name: 'Secrets (Vault)', group: 'core', uses: 'Where the API’s secrets come from at boot.', run: checkVault },
  { id: 'ado', name: 'Azure DevOps', group: 'integration', uses: 'The catalog sync, and repository, project and access requests.', run: checkAdo },
  { id: 'jira', name: 'Jira', group: 'integration', uses: 'Jira project requests.', run: checkJira },
  { id: 'jenkins', name: 'Jenkins', group: 'integration', uses: 'The Jenkins page and My pipelines.', run: checkJenkins },
  { id: 'ollama', name: 'Ollama', group: 'integration', uses: 'Failure explanations, the chatbot, request risk summaries and weekly digests.', run: checkOllama },
  { id: 'catalog', name: 'Catalog sync', group: 'background', uses: 'The projects map, ownership, and team-scoped access.', run: checkCatalog },
  { id: 'jenkins-history', name: 'Jenkins history', group: 'background', uses: 'The Jenkins dashboard, build search and My pipelines.', run: checkJenkinsHistory },
  { id: 'jenkins-access', name: 'Jenkins access rules', group: 'background', uses: 'Which teams see which runs on My pipelines.', run: checkJenkinsAccess },
]

async function checkAll(): Promise<Health> {
  const components = await Promise.all(CHECKS.map(timed))
  const coreDown = components.some((c) => c.group === 'core' && c.status === 'down' && c.id !== 'vault')
  const anyProblem = components.some((c) => c.status === 'down' || c.status === 'degraded')
  return { status: coreDown ? 'down' : anyProblem ? 'degraded' : 'ok', checkedAt: new Date().toISOString(), components }
}

async function timed({ run, ...check }: Check): Promise<Component> {
  const started = performance.now()
  let timer: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError()), CHECK_TIMEOUT_MS)
      }),
    ])
    return { ...check, facts: [], ...result, latencyMs: Math.round(performance.now() - started) }
  } catch (err) {
    const summary =
      err instanceof TimeoutError
        ? `No answer within ${CHECK_TIMEOUT_MS / 1000}s.`
        : err instanceof Error
          ? err.message
          : String(err)
    return { ...check, status: 'down', summary, facts: [], latencyMs: Math.round(performance.now() - started) }
  } finally {
    clearTimeout(timer)
  }
}

class TimeoutError extends Error {}

/** A configured-or-not integration: its own "not configured" error means off, not down. */
function notConfigured(err: unknown): boolean {
  return err instanceof ApiError && /_not_configured$/.test(err.code)
}

const ago = (iso: string) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`
  return `${Math.round(minutes / 1440)} days ago`
}
const host = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// ---- core -------------------------------------------------------------------------

async function checkPostgres() {
  const { rows } = await query<{ version: string; size: string; connections: string }>(
    `select current_setting('server_version') as version,
            pg_size_pretty(pg_database_size(current_database())) as size,
            (select count(*) from pg_stat_activity where datname = current_database()) as connections`,
  )
  const row = rows[0]!
  return {
    status: 'ok' as const,
    summary: 'Answering queries.',
    facts: [
      { label: 'Version', value: row.version.split(' ')[0]! },
      { label: 'Database size', value: row.size },
      { label: 'Connections', value: row.connections },
    ],
  }
}

async function checkDirectory() {
  try {
    const d = await probeDirectory()
    const facts = [
      { label: 'Server', value: host(d.url) },
      { label: 'Product', value: d.vendor },
      { label: 'Base DN', value: d.baseDn },
    ]
    if (!d.servesBaseDn) {
      return { status: 'degraded' as const, summary: `The server does not serve ${d.baseDn} — check LDAP_BASE_DN; nobody can be found to sign in.`, facts }
    }
    return { status: 'ok' as const, summary: 'Answering, and the service account binds.', facts }
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      return { status: 'down' as const, summary: 'The directory refused the service account — check LDAP_BIND_DN and LDAP_BIND_PASSWORD.', facts: [] }
    }
    throw new Error(`Cannot reach the directory at ${host(config.LDAP_URL)}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function checkVault() {
  const boot = secretsState()
  let now
  try {
    now = await vaultHealth()
  } catch (err) {
    // The running API already has its settings; the next restart would not.
    return {
      status: 'degraded' as const,
      summary: `${err instanceof Error ? err.message : String(err)} The API keeps the settings it loaded at boot; a restart now would fall back to .env.`,
      facts: [{ label: 'Loaded at boot from', value: boot.source === 'vault' ? 'Vault' : '.env' }],
    }
  }
  if (!now) return { status: 'off' as const, summary: 'Not configured — settings come from .env.', facts: [] }

  const facts = [
    { label: 'Server', value: host(now.addr) },
    ...(now.version ? [{ label: 'Version', value: now.version }] : []),
    ...(now.cluster ? [{ label: 'Cluster', value: now.cluster }] : []),
    { label: 'Paths', value: now.paths.join(', ') || 'none' },
    {
      label: 'Loaded at boot from',
      value: boot.source === 'vault' ? `Vault, ${boot.loaded.length} setting${boot.loaded.length === 1 ? '' : 's'}` : boot.source === 'env-fallback' ? '.env — Vault failed' : '.env',
    },
  ]
  if (!now.initialized) return { status: 'degraded' as const, summary: 'Vault is not initialised.', facts }
  if (now.sealed) return { status: 'degraded' as const, summary: 'Vault is sealed: the running API is fine, but a restart now would fall back to .env.', facts }
  if ('error' in now.readable) return { status: 'degraded' as const, summary: `The secrets do not read now: ${now.readable.error}`, facts }
  if (boot.source === 'env-fallback') {
    return { status: 'degraded' as const, summary: `Vault reads now, but at boot it did not (${boot.error}) — the API is running on .env. Restart it to load from Vault.`, facts }
  }
  return { status: 'ok' as const, summary: `Unsealed${now.standby ? ' (a standby answered)' : ''}, and the secrets read — ${now.readable.keys} key${now.readable.keys === 1 ? '' : 's'}.`, facts }
}

// ---- integrations ---------------------------------------------------------------------

async function checkAdo() {
  try {
    ado.adoConfig()
  } catch (err) {
    if (notConfigured(err)) return { status: 'off' as const, summary: (err as Error).message, facts: [] }
    throw err
  }
  const collections = await ado.listCollections()
  return {
    status: 'ok' as const,
    summary: 'Answering, and the PAT is accepted.',
    facts: [
      { label: 'Server', value: host(config.ADO_BASE_URL!) },
      { label: 'Collections', value: String(collections.length) },
    ],
  }
}

async function checkJira() {
  try {
    jira.jiraConfig()
  } catch (err) {
    if (notConfigured(err)) return { status: 'off' as const, summary: (err as Error).message, facts: [] }
    throw err
  }
  const info = await jira.serverInfo()
  return {
    status: 'ok' as const,
    summary: 'Answering, and the token is accepted.',
    facts: [
      { label: 'Server', value: host(info.baseUrl) },
      { label: 'Version', value: info.version },
      { label: 'Title', value: info.serverTitle },
    ],
  }
}

async function checkJenkins() {
  try {
    jenkins.jenkinsConfig()
  } catch (err) {
    if (notConfigured(err)) return { status: 'off' as const, summary: (err as Error).message, facts: [] }
    throw err
  }
  const version = await jenkins.jenkinsVersion()
  return {
    status: 'ok' as const,
    summary: 'Answering, and the API token is accepted.',
    facts: [{ label: 'Server', value: host(jenkins.jenkinsConfig().url) }, ...(version ? [{ label: 'Version', value: version }] : [])],
  }
}

async function checkOllama() {
  const s = await ollama.status()
  if (!s.configured) return { status: 'off' as const, summary: 'Not configured — every AI feature hides itself.', facts: [] }
  const facts = [
    { label: 'Server', value: host(ollama.ollamaConfig()!.url) },
    { label: 'Model', value: s.model ?? '—' },
  ]
  if (!s.reachable) return { status: 'down' as const, summary: 'Cannot reach Ollama — AI answers fail until it is back.', facts }
  if (!s.hasModel) return { status: 'degraded' as const, summary: `The model is not on the server — run "ollama pull ${s.model}".`, facts }
  return { status: 'ok' as const, summary: 'Answering, with the model pulled.', facts }
}

// ---- background -----------------------------------------------------------------------

/** Late when it has not succeeded for three of its intervals — one missed run is noise, three is a problem. */
const LATE_INTERVALS = 3

async function checkCatalog() {
  if (!config.INVENTORIES_PROJECT) return { status: 'off' as const, summary: 'Not configured — INVENTORIES_PROJECT is not set.', facts: [] }
  const s = await readSyncState()
  const facts = [
    ...(s.finishedAt ? [{ label: 'Last read', value: ago(s.finishedAt) }] : []),
    ...(s.commit ? [{ label: 'Commit', value: s.commit.slice(0, 8) }] : []),
    { label: 'Every', value: config.SYNC_INTERVAL_MINUTES > 0 ? `${config.SYNC_INTERVAL_MINUTES} min` : 'on demand' },
    ...(s.warnings.length ? [{ label: 'Files skipped', value: String(s.warnings.length) }] : []),
  ]
  if (!s.finishedAt) return { status: 'degraded' as const, summary: s.error ? `Never built: ${s.error}` : 'Never built yet — the first sync is running or due.', facts }
  if (!s.ok) return { status: 'degraded' as const, summary: `The last sync failed: ${s.error}. The map serves what the one before read.`, facts }
  const late = config.SYNC_INTERVAL_MINUTES > 0 && Date.now() - Date.parse(s.finishedAt) > LATE_INTERVALS * config.SYNC_INTERVAL_MINUTES * 60_000
  if (late) return { status: 'degraded' as const, summary: `No sync has finished since ${ago(s.finishedAt)} — the timer may have stopped.`, facts }
  return { status: 'ok' as const, summary: s.warnings.length ? 'Current; some files were skipped — they are listed under the map.' : 'Current.', facts }
}

function jenkinsOff() {
  try {
    jenkins.jenkinsConfig()
    return false
  } catch {
    return true
  }
}

async function checkJenkinsHistory() {
  if (jenkinsOff()) return { status: 'off' as const, summary: 'Jenkins is not configured.', facts: [] }
  const s = await syncState()
  const facts = [
    ...(s.finishedAt ? [{ label: 'Last read', value: ago(s.finishedAt) }] : []),
    { label: 'Every', value: config.JENKINS_SYNC_SECONDS > 0 ? `${config.JENKINS_SYNC_SECONDS}s` : 'on demand' },
    { label: 'Last run read', value: `${s.builds} build${s.builds === 1 ? '' : 's'} from ${s.jobsRead} job${s.jobsRead === 1 ? '' : 's'}` },
  ]
  if (!s.finishedAt) return { status: 'degraded' as const, summary: 'Not read yet — the first sync is running or due.', facts }
  if (!s.ok) return { status: 'degraded' as const, summary: `The last read failed: ${s.error}. Pages show what was read before.`, facts }
  const late = config.JENKINS_SYNC_SECONDS > 0 && Date.now() - Date.parse(s.finishedAt) > Math.max(LATE_INTERVALS * config.JENKINS_SYNC_SECONDS * 1000, 5 * 60_000)
  if (late) return { status: 'degraded' as const, summary: `Nothing read since ${ago(s.finishedAt)} — the timer may have stopped.`, facts }
  return { status: 'ok' as const, summary: s.error ? `Current; ${s.error}` : 'Current.', facts }
}

async function checkJenkinsAccess() {
  if (jenkinsOff()) return { status: 'off' as const, summary: 'Jenkins is not configured.', facts: [] }
  const s = await accessState()
  const source = s.source === 'role-strategy' ? 'Role-based strategy' : s.source === 'matrix' ? 'Matrix permissions' : 'None — the catalog decides'
  const facts = [...(s.readAt ? [{ label: 'Last read', value: ago(s.readAt) }] : []), { label: 'Rules from', value: source }, { label: 'Grants', value: String(s.grants) }]
  if (!s.readAt && !s.error) return { status: 'degraded' as const, summary: 'Not read yet — the first read is running or due.', facts }
  if (!s.ok) return { status: 'degraded' as const, summary: `The last read failed: ${s.error}${s.readAt ? ' The rules read before still apply.' : ''}`, facts }
  if (s.warnings.length) return { status: 'degraded' as const, summary: s.warnings.join(' '), facts }
  return { status: 'ok' as const, summary: s.source === 'none' ? 'Read; Jenkins has no per-team rules, so the catalog decides who sees what.' : 'Current.', facts }
}

// ---- history ---------------------------------------------------------------------------

/**
 * Asks everything now and keeps the answer — one row per component — for the
 * uptime bars and past incidents. Run on a timer (`HEALTH_SAMPLE_MINUTES`),
 * so history is sampled evenly whether or not anyone has the page open.
 *
 * ponytail: one API process samples; two would sample twice, which doubles
 * the rows but changes no percentage.
 */
export async function recordSample(): Promise<Health> {
  const now = await health({ fresh: true })
  await query(
    `insert into health_samples (at, component, status, latency_ms, summary)
     select $1, * from unnest($2::text[], $3::text[], $4::int[], $5::text[])`,
    [
      now.checkedAt,
      now.components.map((c) => c.id),
      now.components.map((c) => c.status),
      now.components.map((c) => c.latencyMs),
      now.components.map((c) => c.summary.slice(0, 500)),
    ],
  )
  await query(`delete from health_samples where at < now() - make_interval(days => $1)`, [config.HEALTH_RETENTION_DAYS])
  return now
}

/** One day of one component: its worst status, and how many samples said what. */
export type Day = { day: string; samples: number; down: number; degraded: number; worst: Status | 'none' }

export type Incident = {
  component: string
  name: string
  /** The worst it got. */
  status: 'down' | 'degraded'
  from: string
  /** When it was next seen working; null while it still is not. */
  to: string | null
  /** What the first sample of it said. */
  summary: string
}

export type History = {
  days: number
  /** The day each bar is, oldest first, so every component's bars line up. */
  dates: string[]
  components: Record<string, { uptime: number | null; days: Day[]; latency: { at: string; ms: number }[] }>
  incidents: Incident[]
  /** When sampling started — bars before it have no data, not an outage. */
  since: string | null
  sampleMinutes: number
}

const INCIDENT_DAYS = 14

/**
 * The last `days` days per component, as the status page draws them: each
 * day's worst status, the window's uptime (samples not down, out of samples
 * where it was configured), the last day's response times by hour, and the
 * incidents — runs of samples not ok — of the last two weeks.
 */
export async function history(days = 90): Promise<History> {
  const span = Math.min(days, config.HEALTH_RETENTION_DAYS)
  const [daily, latency, recent, first] = await Promise.all([
    query<{ component: string; day: string; samples: string; down: string; degraded: string; off: string }>(
      `select component, to_char(date_trunc('day', at), 'YYYY-MM-DD') as day, count(*) as samples,
              count(*) filter (where status = 'down') as down,
              count(*) filter (where status = 'degraded') as degraded,
              count(*) filter (where status = 'off') as off
         from health_samples where at >= date_trunc('day', now()) - make_interval(days => $1 - 1)
        group by 1, 2`,
      [span],
    ),
    query<{ component: string; at: Date; ms: number }>(
      `select component, date_trunc('hour', at) as at, round(avg(latency_ms))::int as ms
         from health_samples where at >= now() - interval '24 hours' and status <> 'off' and latency_ms is not null
        group by 1, 2 order by 2`,
    ),
    query<{ component: string; at: Date; status: Status; summary: string }>(
      `select component, at, status, summary from health_samples
        where at >= now() - make_interval(days => $1) order by component, at`,
      [INCIDENT_DAYS],
    ),
    query<{ at: Date | null }>('select min(at) as at from health_samples'),
  ])

  const dates: string[] = []
  const today = new Date()
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i))
    dates.push(d.toISOString().slice(0, 10))
  }

  const components: History['components'] = {}
  for (const check of CHECKS) {
    const rows = new Map(daily.rows.filter((r) => r.component === check.id).map((r) => [r.day, r]))
    let counted = 0
    let up = 0
    const bars = dates.map((day): Day => {
      const r = rows.get(day)
      if (!r) return { day, samples: 0, down: 0, degraded: 0, worst: 'none' }
      const [samples, down, degraded, off] = [r.samples, r.down, r.degraded, r.off].map(Number) as [number, number, number, number]
      counted += samples - off
      up += samples - off - down
      const worst: Day['worst'] = down ? 'down' : degraded ? 'degraded' : samples > off ? 'ok' : 'off'
      return { day, samples, down, degraded, worst }
    })
    components[check.id] = {
      uptime: counted ? up / counted : null,
      days: bars,
      latency: latency.rows.filter((r) => r.component === check.id).map((r) => ({ at: r.at.toISOString(), ms: r.ms })),
    }
  }

  return {
    days: span,
    dates,
    components,
    incidents: incidentsOf(recent.rows),
    since: first.rows[0]?.at?.toISOString() ?? null,
    sampleMinutes: config.HEALTH_SAMPLE_MINUTES,
  }
}

/** Runs of samples that were not ok, per component, newest first. Off is not an incident. */
export function incidentsOf(rows: { component: string; at: Date; status: Status; summary: string }[]): Incident[] {
  const names = new Map(CHECKS.map((c) => [c.id, c.name]))
  const incidents: Incident[] = []
  let open: Incident | null = null
  let previous: string | null = null
  for (const row of rows) {
    if (row.component !== previous) {
      if (open) incidents.push(open)
      open = null
      previous = row.component
    }
    const bad = row.status === 'down' || row.status === 'degraded'
    if (bad) {
      if (!open) {
        open = { component: row.component, name: names.get(row.component) ?? row.component, status: row.status as 'down' | 'degraded', from: row.at.toISOString(), to: null, summary: row.summary }
      } else if (row.status === 'down') open.status = 'down'
    } else if (open) {
      open.to = row.at.toISOString()
      incidents.push(open)
      open = null
    }
  }
  if (open) incidents.push(open)
  return incidents.sort((a, b) => b.from.localeCompare(a.from)).slice(0, 50)
}
