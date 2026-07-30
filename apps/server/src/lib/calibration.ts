// Calibration curve — 批1 呈现层.
//
// 三档聚合: 每档 (guess/likely/certain) 样本数 + 实际正确率. Two sources feed
// each bucket, both scoped to this pair:
//   - exercise_submissions: graded, has confidence + a soft 0..1 agent_score
//     ("正确率" here is the mean score, not a hard right/wrong split — the
//     grading itself is soft, brief doesn't ask for a correctness threshold).
//   - simulated_quiz_attempts.answers: per-question confidence + a boolean
//     `correct` (only present for auto-graded choice questions — open-ended
//     answers without a verdict are excluded, same as the score view does).
//
// Long-exposure red line (brief 军规 2 + §9's "诚实空态"): this module only
// counts and averages, it never invents a verdict for a thin bucket — the
// <5-sample "显影中" threshold is a presentation decision made by the caller
// (Settings' Portrait section), not baked in here.

import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import {
  exercise_submissions,
  exercises,
  lessons,
  simulated_quiz_attempts,
  simulated_quizzes,
  learner_agent_pairs,
} from '../db/schema';
import { CONFIDENCE_LEVELS, type ConfidenceLevel } from './confidence';
import { getConfidenceAnchors } from './confidence-anchors';

export interface CalibrationBucket {
  level: ConfidenceLevel;
  anchor_pct: number;
  sample_count: number;
  /** Mean of graded outcomes in [0,1] for this bucket; null when sample_count is 0. */
  actual_correct_rate: number | null;
}

export interface CalibrationCurve {
  pair_id: string;
  course_id: string | null;
  buckets: CalibrationBucket[];
}

export async function computeCalibrationCurve(
  pairId: string,
  courseId?: string
): Promise<CalibrationCurve> {
  const outcomesByLevel = new Map<ConfidenceLevel, number[]>();
  for (const lvl of CONFIDENCE_LEVELS) outcomesByLevel.set(lvl, []);

  const [pair] = await db
    .select({ learner_id: learner_agent_pairs.learner_id })
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.id, pairId))
    .limit(1);

  if (pair?.learner_id) {
    const subRows = await db
      .select({
        confidence: exercise_submissions.confidence,
        agent_score: exercise_submissions.agent_score,
        course_id: lessons.course_id,
      })
      .from(exercise_submissions)
      .innerJoin(exercises, eq(exercise_submissions.exercise_id, exercises.id))
      .innerJoin(lessons, eq(exercises.lesson_id, lessons.id))
      .where(eq(exercise_submissions.learner_id, pair.learner_id));

    for (const row of subRows) {
      if (!row.confidence || row.agent_score === null || row.agent_score === undefined) continue;
      if (courseId && row.course_id !== courseId) continue;
      outcomesByLevel.get(row.confidence)?.push(row.agent_score);
    }
  }

  const quizRows = await db
    .select({
      answers: simulated_quiz_attempts.answers,
      course_id: simulated_quizzes.course_id,
    })
    .from(simulated_quiz_attempts)
    .innerJoin(simulated_quizzes, eq(simulated_quiz_attempts.quiz_id, simulated_quizzes.id))
    .where(eq(simulated_quizzes.pair_id, pairId));

  for (const row of quizRows) {
    if (courseId && row.course_id !== courseId) continue;
    for (const a of row.answers) {
      if (!a.confidence || a.correct === undefined) continue;
      outcomesByLevel.get(a.confidence)?.push(a.correct ? 1 : 0);
    }
  }

  // anchor_pct is a *label*, not a filter — it's this pair's CURRENT
  // mapping config (Confidence 主权立法), shown next to each bucket so the
  // learner sees "what my 'guess' button means today". The sample outcomes
  // above never touch confidence_pct at all (bucketing is by the ordinal
  // `confidence` column, outcomes are agent_score/correct) — a bucket's
  // historical samples may span pairs of anchor edits over time; that's
  // expected, this curve is about accuracy-vs-ordinal, not accuracy-vs-pct.
  const anchors = await getConfidenceAnchors(pairId);
  const buckets: CalibrationBucket[] = CONFIDENCE_LEVELS.map((level) => {
    const outcomes = outcomesByLevel.get(level) ?? [];
    return {
      level,
      anchor_pct: anchors[level],
      sample_count: outcomes.length,
      actual_correct_rate:
        outcomes.length > 0 ? outcomes.reduce((s, v) => s + v, 0) / outcomes.length : null,
    };
  });

  return { pair_id: pairId, course_id: courseId ?? null, buckets };
}
