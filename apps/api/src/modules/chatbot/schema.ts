import type { Feedback } from '@eidp/contracts/chatbot'
import { sql } from 'drizzle-orm'
import { bigserial, boolean, check, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const assistantConversations = pgTable('assistant_conversations', {
  id: uuid().defaultRandom().primaryKey(),
  uid: text().notNull(),
  title: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  titled: boolean().default(false).notNull(),
}, (table) => [
  index('assistant_conversations_uid_idx').on(table.uid, table.updatedAt.desc().nullsFirst()),
])

export const assistantMessages = pgTable('assistant_messages', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  conversationId: uuid('conversation_id').notNull(),
  role: text().$type<'user' | 'assistant'>().notNull(),
  content: text().notNull(),
  steps: jsonb().$type<string[]>().default([]).notNull(),
  model: text(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  feedback: text().$type<Feedback>(),
}, (table) => [
  index('assistant_messages_conversation_idx').on(table.conversationId, table.id),
  foreignKey({
    columns: [table.conversationId],
    foreignColumns: [assistantConversations.id],
    name: 'assistant_messages_conversation_id_fkey',
  }).onDelete('cascade'),
  check('assistant_messages_role_check', sql`role = ANY (ARRAY['user'::text, 'assistant'::text])`),
  check('assistant_messages_feedback_check', sql`feedback = ANY (ARRAY['up'::text, 'down'::text])`),
])
