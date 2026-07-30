// Drizzle: LearningSession + typed SessionEvent stream.
//
// Events use a single events table with jsonb payload + event_type discriminator;
// the typed discriminated union is enforced on the TS side, not at SQL.

import { sql } from 'drizzle-orm';
import { pgTable, text, integer, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { learner_agent_pairs } from './pair';
import type {
  SessionEventType,
  LearningSessionMode,
  PermissionState,
  ActorType,
  SourceRef,
} from '@learn-shell/contracts';

export const learning_sessions = pgTable('learning_sessions', {
  id: text('id').primaryKey(),
  pair_id: text('pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  started_at: timestamp('started_at', { withTimezone: true }).notNull(),
  ended_at: timestamp('ended_at', { withTimezone: true }),
  course_refs: jsonb('course_refs').$type<string[]>().notNull().default([]),
  concepts_touched: jsonb('concepts_touched').$type<string[]>().notNull().default([]),
  cards_reviewed: jsonb('cards_reviewed').$type<string[]>().notNull().default([]),
  event_count: integer('event_count').notNull().default(0),
  agent_summary: text('agent_summary'),
  teacher_reflection_id: text('teacher_reflection_id'),
  next_actions: jsonb('next_actions').$type<string[]>().notNull().default([]),
  // round 2
  mode: text('mode').$type<LearningSessionMode>(),
  skill_used: text('skill_used'),
});

export const session_events = pgTable('session_events', {
  event_id: text('event_id').primaryKey(),
  pair_id: text('pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  session_id: text('session_id')
    .notNull()
    .references(() => learning_sessions.id, { onDelete: 'cascade' }),
  event_type: text('event_type').$type<SessionEventType>().notNull(),
  actor_type: text('actor_type').$type<ActorType>().notNull(),
  actor_id: text('actor_id').notNull(),
  recorded_by: text('recorded_by').notNull(),
  occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  source_refs: jsonb('source_refs').$type<SourceRef[]>().notNull().default([]),
  permission_state: text('permission_state').$type<PermissionState>().notNull(),
  payload: jsonb('payload').notNull(),
});

export type LearningSessionRow = typeof learning_sessions.$inferSelect;
export type SessionEventRow = typeof session_events.$inferSelect;
