// Quiz — 两种类型, 完全独立的产品线:
//
// 1. SimulatedQuiz: Agent 出的模拟题, 训练用 (TEACHING-SPEC §3.3)
// 2. QuestionBank + QuizQuestion: 真题题库, LS 分发或 user import,
//    不依赖 agent, 自动判分对照标答.
//
// 路径完全分开是产品判断: 模拟 = 个性化训练, 真题 = 真实考试体验.

import type { PairId, LearnerId } from './pair';
import type { CourseId, ConceptId } from './content';

// =========================================================================
// SimulatedQuiz (Agent 出题)
// =========================================================================

export type SimulatedQuizId = string & { readonly __brand: 'SimulatedQuizId' };

export interface SimulatedQuestion {
  id: string;
  stem: string;
  /** round 3 (2026-07-07 Quiz 通电): 缺省 'short_answer' 兼容 round 2 纯开放题。
   * 考试型训练（如 CFA L1）应出 'single_choice' + 3 选项，贴真实考试格式。 */
  question_type?: QuestionType;
  choices?: string[]; // single/multi choice 才有
  reference_answer: string;
  explanation?: string; // 讲解——错为什么错、对为什么对
  concept_tags: ConceptId[];
}

export interface SimulatedQuiz {
  id: SimulatedQuizId;
  pair_id: PairId;
  course_id: CourseId;
  agent_skill_used: string;
  questions: SimulatedQuestion[];
  created_at: string;
}

export type SimulatedQuizAttemptId = string & { readonly __brand: 'SimulatedQuizAttemptId' };

export interface SimulatedQuizAttemptAnswer {
  question_id: string;
  answer: string;
  /** 选择题自动判分；开放题留空，由 agent 复盘或学习者对照 reference_answer 自评。 */
  correct?: boolean;
}

/** round 3 (2026-07-07 Quiz 通电): 模拟卷作答记录。与真题线的 QuizAttempt 平行、
 * 不混表——模拟=训练数据（可回流 learner model），真题=考试体验，产品线始终分开。 */
export interface SimulatedQuizAttempt {
  id: SimulatedQuizAttemptId;
  quiz_id: SimulatedQuizId;
  learner_id: LearnerId;
  started_at: string;
  finished_at?: string;
  answers: SimulatedQuizAttemptAnswer[];
  /** 自动判分子集上的得分 0..1；无可判题时缺省。 */
  score?: number;
}

// =========================================================================
// QuestionBank + QuizQuestion + QuizAttempt (真题路径)
// =========================================================================

export type QuestionBankId = string & { readonly __brand: 'QuestionBankId' };
export type QuizAttemptId = string & { readonly __brand: 'QuizAttemptId' };

export type QuestionType = 'single_choice' | 'multi_choice' | 'short_answer' | 'essay';

export interface QuestionBank {
  id: QuestionBankId;
  exam: string; // "CFA L1" / "JLPT N3"
  year?: number;
  source: 'distribution' | 'user_import';
  language: 'en' | 'zh' | 'ja' | 'mixed';
  version: string;
  questions_count: number;
  description?: string;
}

export interface QuizQuestion {
  id: string;
  bank_id: QuestionBankId;
  stem: string;
  question_type: QuestionType;
  choices?: string[]; // 单选 / 多选才有
  reference_answer: string;
  explanation?: string;
  concept_tags: string[];
  difficulty: 1 | 2 | 3 | 4 | 5;
}

export interface QuizAttemptAnswer {
  question_id: string;
  answer: string;
  correct: boolean; // 自动判分对照标答
}

export interface QuizAttempt {
  id: QuizAttemptId;
  learner_id: LearnerId;
  bank_id: QuestionBankId;
  started_at: string;
  finished_at?: string;
  answers: QuizAttemptAnswer[];
  score: number; // 0..1
}
