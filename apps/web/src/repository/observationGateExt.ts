// Observation gate repository extension — 批0/批1
// (观察禁区初版).
//
// Deliberately NOT folded into packages/contracts/src/repository.ts: same
// local-additive-interface move as ./simulatedQuiz.ts's SimulatedQuizRepo,
// ./journalExt.ts's JournalRepo, ./flashcardImportExt.ts's FlashcardImportRepo.
// Both concrete repos (Mock/Http) implement `Repository & ObservationGateRepo`;
// callers narrow `useRepository()`'s return type with
// `as (Repository & ObservationGateRepo) | null`.

import type { PairId } from '@learn-shell/contracts';

export interface ObservationGateState {
  /** 观察禁区登记簿 — categories the learner has declared off-limits. */
  forbidden_observations: string[];
  /** 把握度模式总开关 — off means the whole confidence-capture surface
   *  (exercise + simulated quiz) stops writing, not just stops rendering. */
  confidence_mode_enabled: boolean;
  confidence_mode_changed_at: string | null;
}

export interface ObservationGateRepo {
  getObservationGateState(pair_id: PairId): Promise<ObservationGateState>;
  // 观察禁区下线案 — add/removeForbiddenObservation removed with the boundary
  // registry UI: boundary negotiation is first-order conversation with the
  // agent now (server keeps the REST paths for the incoming MCP pen; the
  // web client just no longer writes the list).
  setConfidenceModeEnabled(
    pair_id: PairId,
    enabled: boolean
  ): Promise<{ confidence_mode_enabled: boolean; confidence_mode_changed_at: string | null }>;
}
