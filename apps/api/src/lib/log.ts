import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The API's log: one line per event, JSON in production so a collector can
 * read fields rather than parse prose, text on a laptop. Everything logged
 * inside a request carries that request's id (and who made it, once known),
 * so one failure can be followed across replicas — the id is Envoy's
 * `x-request-id` when the Gateway sent one.
 *
 * Its two settings are read from `process.env` directly, like Vault's: the log
 * has to work before `lib/config.ts` may be parsed. Values are never logged —
 * names, ids and counts only (CLAUDE.md).
 */

export type Level = 'debug' | 'info' | 'warn' | 'error'
export type Fields = Record<string, unknown>

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const env = (name: string) => process.env[name]?.trim() || undefined
const format: 'json' | 'text' = env('LOG_FORMAT') === 'json' || (env('LOG_FORMAT') !== 'text' && env('NODE_ENV') === 'production') ? 'json' : 'text'
const threshold = RANK[(env('LOG_LEVEL') as Level | undefined) ?? 'info'] ?? RANK.info

const context = new AsyncLocalStorage<Fields>()

/** Runs `fn` with these fields on every line it logs — a request, a job run. */
export function withLogContext<T>(fields: Fields, fn: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, fn)
}

/** Adds to the current context, e.g. who is signed in once auth has run. */
export function addLogContext(fields: Fields): void {
  const store = context.getStore()
  if (store) Object.assign(store, fields)
}

/** An error as fields: its message always, its stack only when it is a bug rather than an expected failure. */
export function errorFields(err: unknown, { stack = false } = {}): Fields {
  if (!(err instanceof Error)) return { error: String(err) }
  return { error: err.message, ...(stack && err.stack ? { stack: err.stack } : {}) }
}

function write(level: Level, msg: string, fields?: Fields): void {
  if (RANK[level] < threshold) return
  const all = { ...context.getStore(), ...fields }
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout
  if (format === 'json') {
    out.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...all })}\n`)
    return
  }
  const { stack, ...rest } = all
  const extra = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === 'string' && !/\s/.test(v) ? v : JSON.stringify(v)}`)
    .join(' ')
  out.write(`${level === 'info' ? '' : `${level.toUpperCase()} `}${msg}${extra ? ` ${extra}` : ''}\n${typeof stack === 'string' ? `${stack}\n` : ''}`)
}

export const log = {
  debug: (msg: string, fields?: Fields) => write('debug', msg, fields),
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
}
