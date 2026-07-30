// Drizzle: SimulatedQuiz + SimulatedQuizAttempt (agent 出题路径) +
// QuestionBank + QuizQuestion + QuizAttempt (真题路径).
//
// round 3 (2026-07-07 Quiz 通电): SimulatedQuiz 从 client-side only 转正为
// persisted 表 — 与真题线的 quiz_attempts 平行、不混表 (packages/contracts/
// src/quiz.ts 顶部注释同一判断)。

import { sql } from 'drizzle-orm';
import { pgTable, text, integer, jsonb, timestamp, doublePrecision } from 'drizzle-orm/pg-core';
import { learners, learner_agent_pairs } from './pair';
import { courses } from './content';
import type {
  QuestionType,
  QuizAttemptAnswer,
  SimulatedQuestion,
  SimulatedQuizAttemptAnswer,
} from '@learn-shell/contracts';
import type { ConfidenceLevel } from '../../lib/confidence';

// Learner Model 批1 (考场条款) — simulated quiz
// 逐题把握度. packages/contracts' SimulatedQuizAttemptAnswer stays untouched
// (read-only this pass); this local extension is the $type this column
// actually stores under. Real quiz line (QuizAttemptAnswer / quiz_attempts
// below) is NOT extended — brief scopes 考场条款 to simulated quiz only,
// the real-exam-experience line stays a separate product (see header note).
export type SimulatedQuizAttemptAnswerWithConfidence = SimulatedQuizAttemptAnswer & {
  confidence?: ConfidenceLevel;
  confidence_pct?: number;
};

// =========================================================================
// SimulatedQuiz (Agent 出题) + SimulatedQuizAttempt
// =========================================================================

export const simulated_quizzes = pgTable('simulated_quizzes', {
  id: text('id').primaryKey(),
  pair_id: text('pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  course_id: text('course_id')
    .notNull()
    .references(() => courses.id, { onDelete: 'cascade' }),
  agent_skill_used: text('agent_skill_used').notNull(),
  questions: jsonb('questions').$type<SimulatedQuestion[]>().notNull().default([]),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const simulated_quiz_attempts = pgTable('simulated_quiz_attempts', {
  id: text('id').primaryKey(),
  quiz_id: text('quiz_id')
    .notNull()
    .references(() => simulated_quizzes.id, { onDelete: 'cascade' }),
  learner_id: text('learner_id')
    .notNull()
    .references(() => learners.id, { onDelete: 'cascade' }),
  started_at: timestamp('started_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  finished_at: timestamp('finished_at', { withTimezone: true }),
  answers: jsonb('answers').$type<SimulatedQuizAttemptAnswerWithConfidence[]>().notNull().default([]),
  // 无可判题 (纯开放题卷) 时缺省 — 与 SimulatedQuizAttempt.score 的可选语义对齐,
  // 真题线 quiz_attempts.score 相反 (notNull default 0), 两条产品线判分语义不同.
  score: doublePrecision('score'),
});

export type SimulatedQuizRow = typeof simulated_quizzes.$inferSelect;
export type SimulatedQuizAttemptRow = typeof simulated_quiz_attempts.$inferSelect;

export const question_banks = pgTable('question_banks', {
  id: text('id').primaryKey(),
  exam: text('exam').notNull(),
  year: integer('year'),
  source: text('source').notNull(),
  language: text('language').notNull(),
  version: text('version').notNull(),
  questions_count: integer('questions_count').notNull().default(0),
  description: text('description'),
});

export const quiz_questions = pgTable('quiz_questions', {
  id: text('id').primaryKey(),
  bank_id: text('bank_id')
    .notNull()
    .references(() => question_banks.id, { onDelete: 'cascade' }),
  stem: text('stem').notNull(),
  question_type: text('question_type').$type<QuestionType>().notNull(),
  choices: jsonb('choices').$type<string[]>(),
  reference_answer: text('reference_answer').notNull(),
  explanation: text('explanation'),
  concept_tags: jsonb('concept_tags').$type<string[]>().notNull().default([]),
  difficulty: integer('difficulty').notNull().default(1),
});

export const quiz_attempts = pgTable('quiz_attempts', {
  id: text('id').primaryKey(),
  learner_id: text('learner_id')
    .notNull()
    .references(() => learners.id, { onDelete: 'cascade' }),
  bank_id: text('bank_id')
    .notNull()
    .references(() => question_banks.id, { onDelete: 'cascade' }),
  started_at: timestamp('started_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  finished_at: timestamp('finished_at', { withTimezone: true }),
  answers: jsonb('answers').$type<QuizAttemptAnswer[]>().notNull().default([]),
  score: doublePrecision('score').notNull().default(0),
});

export type QuestionBankRow = typeof question_banks.$inferSelect;
export type QuizQuestionRow = typeof quiz_questions.$inferSelect;
export type QuizAttemptRow = typeof quiz_attempts.$inferSelect;
