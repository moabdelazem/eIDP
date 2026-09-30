import * as jenkins from '../integrations/jenkins/index.ts'
import * as ollama from '../integrations/ollama/index.ts'
import { config } from '../lib/config.ts'
import { query } from '../lib/db.ts'
import { ApiError } from '../lib/errors.ts'
import { explain, PROMPT_VERSION } from './build-explainer.ts'
import type { Actor } from './requests.ts'

/**
 * Failed builds explained as they happen, so the answer is waiting when
 * someone opens the build — rather than after a click and a minute's wait.
 *
 * What is explained is kept small on purpose, because every answer is GPU
 * time on a shared host:
 *
 * - only each job's **latest** build, and only when it failed or was
 *   unstable — a job failing twenty times in a row is explained once per new
 *   failure, never twenty times over;
 * - only failures from the last `OLLAMA_AUTO_EXPLAIN_HOURS` (24) — turning
 *   this on does not work through a month of history;
 * - at most `PER_RUN` per run, **one at a time**, newest first, after each
 *   Jenkins sync.
 *
 * A build the model fails on is tried again once, fifteen minutes later,
 * then left for someone to ask by hand. When Ollama itself is down the run
 * stops without counting it against the build: that is not the build's fault,
 * and the next sync tries again.
 */

/** Who an automatic explanation is by, as the page shows it. */
export const AUTOMATIC: Actor = { uid: 'e-idp', name: 'e-IDP, automatically' }

const PER_RUN = 5
const MAX_ATTEMPTS = 2
const RETRY_AFTER_MINUTES = 15

/** Errors that say Ollama is unavailable, not that this build cannot be explained. */
const OLLAMA_DOWN = new Set(['ollama_unreachable', 'ollama_model_missing', 'ollama_not_configured', 'ollama_error'])

export function enabled(): boolean {
  return config.OLLAMA_AUTO_EXPLAIN && ollama.ollamaConfig() !== null && Boolean(config.JENKINS_URL && config.JENKINS_USER && config.JENKINS_TOKEN)
}

let inFlight: Promise<{ explained: number; failed: number }> | null = null

/** Explains new failures. A call while a run is going joins it. */
export function explainNewFailures(): Promise<{ explained: number; failed: number }> {
  if (!enabled()) return Promise.resolve({ explained: 0, failed: 0 })
  inFlight ??= run().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function run(): Promise<{ explained: number; failed: number }> {
  let explained = 0
  let failed = 0
  for (const { job, number } of await candidates(PER_RUN)) {
    try {
      // Shares a call already running for the same build — someone may have clicked.
      await explain(job, number, AUTOMATIC)
      explained++
    } catch (err) {
      const code = err instanceof ApiError ? err.code : ''
      if (OLLAMA_DOWN.has(code)) {
        console.warn(`auto-explain: stopping, Ollama is unavailable (${code})`)
        break
      }
      failed++
      await recordFailure(job, number, err instanceof Error ? err.message : String(err))
    }
  }
  return { explained, failed }
}

/**
 * The latest build of each job Jenkins still has, when it failed or was
 * unstable within the window, not yet explained with the current prompt and
 * model, and not given up on or tried in the last fifteen minutes.
 */
async function candidates(limit: number, only?: { job: string; number: number }): Promise<{ job: string; number: number }[]> {
  const ai = ollama.ollamaConfig()!
  const { rows } = await query<{ job: string; number: number }>(
    `with latest as (
       select distinct on (b.job) b.job, b.number, b.result, b.started_at
         from jenkins_builds b
         join jenkins_jobs j on j.server = b.server and j.full_name = b.job
        where b.server = $1 and b.result not in ('running', 'not_built')
        order by b.job, b.number desc
     )
     select l.job, l.number from latest l
      where l.result in ('failure', 'unstable')
        and l.started_at >= now() - make_interval(hours => $2)
        and ($6::text is null or (l.job = $6 and l.number = $7))
        and not exists (
          select 1 from build_explanations e
           where e.server = $1 and e.job = l.job and e.number = l.number and e.prompt_version = $3 and e.model = $4)
        and not exists (
          select 1 from build_explain_attempts a
           where a.server = $1 and a.job = l.job and a.number = l.number and a.prompt_version = $3 and a.model = $4
             and (a.attempts >= ${MAX_ATTEMPTS} or a.last_attempt_at > now() - make_interval(mins => ${RETRY_AFTER_MINUTES})))
      order by l.started_at desc
      limit $5`,
    [jenkins.jenkinsConfig().url, config.OLLAMA_AUTO_EXPLAIN_HOURS, PROMPT_VERSION, ai.model, limit, only?.job ?? null, only?.number ?? null],
  )
  return rows
}

async function recordFailure(job: string, number: number, error: string): Promise<void> {
  const ai = ollama.ollamaConfig()!
  await query(
    `insert into build_explain_attempts (server, job, number, prompt_version, model, attempts, last_error)
     values ($1, $2, $3, $4, $5, 1, $6)
     on conflict (server, job, number, prompt_version, model) do update set
       attempts = build_explain_attempts.attempts + 1, last_error = excluded.last_error, last_attempt_at = now()`,
    [jenkins.jenkinsConfig().url, job, number, PROMPT_VERSION, ai.model, error.slice(0, 1000)],
  )
}

/**
 * Where a build stands with automatic explaining, for the page: `queued` —
 * it will be explained shortly; `failed` — the model could not, and why;
 * `off` — it is not one the automatic run explains (turned off, too old, or
 * not the job's latest build). An existing explanation is read separately.
 */
export async function status(job: string, number: number): Promise<{ state: 'queued' | 'failed' | 'off'; error: string | null }> {
  if (!enabled()) return { state: 'off', error: null }
  const ai = ollama.ollamaConfig()!
  const { rows } = await query<{ attempts: number; last_error: string | null }>(
    `select attempts, last_error from build_explain_attempts
      where server = $1 and job = $2 and number = $3 and prompt_version = $4 and model = $5`,
    [jenkins.jenkinsConfig().url, job, number, PROMPT_VERSION, ai.model],
  )
  if ((await candidates(1, { job, number })).length > 0) return { state: 'queued', error: null }
  if (rows[0]) return { state: 'failed', error: rows[0].last_error }
  return { state: 'off', error: null }
}
