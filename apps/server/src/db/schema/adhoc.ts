// Drizzle: AdHoc Thread tables (Stage 7d-fix, 2026-06-30).
//
// Singleton-per-pair long-living thread + message log. See contracts/adhoc.ts.

import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core';
import { learner_agent_pairs } from './pair';
import type {
  AdHocContextSnapshot,
  AdHocPayload,
} from '@learn-shell/contracts';

export const ad_hoc_threads = pgTable('ad_hoc_threads', {
  id: text('id').primaryKey(),
  pair_id: text('pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  message_count: integer('message_count').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  last_activity_at: timestamp('last_activity_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  /** Set when the learner archives the thread from the panel's manage menu
   *  (privacy cleanup). Null = active. Archived threads are
   *  excluded from the by-pair lookup so the next message starts a fresh
   *  thread; existing messages remain readable by id. */
  archived_at: timestamp('archived_at', { withTimezone: true }),
  /** 消账游标 (AdHoc 三票并一之二, 2026-07-19). Set via MCP tool `adhoc_ack`
   *  when the learner says "不用回了" or the agent judges a message needs no
   *  reply — the thread drops out of pending/bridge-event scans for any
   *  message at or before this id, but the message itself is never deleted.
   *  Null = never acked (default for new threads and pre-migration rows;
   *  behaves identically to "everything outstanding"). No FK — same
   *  cross-prefix genId() id-as-cursor style as bridge_delivery_cursors /
   *  live-wait.ts event ids; deliberately allowed to point at a
   *  since-hard-deleted message (DELETE /messages/:id) without
   *  erroring, since "cursor is past every remaining message" still holds. */
  acked_message_id: text('acked_message_id'),
});

export const ad_hoc_messages = pgTable('ad_hoc_messages', {
  id: text('id').primaryKey(),
  thread_id: text('thread_id')
    .notNull()
    .references(() => ad_hoc_threads.id, { onDelete: 'cascade' }),
  /** 'user' | 'agent' */
  role: text('role').notNull(),
  content: text('content').notNull().default(''),
  payload: jsonb('payload').$type<AdHocPayload>(),
  context_snapshot: jsonb('context_snapshot').$type<AdHocContextSnapshot>().notNull(),
  is_learning_related: boolean('is_learning_related').notNull().default(false),
  /** Client-supplied uuid for idempotency. */
  client_message_id: text('client_message_id').notNull().unique(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export type AdHocThreadRow = typeof ad_hoc_threads.$inferSelect;
export type AdHocMessageRow = typeof ad_hoc_messages.$inferSelect;
