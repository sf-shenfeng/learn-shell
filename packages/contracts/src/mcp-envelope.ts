// Unified machine-readable receipt envelope for MCP tool calls (and the REST
// mutation counterparts that share the same failure modes) — Agent
// Surface Hardening 第一批
// ("将文字回执升级为机器回执").
//
// Distinct from `EventEnvelope` in envelope.ts — that one is the audit/
// provenance wrapper around persisted domain events (actor/session/source
// refs). This one is the call-result wrapper: what a tool call hands back to
// the calling agent, success or failure, so the agent never has to regex a
// human sentence like "Lesson xxx revised to v3" to know what happened.
//
// `human_note` always carries the sentence a person would want to read in a
// log (mirrors what these tools used to return as their entire payload) —
// nothing is lost, it just now sits alongside machine-parseable fields
// instead of being the only thing returned.
//
// `data` is the escape hatch for read/orient tools (get_context,
// get_learner_brief, live_pending, ...) whose payload doesn't fit the
// resource_id/revision/created_refs mutation shape — their existing rich
// JSON response goes here unchanged, just wrapped.

import type { LiveRuntimeContract } from './teaching';
import type { ClosureProgress } from './progress';

export type McpErrorCode =
  | 'VALIDATION' // bad/missing input — caller must change the request before retrying
  | 'NOT_FOUND' // referenced id doesn't exist (or doesn't belong to this pair)
  | 'CONFLICT' // concurrent write / stale revision / reused idempotency key
  | 'PERMISSION' // action not allowed under current scope/gate
  | 'RETRYABLE'; // transient (DB blip, unexpected exception) — safe to retry as-is

export interface McpSuccessEnvelope<
  Refs extends Record<string, string> = Record<string, string>,
  Data = unknown,
> {
  status: 'success';
  /** Tool/operation name, e.g. 'add_lesson' — lets a caller log/route without
   *  re-deriving it from context. */
  operation: string;
  /** Primary resource this call created/mutated, when there is a single
   *  obvious one (e.g. the lesson id for add_lesson/update_lesson). */
  resource_id?: string;
  /** New revision number, for tools that bump one (update_lesson). */
  revision?: number;
  /** Every id this call created, keyed by role (e.g. { lesson_id, mindmap_id,
   *  association_id }) — richer than resource_id when a call fans out into
   *  more than one row. */
  created_refs?: Refs;
  /** Deep link into the learner-facing web app, when the created/updated
   *  resource has one. */
  learner_url?: string;
  /** Tool names the agent should plausibly call next (e.g. add_lesson ->
   *  ['add_concept', 'add_flashcard', 'add_exercise']). Advisory, not
   *  enforced. */
  next_recommended_actions?: string[];
  /** 软牌 — advisory hint for what the agent should do next in the Live
   *  Teaching move sequence (currently only stamped on live_session_start:
   *  a fresh session's first move should be FRAME). Not enforced server-side
   *  (no 400 on skipping it) — see skills/recipe on the FRAME-first convention. */
  next_expected?: 'FRAME';
  /** 值更契约全路径暴露 (红队 P0, Live 2.0 二期 W2 件一) — stronger than
   *  next_expected: a hard directive naming the exact next step. Stamped on
   *  live_session_start ('send_FRAME_then_ASK' — FRAME is a response_kind
   *  'none' move, so the turn stays with the teacher until an ASK hands it
   *  over; retired the contradictory
   *  'send_FRAME_then_wait') and on live_message_send (per-move routing by
   *  the awaiting state machine: 'send_ASK' / 'send_next_move' /
   *  'wait_for_learner_response' / 'live_session_complete'). Distinct from
   *  next_recommended_actions (a menu of plausible tools) — this is one
   *  named step, not a menu. */
  next_required_action?: string;
  /** 值更契约全路径暴露 (件一) — the live-duty contract for this call, when
   *  applicable (live_session_start/get, live_wait, live_pending). See
   *  LiveRuntimeContract's doc comment (teaching.ts) for the full rationale. */
  live_runtime_contract?: LiveRuntimeContract;
  /** 值更契约的教义版本号 (LiveRuntimeContract 除 may_end_turn
   *  外的 content hash), 与 live_runtime_contract 同场合随行。live_wait 的
   *  known_contract_version 命中现行版时, 合约体省略、只留这个字段 — 协议
   *  详见 teaching.ts LiveRuntimeContract 上方注释。 */
  contract_version?: string;
  /** A call that still succeeded but the agent should read before continuing
   *  down this path (e.g. create_course with no established contract for the
   *  pair yet — not rejected, but a machine-visible road sign so a "帮我备课"
   *  one-liner doesn't silently skip intake). Distinct from an error: the
   *  mutation went through. */
  warning?: string;
  /** The human-readable sentence this tool used to return as its entire
   *  payload — always present, still worth reading by eye in logs. */
  human_note: string;
  /** Present + true only when this exact idempotency_key had already been
   *  applied and this response replays the original result rather than
   *  performing a fresh write. */
  idempotent_replay?: boolean;
  /** 开课原子去重 (红队第六轮针一, 2026-07-20) — present + true only on
   *  live_session_start when the (pair, context_type, context_id) already had
   *  an active session (found before insert, or recovered from a 23505 unique
   *  violation on drizzle/0036's partial unique index) and this response
   *  hands back that existing session instead of opening a new one. Absent
   *  (not false) on every other tool. */
  joined_existing?: boolean;
  /** 随行回执 (红队第六轮针二, 2026-07-20) — stamped on grade_exercise (when
   *  the submission's exercise resolves to a lesson; this is
   *  the closing chain's first write) / record_live_evaluation
   *  / record_post_lesson_evaluation / reflect_on_teaching (when it carries a
   *  lesson anchor) / close_lesson_loop so the caller doesn't have to make a
   *  separate get_lesson_closure_state round-trip to see where the lesson
   *  stands right after this write. Assembled fresh (lib/lesson-closure-facts.ts
   *  computeLessonClosureProgress) after the mutation commits — see that
   *  function's doc comment for the recentCloseSkip nuance close_lesson_loop
   *  needs. Absent when the tool has no lesson anchor for this call
   *  (record_live_evaluation on a non-lesson live session, reflect_on_teaching
   *  without lesson_id). */
  closure_progress?: ClosureProgress;
  /** 判错递笔 — stamped only on grade_exercise, only when the
   *  verdict this call just recorded reads as incorrect (agent_score given
   *  and below the shared threshold, see lib/lesson-closure-facts.ts
   *  isIncorrectVerdict) AND the graded exercise has at least one resolved
   *  concept (exercises.expected_concepts). Purely informational — the
   *  concept id(s) a targeted flashcard would anchor to, already resolved so
   *  the calling agent doesn't have to re-walk exercise→concept itself.
   *  Whether to actually call add_flashcard is the agent's discretion (声纹
   *  条款 口吻: no mandate, no severity, no recommendation-engine coupling
   *  beyond next_recommended_actions, which this deliberately does NOT
   *  touch). Absent on every other call shape (no score, perfect/passing
   *  score, or no expected_concepts on the exercise). */
  concept_refs?: string[];
  /** Escape hatch for read/orient tools whose payload doesn't fit the
   *  resource_id/created_refs mutation shape (get_context, get_learner_brief,
   *  live_pending, live_session_get, adhoc_thread_get,
   *  live_snapshot_get_latest, get_teacher_inbox). Mutation tools leave this
   *  undefined. */
  data?: Data;
}

export interface McpErrorEnvelope {
  status: 'error';
  code: McpErrorCode;
  /** Machine-oriented message — same text as human_note; kept as a separate
   *  field so callers can pattern-match on `message` without assuming
   *  `human_note`'s exact wording is a stable contract. */
  message: string;
  retryable: boolean;
  /** One sentence telling the agent what to *do* — reload+reapply, mint a
   *  fresh idempotency key, fix a named field, etc. Never just "an error
   *  occurred". */
  recovery_hint: string;
  /** Same sentence as `message` — present for symmetry with the success
   *  envelope's human_note so both shapes have exactly one "read this out
   *  loud" field at the same key. */
  human_note: string;
  /** Structured extras (e.g. expected_revision/actual_revision for a CONFLICT,
   *  available_pairs for a NOT_FOUND). */
  details?: Record<string, unknown>;
}

export type McpEnvelope<
  Refs extends Record<string, string> = Record<string, string>,
  Data = unknown,
> = McpSuccessEnvelope<Refs, Data> | McpErrorEnvelope;
