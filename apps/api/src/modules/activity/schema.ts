import { sql } from 'drizzle-orm'
import { bigserial, check, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

export const activityEvents = pgTable('activity_events', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  uid: text().notNull(),
  name: text().notNull(),
  kind: text().notNull(),
  path: text(),
  section: text(),
  reason: text(),
}, (table) => [
  index('activity_events_at_idx').on(table.at),
  index('activity_events_uid_at_idx').on(sql`lower(uid)`, sql`at`),
  check('activity_events_kind_check', sql`kind = ANY (ARRAY['sign_in'::text, 'sign_in_failed'::text, 'visit'::text, 'chat'::text])`),
])
