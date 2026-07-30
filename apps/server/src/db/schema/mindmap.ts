// Drizzle: Mindmap + MindmapAssociation + PendingMindmapCard.
//
// Mindmap.nodes + links live as a single jsonb 'content' (and 'agent_seed_snapshot') —
// matches the Hub iOS single-doc model (TEACHING-SPEC §3.4).

import { sql } from 'drizzle-orm';
import { pgTable, text, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { learner_agent_pairs } from './pair';
import type {
  MindmapScope,
  MindmapContent,
  MindmapAssociationTargetType,
  PendingCardSourceType,
} from '@learn-shell/contracts';

export const mindmaps = pgTable('mindmaps', {
  id: text('id').primaryKey(),
  owner_pair_id: text('owner_pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  scope: text('scope').$type<MindmapScope>().notNull(),
  title: text('title').notNull(),
  folder: text('folder'),
  source: text('source').notNull().default('user'),
  agent_skill_used: text('agent_skill_used'),
  agent_seed_snapshot: jsonb('agent_seed_snapshot').$type<MindmapContent>().notNull(),
  content: jsonb('content').$type<MindmapContent>().notNull(),
  has_been_reset: boolean('has_been_reset').notNull().default(false),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const mindmap_associations = pgTable('mindmap_associations', {
  id: text('id').primaryKey(),
  mindmap_id: text('mindmap_id')
    .notNull()
    .references(() => mindmaps.id, { onDelete: 'cascade' }),
  target_type: text('target_type').$type<MindmapAssociationTargetType>().notNull(),
  target_id: text('target_id').notNull(),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const pending_mindmap_cards = pgTable('pending_mindmap_cards', {
  id: text('id').primaryKey(),
  owner_pair_id: text('owner_pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  content: text('content').notNull(),
  source_type: text('source_type').$type<PendingCardSourceType>().notNull(),
  source_id: text('source_id'),
  source_title: text('source_title'),
  placed_in_mindmap_id: text('placed_in_mindmap_id'),
  reason: text('reason'),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type MindmapRow = typeof mindmaps.$inferSelect;
export type MindmapAssociationRow = typeof mindmap_associations.$inferSelect;
export type PendingMindmapCardRow = typeof pending_mindmap_cards.$inferSelect;
