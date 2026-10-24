import type { MailStatus } from '@eidp/contracts/notifications'
import { sql } from 'drizzle-orm'
import { bigserial, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Mail the portal sends, as an outbox: written in the same moment as what it
 * is about, sent by the `mail-outbox` job, retried with backoff, and kept —
 * sent or failed — so it can be read back and sent again. One row per
 * message, never per recipient.
 */
export const mailOutbox = pgTable('mail_outbox', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  /** What it is about, like `request.rejected`. */
  topic: text().notNull(),
  /** What it belongs to, like `request:<id>`: how it is found again. */
  ref: text(),
  to: text('to_addresses').array().notNull(),
  cc: text('cc_addresses').array().default(sql`'{}'`).notNull(),
  subject: text().notNull(),
  textBody: text('text_body').notNull(),
  htmlBody: text('html_body').notNull(),
  status: text().$type<MailStatus>().default('pending').notNull(),
  attempts: integer().default(0).notNull(),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
  /** When a sender took it; a `sending` row this old belongs to a process that died. */
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  lastError: text('last_error'),
  messageId: text('message_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
}, (table) => [
  index('mail_outbox_due_idx').on(table.nextAttemptAt).where(sql`status = 'pending'`),
  index('mail_outbox_ref_idx').on(table.ref),
  check('mail_outbox_status_check', sql`status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text])`),
])
