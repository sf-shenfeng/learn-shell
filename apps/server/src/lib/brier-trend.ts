// Brier trend — 誓言三 (Settings CertificateCard, brief "confidence 可视化
// 两视图" 视图三). 按 ISO 周分桶的 Brier score 时间线, 服务 success_criteria
// 里写了"brier"字样的婚书合约.
//
// 正误判定同源: 与 lib/calibration.ts 的 computeCalibrationCurve 完全一致
// (exercise_submissions 用 agent_score 这个 0..1 软分作"正确"的代理量,
// simulated_quiz_attempts.answers 用它自己的布尔 correct 转 0/1) —— 这里
// 不重新发明一套判定, 直接照抄同一份逻辑, 唯一差异是分子换成 confidence_pct
// (数值, 写入时按当刻锚值折算好、事后不追溯——"history is history", 见
// confidence-anchors.ts 顶部注释) 而不是 calibration 曲线用的序数 confidence。
//
// Brier = mean((confidence_pct/100 − correct)^2), 按 ISO 周 (周一为界) 聚合。
// 批量单查禁 N+1: 两条查询各一次 (submissions join exercises+lessons 不需要
// —— 这里不做课程过滤, 比 calibration 曲线少一次 join), quiz 一次 join。

import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import {
  exercise_submissions,
  exercises,
  simulated_quiz_attempts,
  simulated_quizzes,
  learner_agent_pairs,
} from '../db/schema';

export interface BrierTrendPoint {
  week_start: string; // YYYY-MM-DD, 周一
  n: number;
  brier: number;
}

/** Monday-anchored ISO week start, UTC date-only string. */
function isoWeekStart(d: Date): string {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = utc.getUTCDay() || 7; // Mon=1 .. Sun=7
  if (day !== 1) utc.setUTCDate(utc.getUTCDate() - (day - 1));
  return utc.toISOString().slice(0, 10);
}

export async function computeBrierTrend(pairId: string): Promise<BrierTrendPoint[]> {
  const sqErrorByWeek = new Map<string, { sum: number; n: number }>();
  const add = (week: string, sqError: number) => {
    const bucket = sqErrorByWeek.get(week) ?? { sum: 0, n: 0 };
    bucket.sum += sqError;
    bucket.n += 1;
    sqErrorByWeek.set(week, bucket);
  };

  const [pair] = await db
    .select({ learner_id: learner_agent_pairs.learner_id })
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.id, pairId))
    .limit(1);

  if (pair?.learner_id) {
    const subRows = await db
      .select({
        confidence_pct: exercise_submissions.confidence_pct,
        agent_score: exercise_submissions.agent_score,
        submitted_at: exercise_submissions.submitted_at,
      })
      .from(exercise_submissions)
      .innerJoin(exercises, eq(exercise_submissions.exercise_id, exercises.id))
      .where(eq(exercise_submissions.learner_id, pair.learner_id));

    for (const row of subRows) {
      if (row.confidence_pct == null || row.agent_score == null || !row.submitted_at) continue;
      const correct = row.agent_score; // same soft-score-as-outcome move as calibration.ts
      const err = row.confidence_pct / 100 - correct;
      add(isoWeekStart(row.submitted_at), err * err);
    }
  }

  const quizRows = await db
    .select({
      answers: simulated_quiz_attempts.answers,
      started_at: simulated_quiz_attempts.started_at,
      finished_at: simulated_quiz_attempts.finished_at,
    })
    .from(simulated_quiz_attempts)
    .innerJoin(simulated_quizzes, eq(simulated_quiz_attempts.quiz_id, simulated_quizzes.id))
    .where(eq(simulated_quizzes.pair_id, pairId));

  for (const row of quizRows) {
    const week = isoWeekStart(row.finished_at ?? row.started_at);
    for (const a of row.answers) {
      if (a.confidence_pct == null || a.correct === undefined) continue;
      const correct = a.correct ? 1 : 0;
      const err = a.confidence_pct / 100 - correct;
      add(week, err * err);
    }
  }

  return [...sqErrorByWeek.entries()]
    .map(([week_start, { sum, n }]) => ({ week_start, n, brier: sum / n }))
    .sort((a, b) => a.week_start.localeCompare(b.week_start));
}
