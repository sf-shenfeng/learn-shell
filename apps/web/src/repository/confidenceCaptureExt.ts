// Exercise-submission confidence capture repository extension — 批1
// (考场条款).
//
// Deliberately a NEW method rather than widening the canonical
// `Repository.submitExercise`'s locked parameter type (`Omit<ExerciseSubmission,
// 'id'|'submitted_at'|'status'>` — ExerciseSubmission comes from
// packages/contracts, read-only this pass and has no room for confidence).
// Same "local additive interface, don't touch the locked contract" move as
// every other extension in this directory. The simulated-quiz path didn't
// need this trick — SimulatedQuizRepo is already a local interface, so its
// existing method's input type was simply widened in place (see
// ./simulatedQuiz.ts).
//
// ExerciseCard (apps/web/src/pages/Lesson.tsx) calls this instead of
// submitExercise unconditionally — confidence/confidence_pct are optional,
// so callers with confidence mode off (or the learner skipped the pick)
// just omit them, and this collapses to a plain submission.

import type { ExerciseId, ExerciseSubmission, LearnerId } from '@learn-shell/contracts';
import type { ConfidenceLevel } from '../lib/confidence';

export interface ExerciseSubmissionWithConfidence extends ExerciseSubmission {
  confidence?: ConfidenceLevel | null;
  confidence_pct?: number | null;
}

export interface ConfidenceCaptureRepo {
  submitExerciseWithConfidence(input: {
    exercise_id: ExerciseId;
    learner_id: LearnerId;
    learner_answer: string;
    confidence?: ConfidenceLevel;
    confidence_pct?: number;
  }): Promise<ExerciseSubmissionWithConfidence>;
}
