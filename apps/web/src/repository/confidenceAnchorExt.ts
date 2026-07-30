// Confidence anchor config repository extension — Confidence 主权立法
// (学习者裁决版).
//
// Deliberately NOT folded into packages/contracts/src/repository.ts — same
// local-additive-interface move as ./observationGateExt.ts's
// ObservationGateRepo / ./calibrationExt.ts's CalibrationRepo. Both concrete
// repos (Mock/Http) implement `Repository & ConfidenceAnchorRepo`; callers
// narrow `useRepository()`'s return type the same way the other extensions do.
//
// 映射权归学习者: this is the one place a pair's confidence→pct mapping can
// be read or changed, and it is deliberately a THIN pair, mirroring
// getObservationGateState/setConfidenceModeEnabled — not a generic settings
// bag. Teacher-facing MCP surfaces never call this; there is no MCP
// tool/resource for it by design (see apps/server/src/lib/confidence-anchors.ts).

import type { PairId } from '@learn-shell/contracts';
import type { ConfidenceAnchorConfig } from '../lib/confidence';

export interface ConfidenceAnchorRepo {
  getConfidenceAnchors(pair_id: PairId): Promise<ConfidenceAnchorConfig>;
  /** Server re-validates (0-100 integers, strictly increasing) and rejects
   *  bad input — callers should still run lib/confidence.ts's
   *  validateConfidenceAnchors first for a fast inline error. */
  setConfidenceAnchors(pair_id: PairId, anchors: ConfidenceAnchorConfig): Promise<ConfidenceAnchorConfig>;
}
