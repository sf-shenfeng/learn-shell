// Drizzle: Annotation — 划注 (batch A).
//
// Highlight + note are one entity, not two: `note` null = pure highlight,
// non-null = note. Anchor is a text-quote {selected_text, prefix, suffix} +
// page_index (page
// boundary is the first-level composite anchor, no block index needed).
//
// 金缮条款: lesson revisions can make an anchor fail to resolve — that's an
// orphan, not a delete. This table never drops a row on resolve failure;
// resolution happens client-side against the current DOM (see
// apps/web/src/annotation/anchor.ts), so there is nothing to reconcile here.
//
// Batch A ships single color ('amber' default, matches contracts'
// AnnotationColorKey = string placeholder); batch B tightens it to a union
// once it's wired to the Mindmap palette (packages/contracts/src/annotation.ts).
//
// Batch D (Journal 孤儿区): adds
// `orphaned_at`. Still the 金缮条款 — a failed re-anchor is a *status*, never
// a delete. The column is nullable and re-evaluated on every sweep (see
// apps/server/src/lib/annotation-sweep.ts): null when the anchor currently
// resolves against the lesson's current content, a timestamp the moment a
// sweep last found it unresolvable. Not a one-way ratchet — a later revision
// that restores the quoted text un-orphans it back to null.
//
// Batch E (自由笔记, 批E): `lesson_id`
// dropped its NOT NULL — a free note (added from the Journal panel's own
// "+ 笔记" entry, not captured off a lesson selection) has no lesson to
// anchor to, so the row carries lesson_id = null, page_index = 0, and empty
// selected_text/prefix/suffix. It never needs a sweep (no anchor to
// re-resolve) — annotation-sweep.ts's pair-wide sweep excludes lesson_id IS
// NULL rows up front, they simply never orphan.
//
// 批G (批注宿主泛化): adds `document_id`,
// nullable, exclusive with `lesson_id` — a row anchors to at most one host.
// Three legal shapes now: lesson-anchored (lesson_id set, document_id null,
// unchanged from batch A/D), document-anchored (document_id set, lesson_id
// null, page_index always 0 — documents are continuous-scroll, brief §4, no
// paging concept to anchor a page_index against), free note (both null, 批E
// semantics unchanged). The CHECK below is the actual gate — enforced at the
// DB layer, not just convention — so a bug can't silently write a row
// claiming both hosts at once. Document-hosted rows get the same 金缮条款:
// a re-swept anchor that fails to resolve orphans (orphaned_at ticks), never
// deletes (../lib/annotation-sweep.ts's sweepDocumentAnnotations).
//
// 第三种作用域: adds `live_session_id`, nullable, joining
// lesson_id/document_id in the same host-exclusivity gate — a row anchors to
// at most one of the three (or none, 自由笔记). live-session-hosted rows
// anchor to a MoveStream move by page_index = that move's seq (moves are the
// paging unit here, same "page_index means whatever this host pages by"
// convention documents/lessons already use). No FK to live_sessions — 与
// 0024/0025 同风格, 不追加硬约束; 服从现实条款: brief 原文写"三者恰好一个非空",
// 但库里已有批E自由笔记合法持有三者全 null, 这里延续既有语义收紧为"至多一个
// 非空"而不是"恰好一个"——新列不破坏自由笔记那一类。live 记录是只读回放,
// 理论上永不 orphan: annotation-sweep.ts 的 lesson/document 两条 sweep 分支
// 各自按 lesson_id IS NOT NULL / document_id IS NOT NULL 筛选, 三者全 null 或
// 仅 live_session_id 非空的行天然落在两个筛选之外, 不需要为它另开分支或额外
// 排除逻辑 (验证过, 未改 lib/annotation-sweep.ts).

import { sql } from 'drizzle-orm';
import { pgTable, text, integer, timestamp, check } from 'drizzle-orm/pg-core';
import { learner_agent_pairs } from './pair';
import { lessons } from './content';
import { documents } from './document';

export const lesson_annotations = pgTable(
  'lesson_annotations',
  {
    id: text('id').primaryKey(),
    pair_id: text('pair_id')
      .notNull()
      .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
    /** null = 自由笔记 (批E) or document-anchored (批G) — not anchored to any lesson. */
    lesson_id: text('lesson_id').references(() => lessons.id, { onDelete: 'cascade' }),
    /** 批G: null = anchored to a lesson (or a free note) instead. Mutually
     *  exclusive with lesson_id — see the check constraint below. */
    document_id: text('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    /** 第三种作用域: null = anchored to a lesson/document (or a free note)
     *  instead. Mutually exclusive with lesson_id/document_id — see the check
     *  constraint below. No FK to live_sessions (不加外键强约束, 与
     *  0024/0025 同风格). */
    live_session_id: text('live_session_id'),
    /** Page index of the paged lesson (0-based) the anchor was captured on.
     *  Document-hosted rows always carry 0 (documents don't page, brief §4).
     *  Live-session-hosted rows carry the anchoring move's seq (约定
     *  page_index = 该 move 的 seq). */
    page_index: integer('page_index').notNull(),
    /** Text-quote anchor: the exact substring the learner selected. */
    selected_text: text('selected_text').notNull(),
    /** Anchor context — fixed-length text before the selection, for disambiguation. */
    prefix: text('prefix').notNull().default(''),
    /** Anchor context — fixed-length text after the selection, for disambiguation. */
    suffix: text('suffix').notNull().default(''),
    color: text('color').notNull().default('amber'),
    /** null = pure highlight; non-null = a note attached to the same highlight. */
    note: text('note'),
    /** null = resolves fine; timestamp = orphaned as of the last sweep (batch D). */
    orphaned_at: timestamp('orphaned_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    // 批G + 第三种作用域: at most one of lesson_id/document_id/live_session_id
    // can be set — a row anchors to at most one host (all three null = 自由笔记,
    // 批E semantics unchanged). "至多一个" not "恰好一个" — 服从现实条款, see
    // file header note on the live_session_id column.
    hostExclusive: check(
      'lesson_annotations_host_exclusive',
      sql`(
        (CASE WHEN ${table.lesson_id} IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${table.document_id} IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${table.live_session_id} IS NOT NULL THEN 1 ELSE 0 END)
      ) <= 1`
    ),
  })
);

export type LessonAnnotationRow = typeof lesson_annotations.$inferSelect;
