import type { AuditEntry, Binding, ScopeType, SubjectType } from '@eidp/contracts/rbac'
import { sql } from 'drizzle-orm'
import { bigserial, check, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const rbacBindings = pgTable('rbac_bindings', {
  id: uuid().defaultRandom().primaryKey(),
  subjectType: text('subject_type').$type<SubjectType>().notNull(),
  subject: text().notNull(),
  role: text().notNull(),
  scopeType: text('scope_type').$type<ScopeType>().default('global').notNull(),
  scope: text(),
  reason: text(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('rbac_bindings_unique_idx').on(sql`subject_type`, sql`lower(subject)`, sql`role`, sql`scope_type`, sql`lower(COALESCE(scope, ''::text))`),
  check('rbac_bindings_subject_type_check', sql`subject_type = ANY (ARRAY['group'::text, 'user'::text])`),
  check('rbac_bindings_scope_type_check', sql`scope_type = ANY (ARRAY['global'::text, 'team'::text, 'project'::text])`),
  check('rbac_bindings_check', sql`(scope_type = 'global'::text) = (scope IS NULL)`),
])

export const rbacAudit = pgTable('rbac_audit', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  actor: text().notNull(),
  action: text().$type<AuditEntry['action']>().notNull(),
  binding: jsonb().$type<Binding>(),
  target: text(),
  previous: jsonb().$type<Binding>(),
}, (table) => [
  check('rbac_audit_action_check', sql`action = ANY (ARRAY['grant'::text, 'revoke'::text, 'assume'::text, 'update'::text])`),
])
