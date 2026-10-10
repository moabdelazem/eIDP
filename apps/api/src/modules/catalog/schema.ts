import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

export const catalogSystems = pgTable('catalog_systems', {
  dir: text().primaryKey(),
  projectName: text('project_name').notNull(),
  company: text(),
  teams: jsonb().$type<Record<string, string>>().default({}).notNull(),
  approvers: text().array().default(sql`'{}'`).notNull(),
  managers: text().array().default(sql`'{}'`).notNull(),
  opsTeams: text('ops_teams').array().default(sql`'{}'`).notNull(),
  policy: jsonb().$type<unknown>().default({}).notNull(),
})

export const catalogApplications = pgTable('catalog_applications', {
  id: text().primaryKey(),
  systemDir: text('system_dir').notNull(),
  groupName: text('group_name').notNull(),
  name: text().notNull(),
  environment: text(),
  repository: text(),
  buildTechnology: text('build_technology'),
  deployTechnology: text('deploy_technology'),
  deployPlatform: text('deploy_platform'),
  appType: text('app_type'),
  microservice: boolean(),
  technologies: text().array().default(sql`'{}'`).notNull(),
  descriptor: jsonb().$type<Record<string, unknown>>().default({}).notNull(),
}, (table) => [
  index('catalog_applications_name_idx').on(table.name),
  index('catalog_applications_system_idx').on(table.systemDir),
  foreignKey({
    columns: [table.systemDir],
    foreignColumns: [catalogSystems.dir],
    name: 'catalog_applications_system_dir_fkey',
  }).onDelete('cascade'),
])

export const catalogSync = pgTable('catalog_sync', {
  id: integer().default(1).primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  commitSha: text('commit_sha'),
  ok: boolean().default(false).notNull(),
  error: text(),
  warnings: jsonb().$type<string[]>().default([]).notNull(),
}, (table) => [
  check('catalog_sync_is_singleton', sql`id = 1`),
])
