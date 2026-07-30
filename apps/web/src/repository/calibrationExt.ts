// Calibration curve repository extension — 批1 呈现层.
//
// Deliberately NOT folded into packages/contracts/src/repository.ts — same
// local-additive-interface move as ./observationGateExt.ts /
// ./simulatedQuiz.ts / ./journalExt.ts / ./flashcardImportExt.ts.

import type { CourseId, PairId } from '@learn-shell/contracts';
import type { ConfidenceLevel } from '../lib/confidence';

export interface CalibrationBucket {
  level: ConfidenceLevel;
  anchor_pct: number;
  sample_count: number;
  /** Mean of graded outcomes in [0,1]; null when sample_count is 0. */
  actual_correct_rate: number | null;
}

export interface CalibrationCurve {
  pair_id: string;
  course_id: string | null;
  buckets: CalibrationBucket[];
}

export interface CalibrationRepo {
  /** course_id omitted = 全局 (all courses). */
  getCalibrationCurve(pair_id: PairId, course_id?: CourseId): Promise<CalibrationCurve>;
}
