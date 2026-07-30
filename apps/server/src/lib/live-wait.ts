// Shared "wait for the next Live Teaching / AdHoc event" core — extracted
// from routes/teaching.ts's GET /bridge/wait (2026-07, event-ification:
// push the wait from the model layer down to a shell watchdog) so the MCP
// tool `live_wait` (mcp/server.ts) can block on exactly the same
// logic instead of forking a second, driftable copy. HTTP route and MCP tool
// are the two consumers; both call `waitForBridgeEvents` below.
//
// Protocol name: this (pair_id, consumer_id) delivery-cursor
// scheme is what apps/server/scripts/live-watch.py's startup banner reports
// as protocol_version=bridge-cursor/1 — bump that string's suffix in lockstep
// with any wire-incompatible change made here (e.g. a new since-token shape).
//
// Cursor design ("since"):
// Every pending item has a natural "qualifying event" — the thing whose
// appearance is what makes the item pending — and that event already has a
// globally-unique text id minted by genId() elsewhere (mcp/server.ts,
// routes/teaching.ts): `${prefix}_${Date.now().toString(36)}_${rand6}`. We
// reuse those ids directly as the cursor instead of inventing a parallel
// sequence:
//   - live_session_start → the LiveSession's own id (session.id)
//   - live_response      → the TeachingResponse id (latest_response.id)
//   - adhoc_message      → the AdHocMessage id (latest_message.id)
// A caller's `since` is simply the largest event_id it has already consumed
// from a previous wait/pending call ('' means "no cursor — anything counts
// as new").
//
// These ids are NOT safely comparable as plain strings across the three
// prefixes ("ah_..." < "ls_..." < "tr_..." by first-character alone,
// independent of when either was actually created) so a naive
// `candidateId > since` would be wrong. Instead isNewerEventId() below strips
// each id down to its embedded creation timestamp (the base36 segment) and
// compares that first, falling back to full-string comparison only to break
// an exact-millisecond tie. This gives one consistent total order across the
// three independent id spaces without adding a shared DB sequence column.
//
// Known edge case (accepted at this scale, not fixed here): two qualifying
// events minted in the exact same millisecond fall back to plain string
// tiebreak, which does not necessarily preserve true creation order — a
// later event with a lexicographically smaller random suffix could then
// compare as "already seen" and be silently skipped on the next poll. At
// this app's single-learner, human-paced scale (requests are separate
// awaited HTTP round trips, not a tight insert batch) two DB writes landing
// in the same millisecond is not realistically reachable, so this is a
// documented tradeoff, not a bug fix TODO.
//
// Upgrade path noted for real concurrency: replace the polling loop below
// with Postgres LISTEN/NOTIFY (trigger a NOTIFY on insert into
// teaching_responses / teaching_moves / ad_hoc_messages, LISTEN here and
// resolve the long-poll promise on notification instead of sleeping). At
// single-machine/self-use scale a 1.5s poll interval is simpler and plenty
// fast, so that's what's implemented — NOTIFY is future work if this ever
// needs multi-tenant or high-frequency traffic.
//
// SCOPE OF THE "replay = current state" claim (验收判词 2026-07-18, 免责说明):
// computeBridgeWaitEvents reports each stream's LATEST qualifying item — it is
// a delivery channel for "something new happened", NOT a lossless event log.
// Two known consequences: (a) an adhoc thread with several unreplied user
// messages surfaces only the newest one — consumers must re-read the thread
// (GET /threads/:id), never rely solely on the embedded latest_message; (b) a
// live session that is awaiting the AGENT (moves exist, no response yet)
// produces no event at all — "you owe a move" reminders are live_pending's
// job, not this channel's. Nothing is ever lost from STORAGE (full session /
// thread history stays readable); what the cursor guarantees is at-least-once
// delivery of "state changed", with the DB as the source of truth for what
// the state actually is.

import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  live_sessions,
  teaching_moves,
  teaching_responses,
  ad_hoc_threads,
  ad_hoc_messages,
  bridge_delivery_cursors,
} from '../db/schema';
import type {
  AwaitingRole,
  LiveSession,
  LiveSessionStub,
  PendingReason,
  TeachingResponse,
} from '@learn-shell/contracts';
import { toLiveSessionStub } from './live-contract';

/** Extract the embedded creation-order timestamp from a genId()'d id. */
export function idTimestamp(id: string): number {
  const parts = id.split('_');
  const tsSegment = parts.length >= 2 ? parts[1] : undefined;
  const ts = tsSegment ? parseInt(tsSegment, 36) : NaN;
  return Number.isFinite(ts) ? ts : 0;
}

/** True if `candidateId` is newer than `since` (or since is unset/empty). */
export function isNewerEventId(candidateId: string, since: string): boolean {
  if (!since) return true;
  const ct = idTimestamp(candidateId);
  const st = idTimestamp(since);
  if (ct !== st) return ct > st;
  return candidateId > since;
}

/** 消账游标判定 (AdHoc 三票并一之三, 2026-07-19) — shared by every "does this
 *  adhoc thread still have an outstanding user message" scan so the ack
 *  cursor semantics live in exactly one place instead of drifting across
 *  independent copies:
 *    - computeBridgeWaitEvents below (→ live_wait MCP tool + GET /bridge/wait)
 *    - live_pending MCP tool's own scan (mcp/server.ts)
 *    - GET /bridge/pending's own scan (routes/teaching.ts)
 *  A thread's trailing user message counts as outstanding unless it has been
 *  acked away — i.e. unless `acked_message_id` is set and is at least as new
 *  as `lastMessageId`. Reuses isNewerEventId's cross-prefix total order
 *  (same "ah_" / "ahm_" prefixed id spaces already compared for the
 *  bridge-wait cursor) rather than a second comparison scheme. lib/teacher-inbox.ts's adhoc
 *  section has a genuinely different shape (per-message "already answered"
 *  scan, not "latest message only") so it calls isNewerEventId directly on
 *  each candidate message against the same acked_message_id field instead of
 *  going through this helper — see its header comment for why. */
export function isAdhocMessageOutstanding(
  ackedMessageId: string | null | undefined,
  lastMessageId: string
): boolean {
  if (!ackedMessageId) return true;
  return isNewerEventId(lastMessageId, ackedMessageId);
}

export interface BridgeWaitEvent {
  channel: 'live_teaching' | 'adhoc';
  reason: 'live_session_start' | 'live_response' | 'adhoc_message' | 'live_close_declared';
  event_id: string;
  queued_at: string;
  session_id?: LiveSession['id'];
  /** (件三) — was the full LiveSession row, slimmed to the stub;
   *  full state recovery is live_session_get / GET /sessions/:id's job.
   *  (scripts/live-watch.py's summary lines read only stub fields:
   *  id/context_type/context_id/goal.) */
  session?: LiveSessionStub;
  /** (件三) — 逐事件顶层随行 (computeBridgeWaitEvents 只产
   *  awaiting_role='agent' 的会话事件, 但字段照发, 不让消费方去猜)。 */
  awaiting_role?: AwaitingRole;
  latest_response?: TeachingResponse;
  thread_id?: string;
  latest_message?: unknown;
  /** 下课铃 (二期) — 仅 reason='live_close_declared' 事件随行:
   *  学习者按铃的时刻 (ISO)。stub 里同名字段同值, 顶层重复一份是为了
   *  消费方不用钻 stub 就能拿到"何时按的"。 */
  learner_close_declared_at?: string;
}

// Same shape of query as /bridge/pending's "Live Teaching pending" + "Ad Hoc
// pending" sections, reframed as a flat list of events each carrying the
// event_id the wait cursor compares against. Deliberately not sharing code
// with /bridge/pending's handler — that endpoint's response contract
// (BridgePendingResponse / BridgePendingItem) has no event_id field, and
// this shape is intentionally separate ({events, timeout}) rather than
// {bridge, items}.
export async function computeBridgeWaitEvents(pair_id: string): Promise<BridgeWaitEvent[]> {
  const events: BridgeWaitEvent[] = [];

  const awaitingSessions = await db
    .select()
    .from(live_sessions)
    .where(
      and(
        eq(live_sessions.pair_id, pair_id),
        eq(live_sessions.status, 'active'),
        eq(live_sessions.awaiting_role, 'agent')
      )
    )
    .orderBy(asc(live_sessions.last_activity_at));

  for (const sess of awaitingSessions) {
    const [latestResp] = await db
      .select()
      .from(teaching_responses)
      .where(eq(teaching_responses.session_id, sess.id))
      .orderBy(desc(teaching_responses.created_at))
      .limit(1);

    const [moveCountRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(teaching_moves)
      .where(eq(teaching_moves.session_id, sess.id));
    const moveCount = Number(moveCountRow?.n ?? 0);

    if (moveCount === 0) {
      // Fresh session, no moves yet — the qualifying event is session
      // creation itself.
      events.push({
        channel: 'live_teaching',
        reason: 'live_session_start',
        event_id: sess.id,
        session_id: sess.id as unknown as LiveSession['id'],
        session: toLiveSessionStub(sess),
        awaiting_role: sess.awaiting_role,
        queued_at: sess.last_activity_at.toISOString(),
      });
    } else if (latestResp) {
      events.push({
        channel: 'live_teaching',
        reason: 'live_response',
        event_id: latestResp.id,
        session_id: sess.id as unknown as LiveSession['id'],
        session: toLiveSessionStub(sess),
        awaiting_role: sess.awaiting_role,
        latest_response: latestResp as unknown as TeachingResponse,
        queued_at: latestResp.created_at.toISOString(),
      });
    }
  }

  // 下课铃 (二期) — 学习者已宣告收课、老师还没合幕的 active 场,
  // 每一场产一个 live_close_declared 事件。不看 awaiting_role: 铃是学习者的
  // 主权动作, 不因"这一拍轮到谁说话"而隐身 (declare-close 落笔时也会把
  // awaiting 翻回 agent, 这里的无条件扫描是它的兜底面)。event_id 从
  // declared_at 时刻派生 (`lcd_${ts36}_${session_id}`): 确定性 —— 同一场铃
  // 每次扫描产同一个 id, 游标 ack 过一次就不再重复送达; parts[1] 是 base36
  // 时间戳段, 与 idTimestamp/isNewerEventId 的跨前缀全序天然兼容。
  const closeDeclaredSessions = await db
    .select()
    .from(live_sessions)
    .where(
      and(
        eq(live_sessions.pair_id, pair_id),
        eq(live_sessions.status, 'active'),
        isNotNull(live_sessions.learner_close_declared_at)
      )
    )
    .orderBy(asc(live_sessions.learner_close_declared_at));
  for (const sess of closeDeclaredSessions) {
    const declaredAt = sess.learner_close_declared_at;
    if (!declaredAt) continue; // isNotNull 已滤, 纯类型收窄
    events.push({
      channel: 'live_teaching',
      reason: 'live_close_declared',
      event_id: `lcd_${declaredAt.getTime().toString(36)}_${sess.id}`,
      session_id: sess.id as unknown as LiveSession['id'],
      session: toLiveSessionStub(sess),
      awaiting_role: sess.awaiting_role,
      learner_close_declared_at: declaredAt.toISOString(),
      queued_at: declaredAt.toISOString(),
    });
  }

  const threads = await db
    .select()
    .from(ad_hoc_threads)
    .where(eq(ad_hoc_threads.pair_id, pair_id));
  for (const th of threads) {
    const [last] = await db
      .select()
      .from(ad_hoc_messages)
      .where(eq(ad_hoc_messages.thread_id, th.id))
      .orderBy(desc(ad_hoc_messages.created_at))
      .limit(1);
    if (!last || last.role !== 'user') continue;
    if (!isAdhocMessageOutstanding(th.acked_message_id, last.id)) continue;
    events.push({
      channel: 'adhoc',
      reason: 'adhoc_message',
      event_id: last.id,
      thread_id: th.id,
      latest_message: last,
      queued_at: last.created_at.toISOString(),
    });
  }

  // Same priority as /bridge/pending: adhoc_message beats live_session_start
  // beats live_response; oldest first within a priority tier.
  // live_close_declared (二期) 插在 live_response 之前 —— 铃响意味着
  // 该走收官流程了, 排在普通回应之前不淹没。
  const priority: Record<string, number> = {
    adhoc_message: 0,
    live_session_start: 1,
    live_close_declared: 2,
    live_response: 3,
  };
  events.sort((a, b) => {
    const pa = priority[a.reason] ?? 99;
    const pb = priority[b.reason] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.queued_at.localeCompare(b.queued_at);
  });

  return events;
}

// ============================================================================
// pending_reason 分工标签 (Live 2.0 二期 W2 件三) — 补上面
// computeBridgeWaitEvents 头注早就记下的性质 ("a live session that is
// awaiting the AGENT (moves exist, no response yet) produces no event at
// all — 'you owe a move' reminders are live_pending's job, not this
// channel's") 的机器可见面：live_pending (mcp/server.ts) / GET /bridge/pending
// (routes/teaching.ts) 给每个 live_teaching pending item 盖这个章，把"欠的
// move 是谁的债"从头注里的散文变成字段。
// ============================================================================

/** 三值判定，读 nextAwaitingForMove 的状态机现状定的映射 (不是新发明一套
 *  规则)：response_kind='text'/'continue' 的 move 先把 awaiting 转给
 *  learner，只有学习者交了 response 才转回 'agent' —— 这类 awaiting='agent'
 *  一定是"学习者的回应在等你", 即 learner_response_waiting。
 *  response_kind='none' 的 move 自己就把 awaiting 转回 'agent'，与学习者
 *  无关 (比如一段 EXPLAIN 分几条 move 铺开) —— 这类是 agent_owes_move，
 *  且正是 computeBridgeWaitEvents 头注说"不产事件"的那类，只在这里的
 *  pending 快照现身。moveCount===0 (还没有任何 move) 时两者都不适用，
 *  是最原始的 session_start。 */
export function classifyPendingReason(
  moveCount: number,
  latestMoveResponseKind: 'none' | 'text' | 'continue' | undefined
): PendingReason {
  if (moveCount === 0) return 'session_start';
  return latestMoveResponseKind === 'none' ? 'agent_owes_move' : 'learner_response_waiting';
}

export const BRIDGE_WAIT_POLL_MS = 1500; // single-machine self-use scale — see NOTIFY note above

export interface BridgeWaitResult {
  events: BridgeWaitEvent[];
  timeout: boolean;
}

/** Core blocking wait, shared by GET /bridge/wait (routes/teaching.ts) and
 *  the MCP tool `live_wait` (mcp/server.ts). Polls computeBridgeWaitEvents
 *  until a fresh (isNewerEventId) event shows up or `timeoutS` elapses.
 *  Callers clamp `timeoutS` to their own ceiling before calling in (HTTP:
 *  55s, proxy layers commonly cut idle conns at 60s; MCP: 50s, leaving the
 *  MCP client's own call-timeout some margin) — this function does not
 *  impose one itself so it stays a plain shared primitive, not another place
 *  the two ceilings could drift apart. */
export async function waitForBridgeEvents(
  pairId: string,
  since: string,
  timeoutS: number,
  pollMs: number = BRIDGE_WAIT_POLL_MS
): Promise<BridgeWaitResult> {
  const deadline = Date.now() + timeoutS * 1000;

  // Server-side poll-and-block loop. Single-machine scale (see header
  // comment) — no LISTEN/NOTIFY needed yet.
  while (true) {
    const events = await computeBridgeWaitEvents(pairId);
    const fresh = events.filter((e) => isNewerEventId(e.event_id, since));
    if (fresh.length > 0) {
      return { events: fresh, timeout: false };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { events: [], timeout: true };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)));
  }
}

// ============================================================================
// Live 2.0 — server-side delivery cursor (0029_bridge_delivery_cursors).
//
// Persistence layer only; deliberately kept separate from waitForBridgeEvents
// above (which stays a pure "wait for events after `since`" primitive with no
// DB writes of its own). Only a caller that supplies a `consumer_id` opts
// into this — see routes/teaching.ts's GET /bridge/wait for the call-site
// wiring and the compat argument (no consumer_id → this file is never
// touched → old callers see zero behavior change).
//
// Ack model ("先送达后推进"): a wait call's `since` query param, when a
// consumer_id also came along, is treated as "everything up to and
// including `since` has been processed" and is upserted into this table
// *before* the (possibly long) wait begins — so the ack is durable
// regardless of how the subsequent wait resolves (event / timeout / dropped
// connection). Delivery itself never writes here: computeBridgeWaitEvents
// only ever reports each session/thread's *current latest* item (the
// awaiting_role state machine guarantees at most one pending item per
// session at a time), so replaying from an old, not-yet-advanced cursor
// naturally reconstructs exactly what a consumer missed — there is no
// separate append-only log to expire, so "replay from any cursor within a
// retention window" (invariant 4) is satisfied by construction rather than
// by a TTL/prune policy.
// ============================================================================

function genCursorId(): string {
  return `cur_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Read this consumer's persisted cursor. Returns '' if it has never acked
 *  anything (brand-new consumer_id, or a race before its first ack lands) —
 *  '' is exactly waitForBridgeEvents' own "no cursor, anything counts as
 *  new" sentinel, so callers can pass this straight through unchanged. */
export async function getPersistedCursor(pairId: string, consumerId: string): Promise<string> {
  const [row] = await db
    .select({ cursor_event_id: bridge_delivery_cursors.cursor_event_id })
    .from(bridge_delivery_cursors)
    .where(
      and(
        eq(bridge_delivery_cursors.pair_id, pairId),
        eq(bridge_delivery_cursors.consumer_id, consumerId)
      )
    )
    .limit(1);
  return row?.cursor_event_id ?? '';
}

/** Upsert this consumer's cursor — the implicit ack described above. Safe to
 *  call with an empty string (a consumer explicitly resetting to "from the
 *  beginning"); it still counts as a real ack of "I have processed nothing
 *  yet, start me over," not a no-op. */
export async function upsertPersistedCursor(
  pairId: string,
  consumerId: string,
  cursorEventId: string
): Promise<void> {
  const now = new Date();
  await db
    .insert(bridge_delivery_cursors)
    .values({
      id: genCursorId(),
      pair_id: pairId,
      consumer_id: consumerId,
      cursor_event_id: cursorEventId,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [bridge_delivery_cursors.pair_id, bridge_delivery_cursors.consumer_id],
      set: { cursor_event_id: cursorEventId, updated_at: now },
    });
}

/** Resolves the effective `since` cursor for one /bridge/wait call given
 *  whatever combination of consumer_id / since the caller sent, and performs
 *  the implicit-ack write when appropriate. Kept as one function (rather
 *  than leaving this branching in the route handler) so the HTTP route and
 *  any future second consumer of the persisted-cursor path share identical
 *  semantics instead of two hand-rolled copies drifting apart — same
 *  motivation as waitForBridgeEvents itself being extracted out from under
 *  the route.
 *
 *  - no consumer_id                → legacy path, untouched: `sinceParam` as
 *    given (undefined treated as '').
 *  - consumer_id + sinceParam given → explicit ack: persist it, then wait
 *    from that same value.
 *  - consumer_id, sinceParam absent → resume: read the persisted cursor
 *    (empty for a brand-new consumer_id) and wait from there. */
export async function resolveWaitSince(
  pairId: string,
  consumerId: string | undefined,
  sinceParam: string | undefined
): Promise<string> {
  if (!consumerId) return sinceParam ?? '';
  if (sinceParam !== undefined) {
    await upsertPersistedCursor(pairId, consumerId, sinceParam);
    return sinceParam;
  }
  return getPersistedCursor(pairId, consumerId);
}

// ============================================================================
// Live 2.0 — 轮询牙齿 (Goal B). live_pending is a snapshot read, not a wait;
// a model-layer agent calling it in a spin loop instead of blocking on
// live_wait / scripts/live-watch.py is exactly the failure mode the six
// 军规 exist to prevent, and a description-only warning doesn't stop a
// mediocre agent from doing it anyway. This is the actual gate: an in-memory
// sliding window per pair_id of *empty* live_pending calls (calls that found
// nothing pending) — real data always resets it (see hadRealItems below), so
// this can never eat a legitimate pending item.
//
// In-memory only (module-level Map, no persistence) — a process restart
// resetting the count is an acceptable false-negative at this app's single-
// process, self-use scale (explicitly allowed by the brief: "内存滑窗即可,
// 不必持久化").
// ============================================================================

export const PENDING_POLL_WINDOW_MS = 90_000;
export const PENDING_POLL_WARN_THRESHOLD = 6;
export const PENDING_POLL_BLOCK_THRESHOLD = PENDING_POLL_WARN_THRESHOLD * 2; // 12

const pendingEmptyCallLog = new Map<string, number[]>();

export const POLL_GUARD_MESSAGE =
  "Value-billing contract red line: model-layer polling is forbidden — you're repeatedly calling live_pending and coming up empty, " +
  "burning her money every round while she has no idea it's happening. " +
  'For value-billing, hang on live_wait (blocking wait, zero busy-spin) or the background watchdog script scripts/live-watch.py, or your own harness\'s listening mechanism.';

export interface PendingPollGateResult {
  action: 'allow' | 'warn' | 'block';
  empty_streak: number;
  window_s: number;
  warn_threshold: number;
  block_threshold: number;
}

/** Call once per live_pending invocation, after computing whether this call
 *  actually found anything (`hadRealItems`). Real items always reset the
 *  streak and return 'allow' — the gate only ever fires on a run of empty
 *  calls, never on legitimate traffic ("不许因牙齿吞数据"). */
export function checkPendingPollGate(pairId: string, hadRealItems: boolean): PendingPollGateResult {
  const base = {
    window_s: PENDING_POLL_WINDOW_MS / 1000,
    warn_threshold: PENDING_POLL_WARN_THRESHOLD,
    block_threshold: PENDING_POLL_BLOCK_THRESHOLD,
  };
  if (hadRealItems) {
    pendingEmptyCallLog.delete(pairId);
    return { action: 'allow', empty_streak: 0, ...base };
  }
  const now = Date.now();
  const kept = (pendingEmptyCallLog.get(pairId) ?? []).filter(
    (t) => now - t < PENDING_POLL_WINDOW_MS
  );
  kept.push(now);
  pendingEmptyCallLog.set(pairId, kept);
  const streak = kept.length;
  if (streak >= PENDING_POLL_BLOCK_THRESHOLD) {
    return { action: 'block', empty_streak: streak, ...base };
  }
  if (streak >= PENDING_POLL_WARN_THRESHOLD) {
    return { action: 'warn', empty_streak: streak, ...base };
  }
  return { action: 'allow', empty_streak: streak, ...base };
}

/** Test-only escape hatch — the module-level Map above has no other way to
 *  reset between unit tests. */
export function __resetPendingPollGateForTests(): void {
  pendingEmptyCallLog.clear();
}
