import type { AccessLevel, Adjustment, Fact, PipelineFile, PipelineSpec, RequestKind, RequestStatus, RiskLevel, StepName, StepStatus } from '@eidp/contracts/requests'
import { sql } from 'drizzle-orm'
import { bigserial, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const requests = pgTable('requests', {
  id: uuid().defaultRandom().primaryKey(),
  kind: text().$type<RequestKind>().notNull(),
  status: text().$type<RequestStatus>().default('pending').notNull(),
  collection: text(),
  project: text().notNull(),
  repository: text(),
  description: text(),
  justification: text().notNull(),
  requestedBy: text('requested_by').notNull(),
  requestedByName: text('requested_by_name').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
  decidedBy: text('decided_by'),
  decidedByName: text('decided_by_name'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  resultUrl: text('result_url'),
  error: text(),
  teamGroup: text('team_group'),
  grantees: text().array(),
  accessLevel: text('access_level').$type<AccessLevel>(),
  projectKey: text('project_key'),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  pipeline: jsonb().$type<PipelineSpec>(),
  /** What deciders changed before approving, oldest first. */
  adjustments: jsonb().$type<Adjustment[]>().default([]).notNull(),
  /** create_pipeline: files of what approving writes, as a decider edited them. */
  pipelineEdits: jsonb('pipeline_edits').$type<PipelineFile[]>(),
  /** create_jira_project: who leads it, when not the requester. */
  projectLead: text('project_lead'),
  /** The requests filed together from one New project form — its Azure DevOps and its Jira project. */
  bundleId: uuid('bundle_id'),
}, (table) => [
  uniqueIndex('requests_one_open_create_idx').on(sql`kind`, sql`lower(collection)`, sql`lower(project)`, sql`lower(COALESCE(repository, ''::text))`).where(sql`((status = ANY (ARRAY['pending'::text, 'approved'::text])) AND (kind <> 'grant_access'::text))`),
  uniqueIndex('requests_one_open_jira_key_idx').on(sql`lower(project_key)`).where(sql`((status = ANY (ARRAY['pending'::text, 'approved'::text])) AND (kind = 'create_jira_project'::text))`),
  uniqueIndex('requests_one_open_jira_name_idx').on(sql`lower(project)`).where(sql`((status = ANY (ARRAY['pending'::text, 'approved'::text])) AND (kind = 'create_jira_project'::text))`),
  index('requests_requested_by_idx').on(table.requestedBy, table.requestedAt.desc().nullsFirst()),
  index('requests_status_idx').on(table.status, table.requestedAt),
  index('requests_bundle_idx').on(table.bundleId).where(sql`bundle_id IS NOT NULL`),
  check('requests_status_check', sql`status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])`),
  check('requests_repository_check', sql`((kind <> 'create_repository'::text) OR (repository IS NOT NULL)) AND ((kind <> 'create_project'::text) OR (repository IS NULL))`),
  check('requests_grant_check', sql`(kind <> 'grant_access'::text) OR ((cardinality(grantees) > 0) AND (access_level = ANY (ARRAY['read'::text, 'contribute'::text])))`),
  check('requests_kind_check', sql`kind = ANY (ARRAY['create_repository'::text, 'create_project'::text, 'grant_access'::text, 'create_jira_project'::text, 'create_pipeline'::text])`),
  check('requests_pipeline_check', sql`(kind = 'create_pipeline'::text) = (pipeline IS NOT NULL) AND ((kind <> 'create_pipeline'::text) OR (repository IS NOT NULL))`),
  check('requests_jira_check', sql`((kind = 'create_jira_project'::text) = (collection IS NULL)) AND ((kind = 'create_jira_project'::text) = (project_key IS NOT NULL))`),
])

export const requestAssessments = pgTable('request_assessments', {
  requestId: uuid('request_id').primaryKey(),
  level: text().$type<RiskLevel>().notNull(),
  facts: jsonb().$type<Fact[]>().default([]).notNull(),
  summary: text(),
  reasonConcerns: jsonb('reason_concerns').$type<string[]>().default([]).notNull(),
  model: text(),
  promptVersion: integer('prompt_version').notNull(),
  error: text(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  foreignKey({
    columns: [table.requestId],
    foreignColumns: [requests.id],
    name: 'request_assessments_request_id_fkey',
  }).onDelete('cascade'),
  check('request_assessments_level_check', sql`level = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])`),
])

/**
 * The templates approved pipelines are written from, edited by DevOps on the
 * Pipeline templates page: one row per slot — a technology's group_vars or
 * manifests for a deploy target, or the new-project files — keyed by its
 * `dir` (`DotNetCore/OCP`, `manifests/DotNetCore/OCP`, `project`).
 */
export const pipelineTemplates = pgTable('pipeline_templates', {
  dir: text().primaryKey(),
  files: jsonb().$type<PipelineFile[]>().notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedByName: text('updated_by_name').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

/** Every save and removal of a template, as it was saved: what a pipeline was written from, and who changed it. */
export const pipelineTemplateHistory = pgTable('pipeline_template_history', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  dir: text().notNull(),
  /** Null when the template was removed. */
  files: jsonb().$type<PipelineFile[]>(),
  changedBy: text('changed_by').notNull(),
  changedByName: text('changed_by_name').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index('pipeline_template_history_dir_idx').on(table.dir, table.changedAt.desc())])

/**
 * What runs in Jenkins after an approved pipeline is pushed, one row per step:
 * provisioning, then a first test build. The request is complete once the
 * push lands; a step failing after it is the step's to retry, not the
 * request's — the files are in inventories either way.
 */
export const requestSteps = pgTable('request_steps', {
  requestId: uuid('request_id').notNull(),
  step: text().$type<StepName>().notNull(),
  status: text().$type<StepStatus>().notNull(),
  job: text(),
  parameters: jsonb().$type<Record<string, string>>(),
  queueId: integer('queue_id'),
  number: integer(),
  url: text(),
  note: text(),
  attempts: integer().default(0).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.requestId, table.step] }),
  foreignKey({ columns: [table.requestId], foreignColumns: [requests.id], name: 'request_steps_request_id_fkey' }).onDelete('cascade'),
  index('request_steps_open_idx').on(table.status).where(sql`status = ANY (ARRAY['pending'::text, 'queued'::text, 'running'::text])`),
  check('request_steps_step_check', sql`step = ANY (ARRAY['provision'::text, 'test'::text])`),
  check('request_steps_status_check', sql`status = ANY (ARRAY['waiting'::text, 'pending'::text, 'queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text])`),
])
