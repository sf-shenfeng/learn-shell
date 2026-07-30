// 首跑入学 + 下课铃 repository extension (web 侧,
// 首跑入学设计单 §三.3 / §四).
//
// Deliberately NOT folded into packages/contracts — same "contracts stays
// read-only this pass" precedent progressExt.ts / journalExt.ts already set;
// the server half ships from a parallel ticket, so the endpoint shapes are
// declared here (front-end local) and reconciled into contracts later.
//
// Endpoint contract (agreed with the server ticket, 以此为准):
//   POST /api/onboarding/learner            {display_name, locale?}
//     → {learner_id, display_name}          (同名未配对幂等)
//   POST /api/teaching/sessions/:id/declare-close  {}
//     → {declared_at}                       (终态 409 {error}; 已宣告幂等返回原值)
//   pair rows will carry optional `is_demo?: boolean`
//   session rows will carry optional `learner_close_declared_at?: string|null`

import type { LearnerAgentPair, LiveSession, LiveSessionId } from '@learn-shell/contracts';

/** Pair row incl. the migration-0042 is_demo column behind the DEMO pill
 *  (设计单五.1: pill 只是它的可见形; 本体是数据列, 参与默认 pair 选择)。
 *  施工中途 contracts 包已由服务端工单补上 `is_demo?: boolean` — 别名保留,
 *  调用方语义不变。 */
export type PairWithDemo = LearnerAgentPair;

/** LiveSession incl. the learner's structured 收课宣告 timestamp (设计单§四:
 *  按铃=落宣告, 不是杀进程)。同上 — contracts 已带
 *  `learner_close_declared_at?: string`, 别名保留。 */
export type LiveSessionWithClose = LiveSession;

/** Normalized read of the declare-close stamp (missing / empty / a wire
 *  `null` from an older payload all read as null). */
export function learnerCloseDeclaredAt(
  session: LiveSession | null | undefined
): string | null {
  const v = session?.learner_close_declared_at;
  return typeof v === 'string' && v ? v : null;
}

export interface RegisteredLearner {
  learner_id: string;
  display_name: string;
}

/**
 * declare-close's 409 is a real state, not a generic failure — the session
 * went terminal under the learner's feet (teacher completed / cancelled /
 * lease expired between render and click). Thrown specifically for that
 * status so the bell can say so quietly instead of a scary error; the
 * active-session polls flip the whole panel out of 'live' moments later
 * anyway. Same pattern as progressExt's AlreadyGradedError.
 */
export class SessionTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionTerminalError';
  }
}

export interface OnboardingRepo {
  /** 首跑页主权仪式 — the learner types their own name (设计单裁定: 名字由学习者
   *  亲手输入, 不走对话代填). Idempotent server-side for an unpaired
   *  same-name learner, so a page reload + re-submit is harmless. */
  registerLearner(input: { display_name: string; locale?: string }): Promise<RegisteredLearner>;
  /** 下课铃 — stamps the learner's 收课宣告 on an active session. Idempotent
   *  (already-declared returns the original stamp); terminal session throws
   *  SessionTerminalError (HTTP 409). */
  declareSessionClose(session_id: LiveSessionId): Promise<{ declared_at: string }>;
  /** getCurrentPair + the is_demo column — same endpoint, wider local type
   *  (the base Repository signature is locked in contracts). */
  getCurrentPairWithMeta(): Promise<PairWithDemo | null>;
}
