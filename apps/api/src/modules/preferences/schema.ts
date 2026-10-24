import type { Appearance, OverviewLayout } from '@eidp/contracts/preferences'
import { jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * What each person keeps about how the portal looks to them, by name: one row
 * per person and preference. Their own to read and write; nobody else's.
 */
export const userPreferences = pgTable(
  'user_preferences',
  {
    /** Lower-cased, as the directory's uid is matched everywhere else. */
    uid: text().notNull(),
    name: text().notNull(),
    /** By name: `overview` holds an OverviewLayout, `appearance` an Appearance. */
    value: jsonb().$type<OverviewLayout | Appearance>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.uid, table.name] })],
)
