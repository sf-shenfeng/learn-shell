// Feedback ledger repository extension — 现场反馈笔改革 (web 半场).
//
// The ritual-era weekly feedback (week_of + four 1–5 scores) became an
// event-style ledger: feedback has no dedicated entry form — the learner's
// ordinary messages are the entry point, the agent recognizes issue/idea in
// conversation and records it (record_learner_feedback). This ext types the
// full row the server now returns from GET /pairs/:pairId/feedback
// (apps/server/src/db/schema/feedback.ts, 迁移 0038) without touching
// packages/contracts' legacy LearnerFeedback shape — same local-additive-
// interface move as ./observationGateExt.ts.

import type { PairId } from '@learn-shell/contracts';

export type FeedbackKind = 'issue' | 'idea';

/** open → acknowledged → addressed/declined (terminal). declined always
 *  carries a status_note — 拒绝欠判词, enforced server-side. */
export type FeedbackStatus = 'open' | 'acknowledged' | 'addressed' | 'declined';

export interface FeedbackLedgerEntry {
  id: string;
  pair_id: PairId;
  kind: FeedbackKind;
  status: FeedbackStatus;
  status_note: string | null;
  status_changed_at: string | null;
  /** 挂锚 — no FKs, existence checked at write time server-side. */
  lesson_id: string | null;
  live_session_id: string | null;
  exercise_id: string | null;
  /** Free-text reference (live messages may only live in the bridge event
   *  stream — stored, never validated). */
  source_message_ref: string | null;
  /** 逐字纪律: the learner's verbatim words, not the teacher's paraphrase. */
  free_text: string | null;
  submitted_at: string;
}

export interface FeedbackLedgerRepo {
  /** Full ledger for the pair, newest first (server orders by submitted_at
   *  desc; MockRepository mirrors that). Read-only — there is deliberately
   *  no submit method here: the entry point is conversation, not a form. */
  getFeedbackLedger(pair_id: PairId): Promise<FeedbackLedgerEntry[]>;
}
