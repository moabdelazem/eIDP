import type { AccessLevel, Fact, RequestKind, RequestStatus, RiskLevel } from '@eidp/contracts/requests'
import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

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
}, (table) => [
  uniqueIndex('requests_one_open_create_idx').on(sql`kind`, sql`lower(collection)`, sql`lower(project)`, sql`lower(COALESCE(repository, ''::text))`).where(sql`((status = ANY (ARRAY['pending'::text, 'approved'::text])) AND (kind <> 'grant_access'::text))`),
  uniqueIndex('requests_one_open_jira_key_idx').on(sql`lower(project_key)`).where(sql`((status = ANY (ARRAY['pending'::text, 'approved'::text])) AND (kind = 'create_jira_project'::text))`),
  uniqueIndex('requests_one_open_jira_name_idx').on(sql`lower(project)`).where(sql`((status = ANY (ARRAY['pending'::text, 'approved'::text])) AND (kind = 'create_jira_project'::text))`),
  index('requests_requested_by_idx').on(table.requestedBy, table.requestedAt.desc().nullsFirst()),
  index('requests_status_idx').on(table.status, table.requestedAt),
  check('requests_status_check', sql`status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])`),
  check('requests_repository_check', sql`((kind <> 'create_repository'::text) OR (repository IS NOT NULL)) AND ((kind <> 'create_project'::text) OR (repository IS NULL))`),
  check('requests_grant_check', sql`(kind <> 'grant_access'::text) OR ((cardinality(grantees) > 0) AND (access_level = ANY (ARRAY['read'::text, 'contribute'::text])))`),
  check('requests_kind_check', sql`kind = ANY (ARRAY['create_repository'::text, 'create_project'::text, 'grant_access'::text, 'create_jira_project'::text])`),
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
