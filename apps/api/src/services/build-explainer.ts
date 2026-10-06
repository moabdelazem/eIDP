import { z } from 'zod'
import * as jenkins from '../integrations/jenkins/index.ts'
import type { BuildDetail } from '../integrations/jenkins/index.ts'
import * as ollama from '../integrations/ollama/index.ts'
import { query } from '../lib/db.ts'
import { ApiError } from '../lib/errors.ts'
import type { Actor } from './requests.ts'

/**
 * "What went wrong?" for a failed Jenkins build, answered by the model on our
 * own Ollama.
 *
 * The model is given what a person would look at — the failed stage, the
 * parameters, the commits, and the log's error lines with their context and
 * its last lines — and asked for a structured answer that cites log lines by
 * number. Three things keep that answer honest:
 *
 * - Secrets are redacted before the model sees anything: parameters are
 *   already `[hidden]`, and the log text goes through `redact`.
 * - A cited line must be one the model was shown, and its text is taken from
 *   the log, not from the model. An invented line number is dropped.
 * - The input is trimmed to the context window rather than left for Ollama to
 *   cut, which it does silently, from the front.
 *
 * One answer per build and prompt version is kept (`build_explanations`), so
 * a failure is explained once however many people open it; two people asking
 * at once share one call.
 */

/** Bumped when the prompt changes, so answers to the old one are not served as current. */
export const PROMPT_VERSION = 1

export const CATEGORIES = [
  'test_failure',
  'compilation',
  'dependency',
  'infrastructure',
  'configuration',
  'permission',
  'timeout',
  'flaky',
  'unknown',
] as const

export type Explanation = {
  summary: string
  cause: string
  category: (typeof CATEGORIES)[number]
  confidence: 'low' | 'medium' | 'high'
  /** Log lines the answer rests on, as numbered in the build page's log. */
  evidence: { line: number; text: string }[]
  nextSteps: string[]
  model: string
  createdAt: string
  createdByName: string
  durationMs: number
  /** The log was longer than the context window allowed; only part of it was read. */
  trimmed: boolean
  /** Made by the automatic run when the build failed, not asked for by someone. */
  automatic: boolean
}

// ---- the log ---------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const STAGE = /^\[Pipeline\] \{ \((.+)\)$/
// The same rules as the log viewer (apps/web components/log-viewer/parse.ts), so
// "an error line" means the same thing on both sides. Case-sensitive: ERROR is
// a log level, "error" is often prose.
const ERROR = /(^|[\s[])(ERROR|FATAL|SEVERE)\b|\bBUILD FAILURE\b|Finished: FAILURE|\b(Failures|Errors): [1-9]|exit code [1-9]|Exception\b|^\s+at [\w$.]+\(/

/** The log as the build page numbers it: ANSI stripped, one entry per line, from 1. */
export function logLines(log: string): string[] {
  return log.replace(ANSI, '').replace(/\n$/, '').split('\n')
}

/**
 * Removes what should never leave the log for a model, even one on our own
 * machines: credentials in URLs, authorization headers, `key=value` pairs
 * under secret-like names, private keys, and tokens by their shapes. Jenkins
 * masks the credentials it binds; this is for everything else.
 */
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[hidden private key]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[hidden]@')
    .replace(/\b(authorization|proxy-authorization)(\s*[:=]\s*)(bearer|basic|token|negotiate)?\s*[^\s"',]+/gi, (_, name, sep, scheme) => `${name}${sep}${scheme ? `${scheme} ` : ''}[hidden]`)
    // A flag's value: `--password x`, `-Dsecret.key=x`.
    .replace(/(^|\s)(--?[\w.-]*(?:password|passwd|secret|token|api[-_]?key|access[-_]?key|credentials?)[\w.-]*)(=|\s+)(["']?)[^\s"',;]+/gi, '$1$2$3$4[hidden]')
    // An assignment: `DB_PASSWORD=x`, `api_key: x`. Only with = or :, so
    // "token expired" in prose is left alone.
    .replace(/\b([\w.-]*(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credentials?))(\s*[:=]\s*)(["']?)(?!\[hidden\])[^\s"',;]+/gi, '$1$2$3[hidden]')
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[hidden]')
    .replace(/\b(ghp|gho|ghs|glpat|xox[bap])[-_][A-Za-z0-9_-]{16,}\b/g, '[hidden]')
    .replace(/\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+\b/g, '[hidden]')
}

type Block = { from: number; to: number }

/**
 * The parts of a log worth a model's attention, numbered as the page numbers
 * them, within `budget` characters. Around each error line, six before and
 * three after; every stage heading, so it can tell where it is; the last 30
 * lines, where the build says how it ended. With no error line at all, the
 * last 120.
 *
 * When that is still too long, the first error and the end are kept, then the
 * errors nearest the end: the first error is usually the cause, and the last
 * ones are what stopped the build.
 */
export function excerpt(lines: string[], budget: number): { text: string; shown: Set<number>; trimmed: boolean } {
  const total = lines.length
  const errors: number[] = []
  const stages: number[] = []
  lines.forEach((text, i) => {
    if (STAGE.test(text)) stages.push(i + 1)
    else if (ERROR.test(text)) errors.push(i + 1)
  })

  const clamp = (n: number) => Math.min(Math.max(n, 1), total)
  const tail: Block = { from: clamp(total - (errors.length ? 29 : 119)), to: total }
  const around = mergeBlocks(errors.map((n) => ({ from: clamp(n - 6), to: clamp(n + 3) })))
  // In priority order: the first error, the end, then errors from the last back.
  const ordered = [...around.slice(0, 1), tail, ...around.slice(1).reverse()]

  const render = (n: number) => `${n}: ${redact(lines[n - 1]!).slice(0, 400)}`
  const size = (b: Block) => {
    let chars = 0
    for (let n = b.from; n <= b.to; n++) chars += render(n).length + 1
    return chars
  }

  const chosen: Block[] = []
  let used = 0
  let trimmed = false
  for (const block of ordered) {
    const cost = size(block)
    if (used + cost <= budget) {
      chosen.push(block)
      used += cost
    } else trimmed = true
  }
  // Nothing fits whole (one enormous line): keep as much of the end as fits.
  if (chosen.length === 0 && total > 0) {
    let from = total
    while (from > 1 && used + render(from - 1).length + 1 <= budget) used += render(--from).length + 1
    chosen.push({ from, to: total })
    trimmed = true
  }

  const shown = new Set<number>()
  for (const block of mergeBlocks(chosen)) for (let n = block.from; n <= block.to; n++) shown.add(n)
  // Stage headings cost a line each and tell the model which stage a line is in.
  for (const n of stages) shown.add(n)

  const numbers = [...shown].sort((a, b) => a - b)
  const out: string[] = []
  numbers.forEach((n, i) => {
    if (i > 0 && n - numbers[i - 1]! > 1) out.push(`… (${n - numbers[i - 1]! - 1} lines not shown)`)
    out.push(render(n))
  })
  // `trimmed` means the budget dropped something worth reading — not that
  // the excerpt left out the log's ordinary lines, which it always does.
  return { text: out.join('\n'), shown, trimmed }
}

function mergeBlocks(blocks: Block[]): Block[] {
  const sorted = [...blocks].sort((a, b) => a.from - b.from)
  const merged: Block[] = []
  for (const b of sorted) {
    const last = merged.at(-1)
    if (last && b.from <= last.to + 1) last.to = Math.max(last.to, b.to)
    else merged.push({ ...b })
  }
  return merged
}

// ---- asking ------------------------------------------------------------------

const SYSTEM = `You help a DevOps team understand why a Jenkins build failed.
You are given facts about one build and an excerpt of its console log. Every log line starts with its line number and a colon.

Rules:
- Base every statement on the log excerpt and the facts given. Do not invent files, commands, versions or causes that are not in them.
- If the log does not show the cause clearly, say so and set confidence to "low".
- evidence: the line numbers that show the cause, exactly as numbered in the excerpt — at most 5, most important first.
- summary: one plain sentence a busy engineer can act on, naming the failing step.
- cause: two to four sentences explaining what happened and why, in plain language.
- nextSteps: at most 3 concrete actions, most useful first. No generic advice like "check the logs".
- category: the single best fit.
Answer in JSON matching the schema.`

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    cause: { type: 'string' },
    category: { type: 'string', enum: [...CATEGORIES] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    evidence: { type: 'array', items: { type: 'integer' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'cause', 'category', 'confidence', 'evidence', 'nextSteps'],
} as const

const Answer = z.object({
  summary: z.string().trim().min(1).max(1000),
  cause: z.string().trim().min(1).max(4000),
  category: z.enum(CATEGORIES).catch('unknown'),
  confidence: z.enum(['low', 'medium', 'high']).catch('low'),
  evidence: z.array(z.coerce.number().int()).catch([]),
  nextSteps: z.array(z.string().trim().min(1).max(600)).catch([]),
})

/** What the model is told about the build, besides the log. */
export function facts(build: BuildDetail): string {
  const broke = (s: { result: string }) => s.result === 'failure' || s.result === 'unstable'
  const failed = build.stages.find(broke)
  // Of a stage's parallel branches, the ones that broke it.
  const branches = failed?.branches.filter(broke).map((b) => b.name) ?? []
  const lines = [
    `Job: ${build.job}`,
    `Build: #${build.number}`,
    `Result: ${build.result}`,
    ...(build.stages.length ? [`Stages: ${build.stages.map((s) => `${s.name} (${s.result})`).join(', ')}`] : []),
    ...(failed ? [`Failed stage: ${failed.name}`] : []),
    ...(branches.length ? [`Failed in parallel branch: ${branches.join(', ')}`] : []),
    ...(build.causes.length ? [`Started by: ${build.causes.join('; ')}`] : []),
    ...(build.parameters.length ? [`Parameters: ${build.parameters.map((p) => `${p.name}=${p.value ?? ''}`).join(', ')}`] : []),
    ...(build.changes.length ? [`Commits in this build: ${build.changes.map((c) => redact(c.message).slice(0, 200)).join(' | ')}`] : ['Commits in this build: none']),
    ...(build.builtOn ? [`Agent: ${build.builtOn}`] : []),
  ]
  return lines.join('\n')
}

/** Characters of log that fit: the window, less room for the instructions, the facts and the answer. */
function budgetFor(numCtx: number): number {
  // Logs are dense in tokens — paths, hashes, punctuation — so three
  // characters a token, not the four of prose.
  return Math.max((numCtx - 2000) * 3, 2000)
}

// ---- the service ---------------------------------------------------------------

const EXPLAINABLE = new Set(['failure', 'unstable'])
const inFlight = new Map<string, Promise<Explanation>>()

/** The kept answer for a build, if one was made with the current prompt and model. */
export async function cached(job: string, number: number): Promise<Explanation | null> {
  const ai = ollama.ollamaConfig()
  if (!ai) return null
  const { rows } = await query<ExplanationRow>(
    `select * from build_explanations
      where server = $1 and job = $2 and number = $3 and prompt_version = $4 and model = $5`,
    [jenkins.jenkinsConfig().url, job, number, PROMPT_VERSION, ai.model],
  )
  return rows[0] ? toExplanation(rows[0]) : null
}

/** What a list shows of an answer: enough to say why, and what to try. */
export type Brief = Pick<Explanation, 'summary' | 'category' | 'confidence' | 'nextSteps' | 'createdAt' | 'automatic'>

/**
 * The kept answers for many builds at once, keyed `job#number` — one query,
 * for a list of runs. Only answers made with the current prompt and model.
 */
export async function keptFor(builds: { job: string; number: number }[]): Promise<Map<string, Brief>> {
  const ai = ollama.ollamaConfig()
  const found = new Map<string, Brief>()
  if (!ai || builds.length === 0) return found
  const { rows } = await query<ExplanationRow & { job: string; number: number }>(
    `select e.* from build_explanations e
       join unnest($4::text[], $5::int[]) as b(job, number) on b.job = e.job and b.number = e.number
      where e.server = $1 and e.prompt_version = $2 and e.model = $3`,
    [jenkins.jenkinsConfig().url, PROMPT_VERSION, ai.model, builds.map((b) => b.job), builds.map((b) => b.number)],
  )
  for (const row of rows) {
    const { summary, category, confidence, nextSteps, createdAt, automatic } = toExplanation(row)
    found.set(`${row.job}#${row.number}`, { summary, category, confidence, nextSteps, createdAt, automatic })
  }
  return found
}

/**
 * Explains a failed or unstable build: the kept answer unless `fresh`, else
 * one asked of the model now. Two calls for the same build share one answer.
 */
export function explain(job: string, number: number, actor: Actor, { fresh = false } = {}): Promise<Explanation> {
  const key = `${job}#${number}`
  const running = inFlight.get(key)
  if (running) return running
  const work = (async () => {
    if (!fresh) {
      const kept = await cached(job, number)
      if (kept) return kept
    }
    return ask(job, number, actor)
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, work)
  return work
}

async function ask(job: string, number: number, actor: Actor): Promise<Explanation> {
  const ai = ollama.ollamaConfig()
  if (!ai) throw new ApiError(503, 'ollama_not_configured', 'The portal’s AI is not configured: OLLAMA_URL is not set.')

  const [build, log] = await Promise.all([jenkins.buildDetail(job, number), jenkins.logTail(job, number)])
  if (!EXPLAINABLE.has(build.result)) {
    throw new ApiError(409, 'not_failed', 'Only a failed or unstable build is explained.')
  }

  const lines = logLines(log.text)
  const about = facts(build)
  const part = excerpt(lines, budgetFor(ai.numCtx) - about.length)
  const user = `${about}\n\nConsole log excerpt${log.truncated || part.trimmed ? ' (partial — only these lines are shown)' : ''}:\n${part.text}`

  const answer = await askOnce(user).catch(async (err) => {
    // A small model sometimes breaks its JSON; one more try usually mends it.
    if (err instanceof ApiError && err.code === 'ollama_bad_answer') return askOnce(user)
    throw err
  })

  // Only lines it was shown, in the log's own words, each once.
  const cited = [...new Set(answer.parsed.evidence)].filter((n) => part.shown.has(n)).slice(0, 5)
  const explanation = {
    summary: answer.parsed.summary,
    cause: answer.parsed.cause,
    category: answer.parsed.category,
    confidence: cited.length === 0 && answer.parsed.confidence === 'high' ? 'medium' : answer.parsed.confidence,
    evidence: cited.map((n) => ({ line: n, text: redact(lines[n - 1] ?? '').slice(0, 400) })),
    nextSteps: answer.parsed.nextSteps.slice(0, 3),
  }
  const trimmed = log.truncated || part.trimmed

  const { rows } = await query<ExplanationRow>(
    `insert into build_explanations
       (server, job, number, prompt_version, model, explanation, trimmed, prompt_tokens, duration_ms, created_by, created_by_name)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (server, job, number, prompt_version, model) do update set
       explanation = excluded.explanation, trimmed = excluded.trimmed, prompt_tokens = excluded.prompt_tokens,
       duration_ms = excluded.duration_ms, created_by = excluded.created_by,
       created_by_name = excluded.created_by_name, created_at = now()
     returning *`,
    [jenkins.jenkinsConfig().url, job, number, PROMPT_VERSION, ai.model, explanation, trimmed, answer.promptTokens, answer.durationMs, actor.uid, actor.name],
  )
  return toExplanation(rows[0]!)
}

async function askOnce(user: string) {
  const result = await ollama.chat(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    { format: SCHEMA },
  )
  let json: unknown
  try {
    json = JSON.parse(result.content)
  } catch {
    throw new ApiError(502, 'ollama_bad_answer', 'The model’s answer could not be read. Try again.')
  }
  const parsed = Answer.safeParse(json)
  if (!parsed.success) throw new ApiError(502, 'ollama_bad_answer', 'The model’s answer was missing parts. Try again.')
  return { parsed: parsed.data, promptTokens: result.promptTokens, durationMs: result.durationMs }
}

type ExplanationRow = {
  explanation: Omit<Explanation, 'model' | 'createdAt' | 'createdByName' | 'durationMs' | 'trimmed' | 'automatic'>
  model: string
  created_by: string
  created_at: Date
  created_by_name: string
  duration_ms: number
  trimmed: boolean
}

function toExplanation(row: ExplanationRow): Explanation {
  return {
    ...row.explanation,
    model: row.model,
    createdAt: row.created_at.toISOString(),
    createdByName: row.created_by_name,
    durationMs: row.duration_ms,
    trimmed: row.trimmed,
    automatic: row.created_by === 'e-idp',
  }
}
