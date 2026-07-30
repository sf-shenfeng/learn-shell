// SimulatedQuiz repository extension — round 3 (2026-07-07 Quiz 通电).
//
// Deliberately NOT folded into packages/contracts/src/repository.ts: this
// pass's red line keeps packages/contracts read-only (the foreman already
// extended quiz.ts's types for this round; the shared Repository interface
// itself is out of scope). `getSimulatedQuizzes` already lives on Repository
// and covers listing — only the two attempt-flow methods are missing, so
// they're declared here as a local, additive interface. Both concrete repos
// (Mock/Http) implement `Repository & SimulatedQuizRepo`; callers that need
// the new methods narrow `useRepository()`'s return type with
// `as (Repository & SimulatedQuizRepo) | null` (see pages/Quiz.tsx).

import type {
  LearnerId,
  SimulatedQuizAttempt,
  SimulatedQuizId,
} from '@learn-shell/contracts';
import type { ConfidenceLevel } from '../lib/confidence';

export interface SimulatedQuizRepo {
  /** All attempts for one simulated quiz, most recent first — "历史作答可回看". */
  getSimulatedQuizAttempts(quiz_id: SimulatedQuizId): Promise<SimulatedQuizAttempt[]>;
  /**
   * Submit raw answers ({question_id, answer} only — no client-computed
   * `correct`, unlike the real-quiz path). Server grades single/multi choice
   * against reference_answer and returns the full graded attempt.
   *
   * `confidence`/`confidence_pct` per answer are Learner Model 批1's 考场条款
   * addition (LEARNER-MODEL-BRIEF §9) — optional, skippable. Widened in place
   * here rather than via a parallel method: unlike submitExercise (locked in
   * packages/contracts), this interface is already a local extension, so
   * there's no locked type standing in the way.
   */
  submitSimulatedQuizAttempt(input: {
    quiz_id: SimulatedQuizId;
    learner_id: LearnerId;
    answers: Array<{
      question_id: string;
      answer: string;
      confidence?: ConfidenceLevel;
      confidence_pct?: number;
    }>;
  }): Promise<SimulatedQuizAttempt>;

  /**
   * 模拟卷硬删除案/模拟卷硬删除二期 — hard-delete a simulated quiz and its attempts (probe/
   * practice quizzes with no delete tool were a recorded real-use pain
   * point). Server snapshots {quiz, attempts} to a small
   * graveyard file before deleting (same tombstone convention as
   * deleteCourse) — insurance only, there's no restore endpoint at this
   * scope. Rejects if the quiz doesn't exist.
   */
  deleteSimulatedQuiz(quiz_id: SimulatedQuizId): Promise<void>;
}
