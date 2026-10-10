import { boolean, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

export const jobRuns = pgTable('job_runs', {
  name: text().primaryKey(),
  runningSince: timestamp('running_since', { withTimezone: true }),
  owner: text(),
  lastStarted: timestamp('last_started', { withTimezone: true }),
  lastFinished: timestamp('last_finished', { withTimezone: true }),
  ok: boolean(),
  error: text(),
  summary: text(),
  durationMs: integer('duration_ms'),
})

export const locks = pgTable('locks', {
  name: text().primaryKey(),
  owner: text().notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})
