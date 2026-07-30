// Brier trend repository extension — 誓言三 (Settings CertificateCard,
// confidence 可视化视图三).
//
// Deliberately NOT folded into packages/contracts/src/repository.ts — same
// local-additive-interface move as ./calibrationExt.ts's CalibrationRepo /
// ./confidenceAnchorExt.ts's ConfidenceAnchorRepo. Both concrete repos
// (Mock/Http) implement `Repository & BrierTrendRepo`.

import type { PairId } from '@learn-shell/contracts';

export interface BrierTrendPoint {
  week_start: string; // YYYY-MM-DD, 周一
  n: number;
  brier: number;
}

export interface BrierTrendRepo {
  /** 按 ISO 周分桶, 升序. 空数组 = 还没有可判分的把握度样本。 */
  getBrierTrend(pair_id: PairId): Promise<BrierTrendPoint[]>;
}
