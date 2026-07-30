// Drizzle: Syllabus Registry — 考纲登记簿.
//
// "离考试日越来越近时，考纲的哪个角落没人管必须是一个可查询的事实，而不是一
// 种焦虑" (brief §0). Two tables, no stored scores — coverage/decay are always
// runtime-derived (../lib/syllabus-coverage.ts), never written back here.
//
// syllabus_nodes: 考纲树 (self-referencing parent_id, NULL = 顶层科目).
// `syllabus_version` lets a full tree be superseded by a new one (教纲换版)
// while the old tree stays queryable read-only — same row shape, different
// version string, no migration needed to "start a new tree".
//
// syllabus_mappings: 多对多 考点 ↔ 学习资产. `asset_type` is deliberately a
// plain text + $type union (not a pg enum) — matches this codebase's existing
// precedent for polymorphic asset references (mindmap_associations.target_type
// in ./mindmap.ts, documents.source in ./document.ts): asset ids come from five
// different tables with no single foreign key that could span them, so
// `asset_id` is an unconstrained text column, same shape as
// mindmap_associations.target_id.

import { sql } from 'drizzle-orm';
import { pgTable, text, integer, doublePrecision, timestamp, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { learner_agent_pairs } from './pair';

/** brief §1: enum收敛 to the five asset entities that currently have a
 *  stable, addressable primary key. `mindmap_node` is the one soft spot —
 *  mindmap nodes aren't rows, they're elements inside `mindmaps.content`
 *  (jsonb), so `asset_id` for that type is a node id *within* that jsonb
 *  array, not a table PK. Included anyway per brief's literal enum list;
 *  flagged in the delivery report as the one asset_type whose "primary key"
 *  is informal. */
export type SyllabusAssetType = 'lesson' | 'flashcard' | 'quiz_question' | 'document' | 'mindmap_node';

/** mapped_by — 'agent' | 'user', same two-value convention as
 *  mindmaps.source (./mindmap.ts) and ad_hoc_messages role (./adhoc.ts). */
export type SyllabusMappedBy = 'agent' | 'user';

export const syllabus_nodes = pgTable('syllabus_nodes', {
  id: text('id').primaryKey(),
  pair_id: text('pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  /** NULL = 顶层科目. Self-referencing FK; cascades so deleting a parent
   *  takes its subtree with it (mirrors lessons→lesson_revisions cascade
   *  shape elsewhere in this schema dir). */
  parent_id: text('parent_id').references((): AnyPgColumn => syllabus_nodes.id, {
    onDelete: 'cascade',
  }),
  /** User/agent-defined code, e.g. "FRA-LOS-27a". Not unique at the DB layer —
   *  a code could legitimately repeat across syllabus_version "生成" (old
   *  version stays read-only, new version can reuse the same code strings). */
  code: text('code').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  /** e.g. "CFA-L1-2027" — whole trees coexist keyed by this string; brief §1. */
  syllabus_version: text('syllabus_version').notNull(),
  /** Nullable — brief §2 "无 exam_weight 时等权" (rollup treats null as weight 1). */
  exam_weight: doublePrecision('exam_weight'),
  sort_order: integer('sort_order').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export const syllabus_mappings = pgTable('syllabus_mappings', {
  id: text('id').primaryKey(),
  pair_id: text('pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  node_id: text('node_id')
    .notNull()
    .references(() => syllabus_nodes.id, { onDelete: 'cascade' }),
  /** No FK — polymorphic across 5 tables, see SyllabusAssetType doc comment above. */
  asset_type: text('asset_type').$type<SyllabusAssetType>().notNull(),
  asset_id: text('asset_id').notNull(),
  mapped_by: text('mapped_by').$type<SyllabusMappedBy>().notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export type SyllabusNodeRow = typeof syllabus_nodes.$inferSelect;
export type SyllabusMappingRow = typeof syllabus_mappings.$inferSelect;
