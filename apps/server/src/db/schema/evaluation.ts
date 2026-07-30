// Drizzle: PostLessonEvaluation (TEACHING-SPEC §4.2) + LiveSessionEvaluation
// (评估拆分, 迁移 0030) — 一场 live session 一份现场评估,
// 一节课一份总评, 两层分开写、分开读, 不互相摊平。

import { sql } from 'drizzle-orm';
import { pgTable, text, integer, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { learner_agent_pairs } from './pair';
import { lessons } from './content';
import { learning_sessions } from './session';
import { live_sessions } from './teaching';

export const post_lesson_evaluations = pgTable(
  'post_lesson_evaluations',
  {
    id: text('id').primaryKey(),
    pair_id: text('pair_id')
      .notNull()
      .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
    lesson_id: text('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    // 迁移 0030: session_id → learning_session_id — 名实相符, FK 本就指
    // learning_sessions, 只是列名沿用了泛化的 "session_id"；评估拆成两层
    // (live 现场 / 课级总评)之后容易和 live_session_id 混淆, 借这次迁移
    // 改准。FK 约束本身不动(仍是旧名字的约束, 只是引用的列改了名)。
    learning_session_id: text('learning_session_id').references(() => learning_sessions.id, {
      onDelete: 'set null',
    }),
    concepts_touched: jsonb('concepts_touched').$type<string[]>().notNull().default([]),
    flashcards_reviewed_count: integer('flashcards_reviewed_count').notNull().default(0),
    flashcards_rating_distribution: jsonb('flashcards_rating_distribution')
      .$type<Record<'Again' | 'Hard' | 'Good' | 'Easy', number>>()
      .notNull(),
    exercises_submitted_count: integer('exercises_submitted_count').notNull().default(0),
    live_turns_count: integer('live_turns_count').notNull().default(0),
    duration_minutes: integer('duration_minutes').notNull().default(0),
    // 三通道制 (迁移 0044): 一次判决三种呈现——
    //   agent_observation = 教师内账 (锋利, 内部 id 引用可入);
    //   learner_note      = 学习者可见人话 (语言随 learners.locale, 不漏机器词);
    //   evidence_refs     = 机器引用数组 (id 必须真实存在且属本 pair,
    //                       写入口校验见 lib/evidence-refs.ts)。
    // 后两列可空——存量行与未分层的写入是"没写", 不是空字符串。
    agent_observation: text('agent_observation').notNull().default(''),
    learner_note: text('learner_note'),
    evidence_refs: jsonb('evidence_refs').$type<string[]>(),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    // 迁移 0030: 一课一总评。
    pairLessonUnique: uniqueIndex('post_lesson_evaluations_pair_lesson_uniq').on(
      t.pair_id,
      t.lesson_id
    ),
  })
);

// 迁移 0030: 现场评估, 挂在单场 live_session 上 —— 一课可能
// 横跨多场 live session, 每场各自的现场观察不该被课级总评摊平掉。pair_id
// 冗余存一份(便于按 pair 直接查, 不必每次 join live_sessions), 但按规格不建
// FK — 真正的引用完整性锚点是 live_session_id。
export const live_session_evaluations = pgTable(
  'live_session_evaluations',
  {
    id: text('id').primaryKey(),
    pair_id: text('pair_id').notNull(),
    live_session_id: text('live_session_id')
      .notNull()
      .references(() => live_sessions.id, { onDelete: 'cascade' }),
    concepts_touched: jsonb('concepts_touched').$type<string[]>().notNull().default([]),
    live_turns_count: integer('live_turns_count'),
    duration_minutes: integer('duration_minutes'),
    // 三通道制 (迁移 0044) — 语义同 post_lesson_evaluations 的
    // 同名三列 (见上)。
    agent_observation: text('agent_observation').notNull().default(''),
    learner_note: text('learner_note'),
    evidence_refs: jsonb('evidence_refs').$type<string[]>(),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    // 一场一评。
    liveSessionUnique: uniqueIndex('live_session_evaluations_live_session_id_uniq').on(
      t.live_session_id
    ),
  })
);

export type PostLessonEvaluationRow = typeof post_lesson_evaluations.$inferSelect;
export type LiveSessionEvaluationRow = typeof live_session_evaluations.$inferSelect;
