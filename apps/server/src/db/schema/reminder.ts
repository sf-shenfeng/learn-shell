// Drizzle: Reminder (4 channel · TEACHING-SPEC §3.7 + §5).

import { sql } from 'drizzle-orm';
import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { learner_agent_pairs } from './pair';
import type { ReminderType, ReminderChannel } from '@learn-shell/contracts';

export const reminders = pgTable('reminders', {
  id: text('id').primaryKey(),
  pair_id: text('pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  type: text('type').$type<ReminderType>().notNull(),
  scheduled_for: timestamp('scheduled_for', { withTimezone: true }).notNull(),
  channel: text('channel').$type<ReminderChannel>().notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  fired_at: timestamp('fired_at', { withTimezone: true }),
  dismissed_at: timestamp('dismissed_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type ReminderRow = typeof reminders.$inferSelect;
