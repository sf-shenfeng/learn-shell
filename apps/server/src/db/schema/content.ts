// Drizzle: Course / Lesson / Concept / Flashcard (FSRS state inline).

import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  doublePrecision,
  boolean,
  check,
} from 'drizzle-orm/pg-core';
import { learner_agent_pairs } from './pair';
import type { SourceRef, FSRSState, LessonRevisionKind } from '@learn-shell/contracts';

export const courses = pgTable('courses', {
  id: text('id').primaryKey(),
  pair_id: text('pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  topic: text('topic').notNull(),
  description: text('description').notNull().default(''),
  structure: jsonb('structure').$type<{ lesson_ids: string[] }>().notNull(),
  generated_by_agent_id: text('generated_by_agent_id'),
  generated_from: jsonb('generated_from').$type<SourceRef[]>().notNull().default([]),
  syllabus_version: text('syllabus_version'),
  // 迁移 0030: review_status 拆除 — 侦察实证无任何真实读点(仅 seed.ts 写死
  // 一个演示值)。
  // 迁移 0032: 计划节数 (学习者钦定设计) — 建课时被问的第一问"一共几节"。
  // null = 未定(旧课兼容口径, 见 lib/course-completion.ts); 非空时是
  // goal_completion_ready 判定(context-brief.ts buildContractProgressLines /
  // mcp/server.ts complete_contract 前置校验③, 两处同源共用
  // evaluateCourseCompletion)的一道门槛: 已发布节数须 ≥ 这个数。null 时
  // goal_completion_ready 恒 false (2026-07-20, ready_to_complete 拆分批)。
  planned_lesson_count: integer('planned_lesson_count'),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const lessons = pgTable('lessons', {
  id: text('id').primaryKey(),
  course_id: text('course_id')
    .notNull()
    .references(() => courses.id, { onDelete: 'cascade' }),
  order: integer('order').notNull(),
  title: text('title').notNull(),
  // Stage 6b: optional — `proposed` lessons have no content yet.
  content_markdown: text('content_markdown'),
  // Stage 6b: one-sentence summary, populated at outline time.
  summary: text('summary'),
  // 迁移 0030: status/needs_review 拆除 — 侦察实证两列均无有效写点/读点
  // (status 75 行全 null, 从未被真实写路径写过, 且与 lesson_progress.state
  // 撞名, 是病根本身; needs_review 未接线, 验尺红黄绿判定现算于
  // validate-prep-core.ts, 从不回写这一列)。
  concept_ids: jsonb('concept_ids').$type<string[]>().notNull().default([]),
  source_refs: jsonb('source_refs').$type<SourceRef[]>().notNull().default([]),
  estimated_minutes: integer('estimated_minutes').notNull().default(15),
  skill_used: text('skill_used'),
  // update_lesson: revision pass 回写. Bumped on every update_lesson
  // call; the replaced version's full content is snapshotted into
  // lesson_revisions before the patch is applied.
  revision: integer('revision').notNull().default(1),
  // Publish Gate (迁移 0022): 上架闸。null = 草稿态(add_lesson 默认,
  // 仅教师/MCP 侧可见); 非空 = 已发布(publish_lesson 跑完验尺 PASS/PASS_WITH_
  // WARNINGS 才写)。学习者读端点(routes/read.ts)按此列过滤——红灯课永不出现在
  // 学习者书架。迁移把现存全部 lessons 回填为已发布(52 节在架课无缝)。
  published_at: timestamp('published_at', { withTimezone: true }),
  // 脑图裁量条款子项 (迁移 0024): 脑图缺席要留言。脑图仍是可选教具(见
  // checkMindmap)——但不配脑图时, 老师须在这里留一句教学法理由(如
  // {mindmap: "背诵类内容, 关系不是难点"})。验尺 checkMindmap 读这个字段的
  // mindmap 键: 有它 → pass(声明式跳过); 没它且未关联脑图 → warn(黄灯, 沉默
  // 的缺席)。可空——只有真正跳过脑图的课才写。
  modality_declarations: jsonb('modality_declarations').$type<Record<string, string>>(),
});

// update_lesson: one row per revision, holding the version that got
// replaced. `agent_seed_snapshot` 之于脑图 = `lesson_revisions` 之于课文 —
// evidence-visible, never silent.
//
// 迁移 0033: 加 kind 列 (双轨修订 —— 学习者只该看见"因她的学习而改"的修订;
// 工程性修订入库留痕但对学习者隐身)。'teaching' | 'technical', 缺省
// 'teaching' —— 发布后的修订默认面向学习者, 宁可多呈现不可偷藏; 判据见
// mcp/server.ts update_lesson 的 revision_kind 参数说明。CHECK 收口同
// lesson_patches.kind 的先例(progress.ts kindCheck)。回填规则: 备课期
// (首次发布前) 的修订学习者从未见过旧版, 天然后厨事务, 一律判 technical
// (近似规则, 详见 drizzle/0033_revision_kind.sql 头注)。展示层("已修订
// vN"/"修订未读")读 lesson-state.ts 现算的 teaching_revision, 不直接读
// lessons.revision(那是全轨自增, 事实层不动)。
export const lesson_revisions = pgTable(
  'lesson_revisions',
  {
    id: text('id').primaryKey(),
    lesson_id: text('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(), // the version number being replaced
    prev_content_markdown: text('prev_content_markdown'),
    prev_title: text('prev_title').notNull(),
    reason: text('reason').notNull(),
    evidence: text('evidence'),
    revised_by: text('revised_by').notNull(),
    revised_at: timestamp('revised_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    kind: text('kind').$type<LessonRevisionKind>().notNull().default('teaching'),
  },
  (table) => ({
    kindCheck: check('lesson_revisions_kind_check', sql`${table.kind} IN ('teaching', 'technical')`),
  })
);

export const concepts = pgTable('concepts', {
  id: text('id').primaryKey(),
  lesson_id: text('lesson_id')
    .notNull()
    .references(() => lessons.id, { onDelete: 'cascade' }),
  course_id: text('course_id')
    .notNull()
    .references(() => courses.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  short_definition: text('short_definition').notNull().default(''),
  source_refs: jsonb('source_refs').$type<SourceRef[]>().notNull().default([]),
  flashcard_ids: jsonb('flashcard_ids').$type<string[]>().notNull().default([]),
});

export const flashcards = pgTable('flashcards', {
  id: text('id').primaryKey(),
  pair_id: text('pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  concept_id: text('concept_id'),
  deck_id: text('deck_id').notNull(),
  front: text('front').notNull(),
  back: text('back').notNull(),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  source_refs: jsonb('source_refs').$type<SourceRef[]>().notNull().default([]),
  fsrs_state: jsonb('fsrs_state').$type<FSRSState>().notNull(),
  // Stage 7e-cards (2026-07-01): user can pause a card — skipped by the
  // review queue but stays in the deck for management. Column was missing
  // from the DB (contracts.Flashcard.paused already existed) — added here
  // as part of the Cards page Suspend wiring (batch 9 / worker E).
  paused: boolean('paused').notNull().default(false),
  // 闪卡激活门 (迁移 0045, 2026-09-02) — 复习队列"全量涌入"的病根修复。
  // newCardState() 让每张新卡 due=now, 而 due 查询只看 pair_id + !paused +
  // due_at<=now, 零课时维度 —— 一门课刚建完卡, 整门课(含没上过的课)的卡就
  // 全部堵在复习队列门口。activated 是那道缺失的课时闸: 挂了 concept 的
  // 课程卡出生即休眠 (false), 学完那一课才被 lib/flashcard-activation.ts
  // 唤醒; 挂不上课的卡 (concept_id 为空的导入卡/手写卡) 由学习者在 Cards
  // 管理页显式加入复习。activated 只缓存独立卡选择；课程卡资格由读端派生。
  //
  // DDL 默认 true 是刻意的: 老库加这一列不许把已有的卡一夜清零。这条
  // 非破坏性迁移原则来自同类生产事故。"课程卡默认休眠"这条规则住应用层
  // (lib/flashcard-activation.ts 的 defaultActivatedForConcept), 不住 DDL,
  // 也不在迁移里回填 —— 存量卡的归属由 scripts/backfill-flashcard-
  // activation.ts 显式跑, 有 dry-run 有人核数, 不靠迁移偷偷改。
  activated: boolean('activated').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// Convenience exports for typed selects
export type CourseRow = typeof courses.$inferSelect;
export type LessonRow = typeof lessons.$inferSelect;
export type ConceptRow = typeof concepts.$inferSelect;
export type FlashcardRow = typeof flashcards.$inferSelect;
export type LessonRevisionRow = typeof lesson_revisions.$inferSelect;

// Silence unused-import warning for doublePrecision (kept for future use)
void doublePrecision;
