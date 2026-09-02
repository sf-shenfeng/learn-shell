// Live Teaching (Stage 7c, 2026-06-29; revised Stage 7d-fix, 2026-06-30):
//
// Ported from the predecessor hub's `teaching_sessions` / `teaching_moves` /
// `teaching_responses` schema (see backend/init_db.py in that codebase).
// Keep field names + enum values aligned with Hub so the move protocol is
// portable across surfaces.
//
// Lifecycle:
//   start → active (awaiting_role flips agent ↔ learner per turn) → complete
//                                                                  ↘
//                                                                   cancelled / expired
//
// Move-response pairing:
//   - Agent appends a Move (FRAME / ASK / EXPLAIN / PROBE / HINT /
//     CHALLENGE / REFLECT) with response_kind = 'text' | 'continue' | 'none'.
//     This implicitly hands awaiting to the learner.
//   - Learner submits a Response (text / voice_transcript / continue /
//     question) — server pins it to the last move; awaiting flips back to
//     agent.
//
// Live Teaching is STRUCTURED teaching — agent-driven turn loop with the
// move grammar above, REFLECT triple at close, lesson-anchored.
//
// For unstructured Q&A / free chat / cross-page floating panel, see the
// AdHocThread entity in adhoc.ts (a parallel, NOT a sub-mode of LiveSession).
// The two share the agent CC CLI context but live in separate tables.
// 2026-06-30: layer field rolled back — mixing free chat into TeachingMove
// would have polluted the structured-teaching record with chitchat.

import type { PairId } from './pair';
import type { LessonId } from './content';

export type LiveSessionId = string & { readonly __brand: 'LiveSessionId' };
export type TeachingMoveId = string & { readonly __brand: 'TeachingMoveId' };
export type TeachingResponseId = string & {
  readonly __brand: 'TeachingResponseId';
};

export type LiveSessionStatus = 'active' | 'completed' | 'cancelled' | 'expired';
export type AwaitingRole = 'agent' | 'learner' | 'none';

/**
 * Move taxonomy (Hub-aligned):
 *   FRAME     — Set context for the turn ("Welcome to lesson X").
 *   ASK       — Pose a question expecting a substantive answer.
 *   EXPLAIN   — Deliver content; usually response_kind='continue'/'none'.
 *   PROBE     — Follow-up "why?" / "what changes if…" / clarify question.
 *   HINT      — Nudge after wrong/partial answer.
 *   CHALLENGE — Push the learner with a harder twist or counter-case.
 *   REFLECT   — Pedagogy beat — "what we just learned" / close.
 */
export type MoveType =
  | 'FRAME'
  | 'ASK'
  | 'EXPLAIN'
  | 'PROBE'
  | 'HINT'
  | 'CHALLENGE'
  | 'REFLECT';

/** Runtime-checkable whitelist mirroring MoveType — single source of truth
 *  for `live_message_send`'s enum validation (mcp/server.ts) and the DB-level
 *  CHECK constraint (drizzle/0028_move_type_check.sql). Keep both in sync
 *  with this array by hand; there is no codegen linking the SQL string list
 *  back to this file. */
export const MOVE_TYPES: readonly MoveType[] = [
  'FRAME',
  'ASK',
  'EXPLAIN',
  'PROBE',
  'HINT',
  'CHALLENGE',
  'REFLECT',
] as const;

/**
 * Hub backend enforces these response_kind constraints on move append:
 *   - ASK / PROBE / CHALLENGE  → MUST be 'text' (learner has to answer)
 *   - FRAME / EXPLAIN / HINT   → 'continue' OR 'none' (passive turns)
 *   - REFLECT                  → 'none' (closing beat, no response expected)
 */
export type ResponseKind = 'none' | 'text' | 'continue';

/**
 * Where the response originated. `question` is the learner's anytime
 * follow-up handle for Live Teaching (kept for Hub parity); cross-page
 * free-form questions go through AdHocThread instead now.
 */
export type ResponseInputType =
  | 'text'
  | 'voice_transcript'
  | 'continue'
  | 'question';

/**
 * What this session is anchored to. Stage 7c only uses 'lesson'; future
 * stages add flashcard / trial / mindmap / highlight (parity with Hub).
 */
export type LiveContextType =
  | 'lesson'
  | 'flashcard'
  | 'trial'
  | 'mindmap'
  | 'highlight';

export interface LiveSession {
  id: LiveSessionId;
  pair_id: PairId;
  context_type: LiveContextType;
  context_id: string; // e.g. LessonId stringified
  /** Short preview text (lesson title / flashcard front / etc) for nav lists. */
  context_preview?: string;
  /** Free-form goal; the agent can use this to frame the session. */
  goal?: string;
  status: LiveSessionStatus;
  awaiting_role: AwaitingRole;
  /** Three closing fields written by the agent at complete time. */
  summary?: string;
  teacher_reflection?: string;
  next_action?: string;
  started_at: string;
  ended_at?: string;
  last_activity_at: string;
  /** 下课铃 (二期, 迁移 0042) — 学习者收课宣告时刻 (ISO)。缺省/null =
   *  本场还没人摇铃。唯一写点是 learner 侧 POST /sessions/:id/declare-close
   *  (幂等); complete (MCP live_session_complete / REST POST /complete) 在
   *  状态机 guard 之上多一道门: 未宣告 ⇒ CONFLICT。cancel 不受此门。 */
  learner_close_declared_at?: string;
}

export interface TeachingMove {
  id: TeachingMoveId;
  session_id: LiveSessionId;
  /** Server-assigned sequential number within a session (1, 2, 3, …). */
  seq: number;
  move_type: MoveType;
  content: string;
  response_kind: ResponseKind;
  /** Optional structured payload (e.g. flashcard reveal data, trial inputs). */
  payload?: Record<string, unknown>;
  source_type?: string;
  source_id?: string;
  created_at: string;
}

export interface TeachingResponse {
  id: TeachingResponseId;
  session_id: LiveSessionId;
  move_id: TeachingMoveId;
  /** Client-supplied dedup token (uuid); server upserts on this. */
  client_response_id: string;
  content: string;
  input_type: ResponseInputType;
  created_at: string;
}

/** Combined read result used by LS web Live panel + agent pull. */
export interface LiveSessionFullView {
  session: LiveSession;
  moves: TeachingMove[];
  responses: TeachingResponse[];
  /**
   * 增量读取游标 (Live 场次版, 2026-09-02) — 与 AdHocThreadFullView 的
   * `after_message_id` 同族、同一套 isNewerEventId 全序 (lib/live-wait.ts
   * sliceLiveSessionIncrement)。调用方传 `after_event_id` 时 (MCP
   * `live_session_get` / REST `GET /teaching/sessions/:id?after_event_id=`),
   * moves/responses 只含严格新于该 id 的条目；不传即全量, 这些字段仍照发
   * (全量读下 has_earlier=false、cursor_recognized=true), 所以调用方拿第一
   * 刀全量的 next_after_event_id 就能直接进增量循环。
   *
   * moves 与 responses **共用一个游标**: 两类 id 都是 genId 铸的
   * `${prefix}_${base36 ms}_${rand6}`, 已经在同一条全序上, 不需要两套时钟。
   *
   * `next_after_event_id` = 该场次目前最新一条 move/response 的 id (不是本
   * 次返回里最新的那条) —— 本次返回为空时它原地不动, 下一刀照传即可。
   * 全场没有任何 move/response 且未传游标时为 null。
   */
  returned_moves?: number;
  returned_responses?: number;
  total_moves?: number;
  total_responses?: number;
  has_earlier?: boolean;
  /** false = 传来的游标不属于本场次；服务端退化成全量返回并挂 warning,
   *  不报错也不静默丢内容。 */
  cursor_recognized?: boolean;
  next_after_event_id?: string | null;
}

/**
 * List item for GET /teaching/pairs/:pairId/lesson/:lessonId/sessions
 * (一课多场完课历史). A LiveSession plus its move count: cheap
 * to compute alongside the list query, and enough for a collapsed history
 * row ("date + goal/preview + N moves") without paying for the full
 * moves+responses payload — that still goes through GET /sessions/:id /
 * LiveSessionFullView once a row is expanded.
 */
export interface LiveSessionListItem extends LiveSession {
  move_count: number;
}

// ===========================================================================
// MidLessonSnapshot (Stage 7e, 2026-06-30)
// ===========================================================================
//
// Agent-written checkpoint inside a Live Teaching session. Brief §"Autosave"
// — every 3 turns the agent flushes a rolling summary + current direction
// + weak signals so a compact-recovery can pick up without re-reading every
// move. Lightweight; agent decides cadence + content.

export type MidLessonSnapshotId = string & { readonly __brand: 'MidLessonSnapshotId' };

export interface MidLessonSnapshot {
  id: MidLessonSnapshotId;
  session_id: LiveSessionId;
  /** Move seq at the time of capture (the snapshot covers moves 1..after_turn_n). */
  after_turn_n: number;
  /** What the agent learned about the conversation so far. */
  rolling_summary: string;
  /** What the agent is currently trying to do / the active teaching arc. */
  current_direction: string;
  /** Concept gaps / hesitation patterns / what to probe next. */
  weak_signals: string[];
  created_at: string;
}

// ===========================================================================
// 值更契约全路径暴露 (红队 P0, Live 2.0 二期 W2 件一)
// ===========================================================================
//
// A live agent's duty during an open session is structural, not something
// each response has to re-argue: while a session is non-terminal, the agent
// either blocks the current turn (live_wait / GET /bridge/wait) or hands
// watch duty to a verified wake owner (persistent_watch — a shell watchdog
// like scripts/live-watch.py, or the caller's own harness-native listener).
// Previously this duty only lived in tool *descriptions* (prose an agent can
// skim past); this type puts it in the *response body* of every call that
// touches that duty, so it survives context compaction / a fresh agent
// picking up mid-session without having re-read the skill file.
//
// Stamped verbatim (same field name, `live_runtime_contract`) onto:
//   - live_session_start / live_session_get (MCP) — session-grain: may_end_turn
//     reflects THIS session's own status (terminal → true).
//   - live_wait / GET /bridge/wait, live_pending / GET /bridge/pending — pair-
//     grain (these operate over the whole pair's session set, not one
//     session): may_end_turn reflects whether the pair has ANY active
//     session left (none → true, an active session anywhere → false, since
//     watch duty doesn't end just because the last poll had no fresh event).
/** 语义类别, 非指定工具: live_wait=回合内阻塞等待, persistent_watch=外部常驻看守。
 *  你家 harness 自己的机制达标即归类其一——方法自由, 类别不自由。 */
export type LiveRuntimeWaitMode = 'live_wait' | 'persistent_watch';

/** The three states a LiveSession can rest in — everything else is 'active',
 *  i.e. still under live duty. Exported separately from LiveSessionStatus's
 *  full union so `terminal_states` on the wire is exactly this set, not
 *  hand-typed at each call site. */
export const LIVE_RUNTIME_TERMINAL_STATES: readonly LiveSessionStatus[] = [
  'completed',
  'cancelled',
  'expired',
];

export interface LiveRuntimeContract {
  /** Fixed literal — the duty itself never varies by call site. */
  duty_requirement: 'block_current_turn_or_verified_wake_owner';
  /** true only when the terminal condition this response is reporting on has
   *  actually been reached (session-grain: this session is terminal;
   *  pair-grain: no active session remains for the pair). false means the
   *  duty above is still live — do not silently end the turn. */
  may_end_turn: boolean;
  allowed_wait_modes: LiveRuntimeWaitMode[];
  /** Reserved for a future "who's holding watch duty right now" handle
   *  (e.g. a registered watchdog process id) — always null today; no
   *  wake-owner registry exists yet. */
  wake_owner: null;
  terminal_states: LiveSessionStatus[];
}

// (token 压缩, 2026-07) — 值更契约的教义版本号协议。
//
// LiveRuntimeContract 里除 may_end_turn 外的每个字段都是进程级常量(教义),
// 每次 live_wait 超时都整段重发是纯重复。contract_version 是教义部分
// (may_end_turn 剔除后) 的 canonical-JSON sha256 前 12 位 hex
// (apps/server/src/lib/live-contract.ts liveRuntimeContractVersion),
// 随 live_runtime_contract 一起盖在每个附带该合约的返回体上。
// live_wait / GET /bridge/wait 的调用方把它作为 known_contract_version 传回:
// 与现行版一致 ⇒ 响应只带 contract_version + 顶层 may_end_turn (may_end_turn
// 是逐次现算的状态, 不是教义, 永不省略 — 无损红线③); 缺省或过期 ⇒ 完整
// 合约体照旧 (首次完整①)。

/**
 * (件三, live 事件瘦身) — bridge wait/pending 事件与 pending item
 * 随行的 session 摘要。原先整行 LiveSession (含 summary / teacher_reflection /
 * next_action / context_preview / 各时间戳) 逐事件重发, 而这些字段对"这个
 * 事件该怎么处理"几乎恒定不变; 全量状态恢复本来就归 live_session_get
 * (session + 全部 moves + 全部 responses)。留下的是逐事件真正用得上的定位
 * 字段 (scripts/live-watch.py 的摘要行也只读这几个: context_type / context_id /
 * goal / id)。
 */
export type LiveSessionStub = Pick<
  LiveSession,
  | 'id'
  | 'context_type'
  | 'context_id'
  | 'goal'
  | 'status'
  | 'awaiting_role'
  // 下课铃 (二期) — 逐事件/逐 pending item 随行"这场是否已被学习者
  // 宣告收课", agent 不必回读全量 session 就知道该走收官流程。可选字段,
  // 旧 stub 构造点 (含 apps/web MockRepository) 不带它也仍然类型合法。
  | 'learner_close_declared_at'
>;

// ===========================================================================
// Bridge protocol (Stage 7d, 2026-06-30)
// ===========================================================================
//
// Agent end of the bridge polls these endpoints. SSE/WebSocket can be
// layered later; the polling contract stays as the durable baseline.

/**
 * Agent → server keep-alive. While ttl_seconds hasn't elapsed since the
 * last heartbeat, the pair's bridge counts as `online`. New LiveSessions
 * created during this window go into the pending queue immediately;
 * sessions created while offline are queued and surface as soon as the
 * agent re-heartbeats.
 *
 * 指示灯全拆 (2026-07-24): `context_status` 上报与服务端等级计算
 * (green/yellow/red/stale/unknown 的 BridgeContextLevel/BridgeContextView/
 * BridgeContextReport 一族) 已整体退役——灯从未被真实供电, 拆整灯不留半截。
 * bridge_states 的 context_* 数据列留存但代码不再读写。
 */
export interface BridgeHeartbeatInput {
  pair_id: PairId;
  /** seconds the bridge stays "online" after this heartbeat (default 60). */
  ttl_seconds?: number;
}

export interface BridgeStatus {
  pair_id: PairId;
  online: boolean;
  /** ISO. null if never heartbeated. */
  last_heartbeat_at: string | null;
  /** ISO. null if offline. */
  online_until: string | null;
}

/**
 * What agent gets when polling pending. Two channels feed pending:
 *   - Live Teaching: a LiveSession with awaiting_role='agent'
 *   - Ad Hoc: an AdHocThread with an unanswered user message
 *
 * Items are sorted by reason priority:
 *   1. adhoc_message      (highest — free-form, interrupts current flow)
 *   2. live_session_start (new lesson session, owes FRAME)
 *   3. live_response      (lesson learner submitted, owes next move)
 *
 * Within the same priority, oldest first.
 *
 * BridgePendingItem is a discriminated union keyed on `channel`. Live
 * Teaching items carry session+latest_response; Ad Hoc items carry
 * thread+latest_message (full types in adhoc.ts).
 */
export type BridgePendingReason =
  | 'adhoc_message'
  | 'live_session_start'
  | 'live_response';

export type BridgePendingChannel = 'live_teaching' | 'adhoc';

/**
 * 分工显性化 (Live 2.0 二期 W2 件三) — machine-readable label for
 * *why* a live_teaching pending item's awaiting_role is 'agent'. Distinct
 * from `reason` above (which only distinguishes "no moves yet" from
 * "moves exist"): `pending_reason` further splits the "moves exist" case by
 * *whose* action put awaiting_role back on the agent, per the
 * nextAwaitingForMove state machine (routes/teaching.ts / mcp/server.ts
 * live_message_send) — response_kind='text'/'continue' only flips back to
 * 'agent' once the learner submits a response; response_kind='none' flips
 * back immediately, purely from the agent's own last move.
 *   - session_start: no moves yet — agent owes the opening FRAME.
 *   - learner_response_waiting: moves exist and the latest one expects a
 *     reply — awaiting_role is 'agent' only because the learner already
 *     answered it. computeBridgeWaitEvents' `live_response` event covers
 *     this case (lib/live-wait.ts).
 *   - agent_owes_move: moves exist and the latest one's response_kind is
 *     'none' — awaiting_role flipped back to 'agent' by the agent's own
 *     move, no learner action involved (e.g. a multi-part EXPLAIN spread
 *     across several move calls). computeBridgeWaitEvents produces NO event
 *     for this case (lib/live-wait.ts header: "a live session that is
 *     awaiting the AGENT (moves exist, no response yet) produces no event
 *     at all") — this class only ever surfaces here, in the pending
 *     snapshot, never in the wait event stream.
 */
export type PendingReason = 'session_start' | 'learner_response_waiting' | 'agent_owes_move';

export interface BridgePendingItemLive {
  channel: 'live_teaching';
  reason: 'live_session_start' | 'live_response';
  session_id: LiveSessionId;
  /** (件三) — was the full LiveSession row; slimmed to the stub.
   *  Full session state (summary/reflection/timestamps + moves + responses)
   *  stays reachable via live_session_get / GET /sessions/:id. */
  session: LiveSessionStub;
  latest_response?: TeachingResponse;
  queued_at: string;
  /** 软牌 — only stamped when reason === 'live_session_start': a fresh
   *  session's first move should be FRAME. Advisory, not enforced. */
  next_expected?: 'FRAME';
  /** (件三) — always stamped on every live_teaching pending item;
   *  see PendingReason's doc comment for the three-value mapping. */
  pending_reason: PendingReason;
}

/**
 * Ad Hoc pending items are emitted alongside Live Teaching ones; the
 * full message type lives in adhoc.ts. We use `unknown` here to avoid
 * a cyclic import, callers can refine via the adhoc.ts types.
 */
export interface BridgePendingItemAdHoc {
  channel: 'adhoc';
  reason: 'adhoc_message';
  thread_id: string;
  latest_message: unknown; // AdHocMessage — see adhoc.ts
  queued_at: string;
}

export type BridgePendingItem = BridgePendingItemLive | BridgePendingItemAdHoc;

export interface BridgePendingResponse {
  bridge: BridgeStatus;
  items: BridgePendingItem[];
  /** 值更契约全路径暴露 (件一) — bridge-grain: may_end_turn 按"该 pair 是否
   *  存在 active 会话"判定, 不是按单个 item。可选而非必填: 领地边界不碰
   *  apps/web (含它的 MockRepository 测试替身), 真实服务端两处返回体
   *  (mcp/server.ts live_pending / routes/teaching.ts GET /bridge/pending)
   *  仍会逐字盖上这个字段, 只是类型层不逼着每个已存在的实现者立刻补齐。 */
  live_runtime_contract?: LiveRuntimeContract;
  /** 教义版本号, 见 LiveRuntimeContract 上方的协议注释。可选,
   *  同 live_runtime_contract 的领地边界理由。 */
  contract_version?: string;
}

/** Lesson-context helper: re-export LessonId for caller convenience. */
export type { LessonId };
