import type { AccessState } from '@eidp/contracts/pipelines'
import type { SidType } from '../../integrations/jenkins/index.ts'
import type { AuditEntry, Parameter } from '@eidp/contracts/jenkins'
import { sql } from 'drizzle-orm'
import { bigint, bigserial, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

export const jenkinsSync = pgTable('jenkins_sync', {
  server: text().primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  ok: boolean().default(false).notNull(),
  error: text(),
  builds: integer().default(0).notNull(),
  jobsRead: integer('jobs_read').default(0).notNull(),
})

export const jenkinsJobs = pgTable('jenkins_jobs', {
  server: text().notNull(),
  fullName: text('full_name').notNull(),
  url: text().notNull(),
  buildable: boolean().default(true).notNull(),
  inQueue: boolean('in_queue').default(false).notNull(),
  lastNumber: integer('last_number'),
}, (table) => [
  primaryKey({ columns: [table.server, table.fullName], name: 'jenkins_jobs_pkey' }),
])

export const jenkinsBuilds = pgTable('jenkins_builds', {
  server: text().notNull(),
  job: text().notNull(),
  number: integer().notNull(),
  result: text().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  durationMs: bigint('duration_ms', { mode: 'number' }).default(0).notNull(),
  url: text().notNull(),
  builtOn: text('built_on'),
  parameters: jsonb().$type<Parameter[]>().default([]).notNull(),
  causes: text().array().default(sql`'{}'`).notNull(),
  authors: text().array().default(sql`'{}'`).notNull(),
  agentChecked: boolean('agent_checked').default(false).notNull(),
}, (table) => [
  index('jenkins_builds_running_idx').on(table.server, table.job).where(sql`(result = 'running'::text)`),
  index('jenkins_builds_started_idx').on(table.server, table.startedAt.desc().nullsFirst()),
  primaryKey({ columns: [table.server, table.job, table.number], name: 'jenkins_builds_pkey' }),
])

export const jenkinsIgnored = pgTable('jenkins_ignored', {
  server: text().notNull(),
  job: text().notNull(),
  fromNumber: integer('from_number').notNull(),
  untilPass: boolean('until_pass').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  reason: text().notNull(),
  ignoredBy: text('ignored_by').notNull(),
  ignoredByName: text('ignored_by_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.server, table.job], name: 'jenkins_ignored_pkey' }),
])

export const jenkinsAudit = pgTable('jenkins_audit', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  actor: text().notNull(),
  actorName: text('actor_name').notNull(),
  action: text().$type<AuditEntry['action']>().notNull(),
  job: text().notNull(),
  build: integer(),
  queueId: bigint('queue_id', { mode: 'number' }),
  ok: boolean().notNull(),
  error: text(),
  note: text(),
}, (table) => [
  index('jenkins_audit_at_idx').on(table.at),
  check('jenkins_audit_action_check', sql`action = ANY (ARRAY['rebuild'::text, 'stop'::text, 'cancel'::text, 'ignore'::text, 'unignore'::text])`),
])

export const jenkinsJobAccess = pgTable('jenkins_job_access', {
  server: text().notNull(),
  job: text().notNull(),
  sid: text().notNull(),
  sidType: text('sid_type').$type<SidType>().notNull(),
  via: text().notNull(),
}, (table) => [
  index('jenkins_job_access_sid_idx').on(sql`server`, sql`lower(sid)`),
  primaryKey({ columns: [table.server, table.job, table.sid, table.sidType, table.via], name: 'jenkins_job_access_pkey' }),
])

export const jenkinsAccessSync = pgTable('jenkins_access_sync', {
  server: text().primaryKey(),
  readAt: timestamp('read_at', { withTimezone: true }),
  source: text().$type<AccessState['source']>(),
  grants: integer().default(0).notNull(),
  ok: boolean().default(false).notNull(),
  error: text(),
  warnings: text().array().default(sql`'{}'`).notNull(),
})

export const buildExplanations = pgTable('build_explanations', {
  server: text().notNull(),
  job: text().notNull(),
  number: integer().notNull(),
  promptVersion: integer('prompt_version').notNull(),
  model: text().notNull(),
  explanation: jsonb().notNull(),
  trimmed: boolean().default(false).notNull(),
  promptTokens: integer('prompt_tokens').default(0).notNull(),
  durationMs: integer('duration_ms').default(0).notNull(),
  createdBy: text('created_by').notNull(),
  createdByName: text('created_by_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('build_explanations_created_idx').on(table.createdAt),
  primaryKey({ columns: [table.server, table.job, table.number, table.promptVersion, table.model], name: 'build_explanations_pkey' }),
])

export const buildExplainAttempts = pgTable('build_explain_attempts', {
  server: text().notNull(),
  job: text().notNull(),
  number: integer().notNull(),
  promptVersion: integer('prompt_version').notNull(),
  model: text().notNull(),
  attempts: integer().default(0).notNull(),
  lastError: text('last_error'),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.server, table.job, table.number, table.promptVersion, table.model], name: 'build_explain_attempts_pkey' }),
])
