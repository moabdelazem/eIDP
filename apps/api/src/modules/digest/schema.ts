import type { DigestFacts } from '@eidp/contracts/digest'
import { date, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

export const weeklyDigests = pgTable('weekly_digests', {
  team: text().notNull(),
  weekStart: date('week_start').notNull(),
  facts: jsonb().$type<DigestFacts>().notNull(),
  summary: text(),
  highlights: jsonb().$type<string[]>().default([]).notNull(),
  model: text(),
  promptVersion: integer('prompt_version').notNull(),
  error: text(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.team, table.weekStart], name: 'weekly_digests_pkey' }),
])
