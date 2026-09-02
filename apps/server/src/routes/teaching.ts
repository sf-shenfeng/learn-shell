// Hono REST routes — Live Teaching (Stage 7d, 2026-06-30).
//
// Sister file to read.ts / write.ts. Lives in its own file because the
// LiveSession turn loop, awaiting_role state machine, and bridge keep-alive
// share helpers that only this module needs.
//
// Endpoints (all mounted under /api/teaching/*):
//   POST   /sessions                      learner: create LiveSession
//   GET    /sessions/:id                  full view (session + moves + responses;
//                                          ?after_event_id= for incremental read)
//   POST   /sessions/:id/cancel           learner / system: terminate
//   POST   /sessions/:id/complete         agent: write REFLECT triple + close
//   POST   /sessions/:id/responses        learner: submit response (idempotent)
//   POST   /sessions/:id/moves            agent: append next move
//   POST   /bridge/heartbeat              agent: keep-alive
//   GET    /bridge/pending                agent: poll pending queue (snapshot, no wait)
//   GET    /bridge/wait                   agent: long-poll — blocks until a new pending
//                                          event appears or timeout_s elapses (2026-07-17,
//                                          event-ification: push the wait from the
//                                          model layer down to a shell watchdog; 2026-07-18,
//                                          optional consumer_id= for a server-persisted
//                                          delivery cursor + timeout_s now accepts up to 300s)
//
// awaiting_role state machine (Hub-aligned, see packages/contracts/src/teaching.ts):
//   create session                                  → 'agent'  (agent owes FRAME)
//   append move (any layer)                         → 'learner' unless terminal
//   append move w/ move_type=REFLECT, rk='none'     → 'none'   (terminal; pair w/ complete)
//   submit response                                 → 'agent'
//   complete / cancel                               → 'none'

import { Hono } from 'hono';
import { and, asc, eq, inArray, sql, desc } from 'drizzle-orm';
import { db } from '../db/client';
import {
  waitForBridgeEvents,
  resolveWaitSince,
  isAdhocMessageOutstanding,
  classifyPendingReason,
  sliceLiveSessionIncrement,
} from '../lib/live-wait';
import {
  buildLiveRuntimeContract,
  buildContractStamp,
  liveRuntimeContractVersion,
  toLiveSessionStub,
  pairHasActiveLiveSession,
  findActiveLiveSessionForContext,
} from '../lib/live-contract';
import { evaluateLiveTransition } from '../lib/live-session-transitions';
import { evaluateCloseDeclarationGate } from '../lib/learner-close-declaration';
import { appendSessionEvent } from '../lib/session-events';
import {
  live_sessions,
  teaching_moves,
  teaching_responses,
  bridge_states,
  ad_hoc_threads,
  ad_hoc_messages,
  mid_lesson_snapshots,
  live_session_evaluations,
} from '../db/schema';
import type {
  AwaitingRole,
  BridgePendingItem,
  LiveContextType,
  LiveSession,
  LiveSessionListItem,
  LiveSessionStatus,
  MidLessonSnapshot,
  MoveType,
  ResponseInputType,
  ResponseKind,
  TeachingMove,
  TeachingResponse,
} from '@learn-shell/contracts';

const t = new Hono();

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nextAwaitingForMove(move_type: MoveType, response_kind: ResponseKind): AwaitingRole {
  if (move_type === 'REFLECT' && response_kind === 'none') return 'none';
  if (response_kind === 'none') return 'agent';
  return 'learner';
}

// ============================================================================
// Sessions
// ============================================================================

// POST /api/teaching/sessions — 学习者侧入口已于 2026-07-20 退役 (学习者裁决:
// web 的 Start Session 按钮整体退役, 开课收敛到老师一侧的 MCP
// live_session_start, 见 apps/web/src/pages/Lesson.tsx 的召唤卡改动)。这条
// 路由保留供测试/未来场景, 不再有 web 调用方 —— 开课正门是 MCP
// live_session_start。
//
// 开课原子去重 (红队第六轮针一) — 与 MCP 入口同语义: 插入前先查一遍同
// (pair, context_type, context_id) 的 active 会话 (findActiveLiveSessionFor
// Context, 两个入口共用同一份查询), 有则直接送进既有会话 (joined_existing:
// true), 不开第二间；插入撞上迁移 0036 的部分唯一索引 (23505) 时回查一遍再
// 返回, 同 MCP 入口的 catch 形态。REST 侧字段与 MCP 回执同形: 响应体在会话
// 字段之外附 `joined_existing` + `human_note` 两个字段。
t.post('/sessions', async (c) => {
  const input = await c.req.json<{
    pair_id: string;
    context_type: LiveContextType;
    context_id: string;
    context_preview?: string;
    goal?: string;
  }>();

  const joinedResponse = (existing: LiveSession) =>
    c.json(
      {
        ...existing,
        joined_existing: true,
        human_note: `This room is already open — routing you into it (session ${existing.id}, context_type=${existing.context_type}).`,
      },
      200
    );

  const existing = await findActiveLiveSessionForContext(input.pair_id, input.context_type, input.context_id);
  if (existing) return joinedResponse(existing as unknown as LiveSession);

  const id = genId('ls');
  const now = new Date();
  try {
    const [row] = await db
      .insert(live_sessions)
      .values({
        id,
        pair_id: input.pair_id,
        context_type: input.context_type,
        context_id: input.context_id,
        context_preview: input.context_preview,
        goal: input.goal,
        status: 'active',
        awaiting_role: 'agent',
        started_at: now,
        last_activity_at: now,
      })
      .returning();
    return c.json({ ...(row as unknown as LiveSession), joined_existing: false, human_note: `Started session ${id}` }, 201);
  } catch (e) {
    // 兜底路径: 上面那次查询之后、这次 insert 之前, 另一侧抢先开成了同一间
    // 教室 —— 部分唯一索引拦下这次写, postgres-js 抛 23505 (dbCode 直接挂在
    // e.code 上, 同 lib/tool-envelope.ts classifyThrown 的既定读法)。回查
    // 既有行, 当成功返回, 不让这个异常冒泡成一次 500。
    if ((e as { code?: unknown } | null | undefined)?.code === '23505') {
      const raced = await findActiveLiveSessionForContext(input.pair_id, input.context_type, input.context_id);
      if (raced) return joinedResponse(raced as unknown as LiveSession);
    }
    throw e;
  }
});

// GET /api/teaching/sessions/:id — full view
// ?after_event_id=<id> — 增量读 (值更契约·低损耗 · Live 场次版, 2026-09-02):
// 只返回新于该 id 的 move/response, 走 MCP 工具 live_session_get 同一个
// sliceLiveSessionIncrement (lib/live-wait.ts 的 isNewerEventId 全序)。缺省
// =全量 (冷启动/断线恢复), 且与本参数存在之前逐字节相同——web 端不传, 行为
// 不变。REST/MCP 两兄弟的游标语义按 adhoc 的先例保持同步, 别让它们漂开。
t.get('/sessions/:id', async (c) => {
  const id = c.req.param('id');
  const afterEventId = c.req.query('after_event_id');
  const [sess] = await db.select().from(live_sessions).where(eq(live_sessions.id, id)).limit(1);
  if (!sess) return c.json({ error: 'not_found' }, 404);
  const moves = await db
    .select()
    .from(teaching_moves)
    .where(eq(teaching_moves.session_id, id))
    .orderBy(asc(teaching_moves.seq));
  const responses = await db
    .select()
    .from(teaching_responses)
    .where(eq(teaching_responses.session_id, id))
    .orderBy(asc(teaching_responses.created_at));
  const slice = sliceLiveSessionIncrement(moves, responses, afterEventId);
  return c.json({
    session: sess as unknown as LiveSession,
    moves: slice.moves as unknown as TeachingMove[],
    responses: slice.responses as unknown as TeachingResponse[],
    returned_moves: slice.returned_moves,
    returned_responses: slice.returned_responses,
    total_moves: slice.total_moves,
    total_responses: slice.total_responses,
    has_earlier: slice.has_earlier,
    cursor_recognized: slice.cursor_recognized,
    next_after_event_id: slice.next_after_event_id,
  });
});

// 场评读端点 (State 2.0 评估拆两账): web 的 LiveSessionEvaluationBlock 按
// live_session_id 取该场的场评; 无评返回 null (200) — "无数据"是正常态,
// 不是 404 (会话存在与否才走 404)。
t.get('/sessions/:id/evaluation', async (c) => {
  const id = c.req.param('id');
  const [sess] = await db
    .select({ id: live_sessions.id })
    .from(live_sessions)
    .where(eq(live_sessions.id, id))
    .limit(1);
  if (!sess) return c.json({ error: 'not_found' }, 404);
  const [evaluation] = await db
    .select()
    .from(live_session_evaluations)
    .where(eq(live_session_evaluations.live_session_id, id))
    .limit(1);
  return c.json(evaluation ?? null);
});

// Helper: active session for a (pair, lesson) — used by /lesson/:id mount
t.get('/pairs/:pairId/lesson/:lessonId/active-session', async (c) => {
  const pairId = c.req.param('pairId');
  const lessonId = c.req.param('lessonId');
  const rows = await db
    .select()
    .from(live_sessions)
    .where(
      and(
        eq(live_sessions.pair_id, pairId),
        eq(live_sessions.context_type, 'lesson'),
        eq(live_sessions.context_id, lessonId)
      )
    )
    .orderBy(desc(live_sessions.started_at))
    .limit(1);
  return c.json(rows[0] ?? null);
});

// Helper: latest COMPLETED session for a (pair, lesson) — gap-4
// fix. The route above returns the newest session regardless of status, so
// a cancelled/expired retry started AFTER a completed class masks that
// completed history from the Lesson page (真实案例: 间接法课 — 7/03
// completed ls_mr4fizd5 hidden behind a 7/13 cancelled; the page fell
// through to the summon branch). Narrow sibling route rather than a query
// param on active-session: filtering an endpoint literally named
// "active-session" down to completed would be a lie in the URL, and every
// other read here is its own narrow GET.
t.get('/pairs/:pairId/lesson/:lessonId/completed-session', async (c) => {
  const pairId = c.req.param('pairId');
  const lessonId = c.req.param('lessonId');
  const rows = await db
    .select()
    .from(live_sessions)
    .where(
      and(
        eq(live_sessions.pair_id, pairId),
        eq(live_sessions.context_type, 'lesson'),
        eq(live_sessions.context_id, lessonId),
        eq(live_sessions.status, 'completed')
      )
    )
    .orderBy(desc(live_sessions.started_at))
    .limit(1);
  return c.json(rows[0] ?? null);
});

// Helper: every session for a (pair, lesson), newest first —
// one-lesson-many-completed-sessions history. The two routes above
// (active-session / completed-session) each return a single "latest by
// some filter" row and stay untouched (header pill + journal timeline
// still read those); this is the list superset that lets the web history
// panel stack more than one completed session instead of only ever
// reaching the newest. `status` query param narrows (status=completed is
// the only caller today); omitted returns every status, same "no filter =
// all" convention as the rest of this file. No moves/responses in the
// payload — full per-session panorama still goes through GET
// /sessions/:id (LiveSessionFullView); `move_count` is a cheap aggregate
// so a collapsed stack row can show "N moves" without paying for that.
const LIVE_SESSION_STATUSES: LiveSessionStatus[] = ['active', 'completed', 'cancelled', 'expired'];

t.get('/pairs/:pairId/lesson/:lessonId/sessions', async (c) => {
  const pairId = c.req.param('pairId');
  const lessonId = c.req.param('lessonId');
  const statusParam = c.req.query('status');
  if (statusParam && !LIVE_SESSION_STATUSES.includes(statusParam as LiveSessionStatus)) {
    return c.json(
      {
        error: 'invalid_status',
        message: `status must be one of: ${LIVE_SESSION_STATUSES.join(', ')} (got "${statusParam}")`,
      },
      400
    );
  }
  const status = statusParam as LiveSessionStatus | undefined;

  const conditions = [
    eq(live_sessions.pair_id, pairId),
    eq(live_sessions.context_type, 'lesson'),
    eq(live_sessions.context_id, lessonId),
  ];
  if (status) conditions.push(eq(live_sessions.status, status));

  const rows = await db
    .select()
    .from(live_sessions)
    .where(and(...conditions))
    .orderBy(desc(live_sessions.started_at));

  const moveCounts = rows.length
    ? await db
        .select({ session_id: teaching_moves.session_id, n: sql<number>`count(*)::int` })
        .from(teaching_moves)
        .where(inArray(teaching_moves.session_id, rows.map((row) => row.id)))
        .groupBy(teaching_moves.session_id)
    : [];
  const moveCountBySession = new Map(moveCounts.map((r) => [r.session_id, Number(r.n)]));

  const items: LiveSessionListItem[] = rows.map((row) => ({
    ...(row as unknown as LiveSession),
    move_count: moveCountBySession.get(row.id) ?? 0,
  }));
  return c.json(items);
});

// POST /api/teaching/sessions/:id/cancel
//
// 终态单向化: 与 MCP live_session_cancel 共用同一个状态机 guard
// (lib/live-session-transitions.ts, 单一真相源) —— active → cancelled 合法;
// completed/expired → cancelled 409 (终态互斥, 不可逆); cancelled → cancelled
// 幂等 no-op, 返回现行, 不重写 ended_at。
t.post('/sessions/:id/cancel', async (c) => {
  const id = c.req.param('id');
  const [current] = await db.select().from(live_sessions).where(eq(live_sessions.id, id)).limit(1);
  if (!current) return c.json({ error: 'not_found' }, 404);
  const decision = evaluateLiveTransition(current.status, 'cancelled');
  if (decision.kind === 'noop') return c.json(current as unknown as LiveSession);
  if (decision.kind === 'reject') {
    return c.json({ error: 'invalid_transition', message: decision.message }, 409);
  }
  const now = new Date();
  const [row] = await db
    .update(live_sessions)
    .set({ status: 'cancelled', awaiting_role: 'none', ended_at: now, last_activity_at: now })
    .where(eq(live_sessions.id, id))
    .returning();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row as unknown as LiveSession);
});

// POST /api/teaching/sessions/:id/declare-close — 下课铃 (二期, 迁移
// 0042)。learner 侧, web 调用。按铃=落宣告, 不是杀进程: 只写
// learner_close_declared_at, 会话仍 active —— agent 收到事件后走完
// summary/反思/complete, 决定下课的是学习者, 合上帷幕的是老师。
//
//   · 会话终态 → 409 (铃只属于进行中的课堂);
//   · 已宣告 → 幂等返回原 declared_at, 不重写"她到底哪一刻按的铃";
//   · 首次宣告 → 写 learner_close_declared_at=now + awaiting_role='agent'
//     (学习者已表态, 下一拍——合幕——是老师的债, 也让 live_pending 的既有
//     awaiting='agent' 扫描立刻看见这场) + last_activity_at bump, 并向该场
//     事件流追加 live.learner_close_declared 事件 (appendSessionEvent, 照
//     live.learner_message 等既有 session 事件模式); live_wait/GET
//     /bridge/wait 侧另有 computeBridgeWaitEvents 的 live_close_declared
//     事件分支 (lib/live-wait.ts) 保证桥上也看得见。
t.post('/sessions/:id/declare-close', async (c) => {
  const id = c.req.param('id');
  const [current] = await db.select().from(live_sessions).where(eq(live_sessions.id, id)).limit(1);
  if (!current) return c.json({ error: 'not_found' }, 404);
  if (current.learner_close_declared_at) {
    // 幂等分支放在终态检查之前: 已宣告 → 原样返回首次宣告时刻, 不重写、
    // 不再追加事件 —— 哪怕这场随后已被老师合幕 (按铃→合幕→客户端重试的
    // 竞态里, 重试应得到幂等回执而不是一句莫名的终态 409)。
    return c.json({
      session_id: current.id,
      learner_close_declared_at: current.learner_close_declared_at.toISOString(),
      already_declared: true,
    });
  }
  if (current.status !== 'active') {
    return c.json(
      {
        error: 'session_terminal',
        message:
          `Session is already terminal (${current.status}) — the end-of-class bell only belongs to a session in progress. ` +
          'This session has already wrapped up/been aborted; there is no need to declare closing again.',
      },
      409
    );
  }
  const now = new Date();
  const [row] = await db
    .update(live_sessions)
    .set({ learner_close_declared_at: now, awaiting_role: 'agent', last_activity_at: now })
    .where(eq(live_sessions.id, id))
    .returning();
  if (!row) return c.json({ error: 'not_found' }, 404);

  // 事件流落痕 — 让这声铃进该 pair 的 session 事件账 (谁/何时), agent 与
  // 任何回放读者都有机器锚可引。
  await appendSessionEvent({
    pair_id: row.pair_id,
    event_type: 'live.learner_close_declared',
    actor_type: 'learner',
    mode: 'live_teaching',
    occurred_at: now,
    payload: {
      live_session_id: row.id,
      declared_at: now.toISOString(),
    },
  });

  return c.json(
    {
      session_id: row.id,
      learner_close_declared_at: now.toISOString(),
      already_declared: false,
    },
    201
  );
});

// POST /api/teaching/sessions/:id/complete — agent writes REFLECT triple
//
// 终态单向化: 同上, 过同一个 guard —— active → completed 合法;
// cancelled/expired → completed 409; completed → completed 幂等 no-op (返回
// 现行, 不重写 ended_at / REFLECT 三段)。closing 三字段维持契约现状 (可选,
// packages/contracts repository.completeLiveSession 即如此声明) —— 只加状态
// guard, 不新加字段要求; REFLECT 三段的硬校验属于 MCP 正门
// (live_session_complete), 不在这条兼容通道上加码。
t.post('/sessions/:id/complete', async (c) => {
  const id = c.req.param('id');
  const closing = await c.req.json<{
    summary?: string;
    teacher_reflection?: string;
    next_action?: string;
  }>();
  const [current] = await db.select().from(live_sessions).where(eq(live_sessions.id, id)).limit(1);
  if (!current) return c.json({ error: 'not_found' }, 404);
  const decision = evaluateLiveTransition(current.status, 'completed');
  if (decision.kind === 'noop') return c.json(current as unknown as LiveSession);
  if (decision.kind === 'reject') {
    return c.json({ error: 'invalid_transition', message: decision.message }, 409);
  }
  // 二期 下课铃门禁 — 状态机 guard 之上的新一层 (终态锁归
  // live-session-transitions, 宣告门归 lib/learner-close-declaration):
  // 学习者尚未按铃 ⇒ 409, 不收官。noop (已 completed) 幂等重放不受此门;
  // cancel 也不受此门 (取消≠收官)。
  const closeGate = evaluateCloseDeclarationGate(current.learner_close_declared_at);
  if (closeGate.kind === 'reject') {
    return c.json({ error: 'learner_close_not_declared', message: closeGate.message }, 409);
  }
  const now = new Date();
  const [row] = await db
    .update(live_sessions)
    .set({
      status: 'completed',
      awaiting_role: 'none',
      summary: closing.summary,
      teacher_reflection: closing.teacher_reflection,
      next_action: closing.next_action,
      ended_at: now,
      last_activity_at: now,
    })
    .where(eq(live_sessions.id, id))
    .returning();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row as unknown as LiveSession);
});

// POST /api/teaching/sessions/:id/responses — learner submits
t.post('/sessions/:id/responses', async (c) => {
  const session_id = c.req.param('id');
  const input = await c.req.json<{
    move_id: string;
    content: string;
    input_type: ResponseInputType;
    client_response_id: string;
  }>();

  // sweep — a missing client_response_id used to reach the dedupe
  // select's eq() as undefined → postgres-js UNDEFINED_VALUE crash (the only
  // lethal undefined position, see lib/tool-args.ts). The web client always
  // sends one; this 400 guards any other caller. move_id is a NOT NULL FK
  // values-only (undefined → SQL DEFAULT → clear violation), validated for a
  // 400 instead of a 500.
  if (typeof input.client_response_id !== 'string' || input.client_response_id.trim() === '') {
    return c.json({ error: 'client_response_id_required' }, 400);
  }
  if (typeof input.move_id !== 'string' || input.move_id.trim() === '') {
    return c.json({ error: 'move_id_required' }, 400);
  }

  // Idempotency: same client_response_id → return the existing row.
  const existing = await db
    .select()
    .from(teaching_responses)
    .where(eq(teaching_responses.client_response_id, input.client_response_id))
    .limit(1);
  if (existing.length > 0) return c.json(existing[0] as unknown as TeachingResponse, 200);

  const id = genId('tr');
  const now = new Date();
  const [row] = await db
    .insert(teaching_responses)
    .values({
      id,
      session_id,
      move_id: input.move_id,
      client_response_id: input.client_response_id,
      content: input.content,
      input_type: input.input_type,
      created_at: now,
    })
    .returning();

  // Flip awaiting → agent.
  await db
    .update(live_sessions)
    .set({ awaiting_role: 'agent', last_activity_at: now })
    .where(eq(live_sessions.id, session_id));

  return c.json(row as unknown as TeachingResponse, 201);
});

// POST /api/teaching/sessions/:id/moves — agent appends
t.post('/sessions/:id/moves', async (c) => {
  const session_id = c.req.param('id');
  const input = await c.req.json<{
    move_type: MoveType;
    content: string;
    response_kind: ResponseKind;
    payload?: Record<string, unknown>;
    source_type?: string;
    source_id?: string;
  }>();

  // Validation: ASK / PROBE / CHALLENGE must demand text answer.
  if (
    (input.move_type === 'ASK' || input.move_type === 'PROBE' || input.move_type === 'CHALLENGE') &&
    input.response_kind !== 'text'
  ) {
    return c.json(
      { error: 'invalid_response_kind', detail: `${input.move_type} requires response_kind='text'` },
      400
    );
  }
  // REFLECT must use response_kind='none'.
  if (input.move_type === 'REFLECT' && input.response_kind !== 'none') {
    return c.json(
      { error: 'invalid_response_kind', detail: `REFLECT requires response_kind='none'` },
      400
    );
  }

  const id = genId('tm');
  const now = new Date();

  // seq = max(seq) + 1 within session.
  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${teaching_moves.seq}), 0)` })
    .from(teaching_moves)
    .where(eq(teaching_moves.session_id, session_id));
  const seq = (maxRow?.max ?? 0) + 1;

  // FRAME 硬闸 (α批, 与 mcp/server.ts live_message_send 同款 — validation
  // parity: 红队指出 REST 旁路可绕过 MCP 侧的 seq1 强制, 两门必须同锁)。
  if (seq === 1 && input.move_type !== 'FRAME') {
    return c.json(
      {
        error: 'first_move_must_be_frame',
        detail:
          "This session's first move must be FRAME — set the frame before teaching: what this session will do, roughly how long, and what counts as done." +
          ` Received ${input.move_type} instead.`,
        valid_example: {
          move_type: 'FRAME',
          content:
            "We'll go through three steps this session: first review the three categories of indirect-method adjustments (about 10 minutes), then you work through a cash flow statement independently — getting it right wraps up the session.",
          response_kind: 'none',
        },
      },
      400
    );
  }

  const [row] = await db
    .insert(teaching_moves)
    .values({
      id,
      session_id,
      seq,
      move_type: input.move_type,
      content: input.content,
      response_kind: input.response_kind,
      payload: input.payload,
      source_type: input.source_type,
      source_id: input.source_id,
      created_at: now,
    })
    .returning();

  // Update awaiting_role based on response_kind.
  const next: AwaitingRole = nextAwaitingForMove(input.move_type, input.response_kind);
  await db
    .update(live_sessions)
    .set({ awaiting_role: next, last_activity_at: now })
    .where(eq(live_sessions.id, session_id));

  return c.json(row as unknown as TeachingMove, 201);
});

// ============================================================================
// Bridge
// ============================================================================

// POST /api/teaching/bridge/heartbeat
//
// 指示灯全拆 (2026-07-24): context_status 上报与 buildContextView 等级
// 计算 (green/yellow/red/stale/unknown) 已退役——灯从未被真实供电 (无 recipe
// 教上报), 拆整灯不留半截。bridge_states 的 context_* 数据列留存但不再读写
// (见 db/schema/teaching.ts 注); 响应形状收敛为纯在线状态, 不再携 context。
t.post('/bridge/heartbeat', async (c) => {
  const input = await c.req.json<{
    pair_id: string;
    ttl_seconds?: number;
  }>();
  // sweep — pair_id reaches both the upsert's conflict target and the
  // post-upsert select's eq(); undefined there is the lethal UNDEFINED_VALUE
  // position (see lib/tool-args.ts).
  if (typeof input.pair_id !== 'string' || input.pair_id.trim() === '') {
    return c.json({ error: 'pair_id_required' }, 400);
  }

  const ttl = Math.max(15, Math.min(600, input.ttl_seconds ?? 60));
  const now = new Date();
  const onlineUntil = new Date(now.getTime() + ttl * 1000);

  await db
    .insert(bridge_states)
    .values({
      pair_id: input.pair_id,
      last_heartbeat_at: now,
      online_until: onlineUntil,
    })
    .onConflictDoUpdate({
      target: bridge_states.pair_id,
      set: { last_heartbeat_at: now, online_until: onlineUntil },
    });

  return c.json({
    pair_id: input.pair_id,
    online: true,
    last_heartbeat_at: now.toISOString(),
    online_until: onlineUntil.toISOString(),
  });
});

// GET /api/teaching/bridge/pending?pair_id=...
t.get('/bridge/pending', async (c) => {
  const pair_id = c.req.query('pair_id');
  if (!pair_id) return c.json({ error: 'missing_pair_id' }, 400);

  // Bridge status (不再携 context 视图——指示灯已整体退役)。
  const [bridge] = await db
    .select()
    .from(bridge_states)
    .where(eq(bridge_states.pair_id, pair_id))
    .limit(1);
  const now = new Date();
  const status = {
    pair_id,
    online: bridge ? bridge.online_until.getTime() > now.getTime() : false,
    last_heartbeat_at: bridge?.last_heartbeat_at?.toISOString() ?? null,
    online_until: bridge ? bridge.online_until.toISOString() : null,
  };

  // --- Live Teaching pending ---
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

  const items: BridgePendingItem[] = [];
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
    const reason = moveCount === 0 ? 'live_session_start' : 'live_response';

    // 件三 — 与 mcp/server.ts live_pending 同口径: 最新一条 move
    // 的 response_kind 决定分工标签 (lib/live-wait.ts classifyPendingReason)。
    const [latestMove] =
      moveCount === 0
        ? [undefined]
        : await db
            .select({ response_kind: teaching_moves.response_kind })
            .from(teaching_moves)
            .where(eq(teaching_moves.session_id, sess.id))
            .orderBy(desc(teaching_moves.seq))
            .limit(1);

    items.push({
      channel: 'live_teaching',
      reason,
      session_id: sess.id as unknown as LiveSession['id'],
      // (件三, 与 mcp/server.ts live_pending 同刀) — 整行瘦成
      // stub; 全量状态归 GET /sessions/:id / live_session_get。
      session: toLiveSessionStub(sess),
      latest_response: latestResp as unknown as TeachingResponse | undefined,
      queued_at: sess.last_activity_at.toISOString(),
      pending_reason: classifyPendingReason(moveCount, latestMove?.response_kind),
    });
  }

  // --- Ad Hoc pending: thread with a trailing user message (no agent reply yet) ---
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
    // 消账游标退场 (AdHoc 三票并一之三) — 同口径见 lib/live-wait.ts
    // isAdhocMessageOutstanding 头注 (三处手写扫描共享该 helper：这里 /
    // computeBridgeWaitEvents / mcp/server.ts live_pending)。
    if (!isAdhocMessageOutstanding(th.acked_message_id, last.id)) continue;
    items.push({
      channel: 'adhoc',
      reason: 'adhoc_message',
      thread_id: th.id,
      latest_message: last,
      queued_at: last.created_at.toISOString(),
    });
  }

  // Priority sort (adhoc_message=0; live_session_start=1; live_response=2).
  const priority: Record<string, number> = {
    adhoc_message: 0,
    live_session_start: 1,
    live_response: 2,
  };
  items.sort((a, b) => {
    const pa = priority[a.reason] ?? 99;
    const pb = priority[b.reason] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.queued_at.localeCompare(b.queued_at);
  });

  // 值更契约全路径暴露 (件一) — bridge 级 may_end_turn: 该 pair 是否还有
  // active 会话, 不看这次 items 有没有东西 (同 mcp/server.ts live_pending)。
  const pendingHasActive = await pairHasActiveLiveSession(pair_id);
  return c.json({
    bridge: status,
    items,
    live_runtime_contract: buildLiveRuntimeContract(!pendingHasActive),
    // 教义版本号随行 (与 mcp/server.ts live_pending 同刀)。
    contract_version: liveRuntimeContractVersion(),
  });
});

// ============================================================================
// GET /api/teaching/bridge/wait?pair_id=X&since=Y&timeout_s=55&consumer_id=Z
//
// Long-poll companion to /bridge/pending. The request hangs open until
// either (a) a pending event *newer than the effective cursor* shows up, or
// (b) timeout_s elapses — whichever first. On timeout: {events: [], timeout:
// true}. On event: {events: [...], timeout: false}. Purpose: push the
// "wait for the next thing to do" loop out of the agent's token budget
// and into a plain shell process (see scripts/live-watch.py) that blocks
// on this call instead of the agent polling /bridge/pending in a spin
// loop or (worse) sitting idle burning context.
//
// Core wait logic (event computation, poll loop) lives in lib/live-wait.ts
// (2026-07) — the MCP tool `live_wait` (mcp/server.ts) is a second
// consumer that needs the exact same blocking semantics, so the shared part
// was extracted out from under this route rather than forked.
//
// Live 2.0 (2026-07-18) — server-side delivery cursor: `consumer_id` is
// optional and opt-in. When present, `since` is resolved through
// lib/live-wait.ts's resolveWaitSince() against the persisted
// bridge_delivery_cursors table instead of being taken at face value —
// see that function's doc comment for the three-way branch (no
// consumer_id / consumer_id+since / consumer_id only). Omitting
// consumer_id reproduces the exact pre-2.0 behavior (since taken as given,
// '' default, nothing persisted) — old callers (scripts/live-watch.py
// instances still on the prior protocol) are
// unaffected byte-for-byte.
//
// Response now also echoes back `since`: the actual cursor value this call
// waited from (whatever resolveWaitSince produced — the caller's own
// explicit value, or the persisted one it read back). This is additive
// (old clients that only look at events/timeout are unaffected) and lets a
// consumer_id-bearing caller *probe* its own persisted cursor cheaply — a
// short timeout_s call with consumer_id set and since omitted resolves and
// returns fast (waitForBridgeEvents checks for already-fresh events before
// it ever sleeps), handing back exactly where the server thinks this
// consumer left off. scripts/live-watch.py uses this on startup when its
// local seen-cache is missing (see that file's Live 2.0 notes) instead of
// falling back to the old fail-closed "mark everything currently pending as
// seen" prime.
//
// Timeout ceiling: default stays 55s (unchanged — proxy layers commonly cut
// idle conns at 60s), but a caller that knows it can hold a longer-lived
// connection open may ask for up to BRIDGE_WAIT_HARD_CAP_S. Omitting
// timeout_s (or passing a value <= the old default) behaves exactly as
// before.
// ============================================================================

const BRIDGE_WAIT_DEFAULT_TIMEOUT_S = 55; // unchanged default — proxy layers commonly cut idle conns at 60s
const BRIDGE_WAIT_HARD_CAP_S = 300; // opt-in ceiling for callers that can hold a longer connection open

t.get('/bridge/wait', async (c) => {
  const pair_id = c.req.query('pair_id');
  if (!pair_id) return c.json({ error: 'missing_pair_id' }, 400);

  // Undefined (param absent) vs '' (param sent empty) matters here — see
  // resolveWaitSince(): only an *absent* since, paired with a consumer_id,
  // means "resume from my persisted cursor." An explicit '' is itself a
  // valid ack ("start me over from the beginning").
  const sinceParam = c.req.query('since');
  const consumerId = c.req.query('consumer_id') || undefined;
  const requestedTimeoutS = Number(
    c.req.query('timeout_s') ?? String(BRIDGE_WAIT_DEFAULT_TIMEOUT_S)
  );
  const timeoutS = Math.max(
    1,
    Math.min(
      BRIDGE_WAIT_HARD_CAP_S,
      Number.isFinite(requestedTimeoutS) ? requestedTimeoutS : BRIDGE_WAIT_DEFAULT_TIMEOUT_S
    )
  );

  const since = await resolveWaitSince(pair_id, consumerId, sinceParam);
  const result = await waitForBridgeEvents(pair_id, since, timeoutS);
  // 值更契约全路径暴露 (件一) — pair 级 may_end_turn: 超时空手不等于可以
  // 收工, 只要这个 pair 还挂着 active 会话, 义务就还在 (同 MCP live_wait)。
  const waitHasActive = await pairHasActiveLiveSession(pair_id);
  // known_contract_version 协议 (与 MCP live_wait 同一份判定,
  // lib/live-contract.ts buildContractStamp): 命中现行版 ⇒ 合约体省略, 只留
  // contract_version + may_end_turn (逐次状态, 无损红线③); 缺省/过期 ⇒
  // 完整合约照发 + contract_version 随行 (旧调用方如 live-watch.py 不传
  // 该参数, 行为不变, 纯增字段)。
  const stamp = buildContractStamp(c.req.query('known_contract_version') || undefined, !waitHasActive);
  if (stamp.matched) {
    return c.json({
      ...result,
      since,
      contract_version: stamp.contract_version,
      may_end_turn: stamp.may_end_turn,
    });
  }
  return c.json({
    ...result,
    since,
    live_runtime_contract: stamp.live_runtime_contract,
    contract_version: stamp.contract_version,
  });
});

// ============================================================================
// Mid-lesson snapshots (Stage 7e)
// ============================================================================

// POST /api/teaching/sessions/:id/snapshots — agent writes rolling checkpoint
t.post('/sessions/:id/snapshots', async (c) => {
  const session_id = c.req.param('id');
  const input = await c.req.json<{
    after_turn_n: number;
    rolling_summary: string;
    current_direction: string;
    weak_signals: string[];
  }>();
  const id = genId('snap');
  const now = new Date();
  const [row] = await db
    .insert(mid_lesson_snapshots)
    .values({
      id,
      session_id,
      after_turn_n: input.after_turn_n,
      rolling_summary: input.rolling_summary,
      current_direction: input.current_direction,
      weak_signals: input.weak_signals,
      created_at: now,
    })
    .returning();
  return c.json(row as unknown as MidLessonSnapshot, 201);
});

// GET /api/teaching/sessions/:id/snapshots/latest — most recent or null
t.get('/sessions/:id/snapshots/latest', async (c) => {
  const session_id = c.req.param('id');
  const [row] = await db
    .select()
    .from(mid_lesson_snapshots)
    .where(eq(mid_lesson_snapshots.session_id, session_id))
    .orderBy(desc(mid_lesson_snapshots.created_at))
    .limit(1);
  return c.json((row as unknown as MidLessonSnapshot) ?? null);
});

export default t;
