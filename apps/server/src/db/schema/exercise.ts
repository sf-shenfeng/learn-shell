// Drizzle: Exercise + ExerciseSubmission (4-state machine).

import { sql } from 'drizzle-orm';
import { pgTable, text, integer, jsonb, timestamp, doublePrecision } from 'drizzle-orm/pg-core';
import { lessons } from './content';
import { learners } from './pair';
import type { ExerciseSubmissionStatus } from '@learn-shell/contracts';
import type { ConfidenceLevel } from '../../lib/confidence';

export const exercises = pgTable('exercises', {
  id: text('id').primaryKey(),
  lesson_id: text('lesson_id')
    .notNull()
    .references(() => lessons.id, { onDelete: 'cascade' }),
  order: integer('order').notNull(),
  prompt: text('prompt').notNull(),
  reference_answer: text('reference_answer').notNull(),
  expected_concepts: jsonb('expected_concepts').$type<string[]>().notNull().default([]),
  // 迁移 0039 — 探针标签通道: lesson-prep 工作流要求
  // 探针题打 ["probe"] 标, 此前只有 flashcards 有 tags 列, exercises 没有。
  // 自由字符串数组 ("probe" 是当前唯一约定值, 非封闭枚举), 形状校验在
  // mcp/server.ts add_exercise (validateOptionalStringArrayArg)。
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  agent_skill_used: text('agent_skill_used').notNull(),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const exercise_submissions = pgTable('exercise_submissions', {
  id: text('id').primaryKey(),
  exercise_id: text('exercise_id')
    .notNull()
    .references(() => exercises.id, { onDelete: 'cascade' }),
  learner_id: text('learner_id')
    .notNull()
    .references(() => learners.id, { onDelete: 'cascade' }),
  learner_answer: text('learner_answer').notNull(),
  status: text('status').$type<ExerciseSubmissionStatus>().notNull().default('draft'),
  submitted_at: timestamp('submitted_at', { withTimezone: true }),
  withdrew_at: timestamp('withdrew_at', { withTimezone: true }),
  previous_submission_id: text('previous_submission_id'),
  agent_feedback: text('agent_feedback'),
  agent_score: doublePrecision('agent_score'),
  graded_at: timestamp('graded_at', { withTimezone: true }),

  // Learner Model 批1 — 元认知把握度,
  // 考场条款: 只在评估表面采集, 可跳过, 已有历史作答不追溯留 null.
  confidence: text('confidence').$type<ConfidenceLevel>(),
  confidence_pct: integer('confidence_pct'),

  // 断链修复 (迁移 0044): 提交可引用一条 Live 回答 (teaching_responses
  // 行 id) —— "Live 里答过了"从人工回查 transcript 变成机器可循的引用。
  // 可空, 不加 FK (跨前缀 id 按既有风格只存字符串); 存在性+同 pair 归属在
  // 写入口 (POST /api/submissions) 用 lib/evidence-refs.ts 校验。
  live_response_id: text('live_response_id'),
});

export type ExerciseRow = typeof exercises.$inferSelect;
export type ExerciseSubmissionRow = typeof exercise_submissions.$inferSelect;
