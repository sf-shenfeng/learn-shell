// Tests for Live 终态单向化 — lib/live-session-transitions.ts。
//
// 上半: 纯状态机判定 (evaluateLiveTransition / assertLiveTransition), DB-free。
// 下半: REST 集成 (routes/teaching.ts POST /sessions/:id/complete|cancel 过同
// 一个 guard) —— 走 Hono `app.request()` (无真实网络 socket), 按
// write.restore.test.ts 的既定纪律: before() 里先 ping DB, 不可达就逐测
// skip (不假红不假绿); 可达则 requireBenchDatabase 硬闸门把关, 库名不是
// *_bench 直接炸穿, 绝不把测试数据写进生产库 (7/19 t144test 案)。
//
// node:test / node:assert, zero new deps.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sql, eq, inArray } from 'drizzle-orm';
import {
  evaluateLiveTransition,
  assertLiveTransition,
  type LiveTerminalStatus,
} from './live-session-transitions';
import { McpToolError } from './mcp-errors';

// ---------------------------------------------------------------------------
// 纯判定
// ---------------------------------------------------------------------------

const TERMINALS: LiveTerminalStatus[] = ['completed', 'cancelled', 'expired'];

test('active → 每个终态都是 proceed', () => {
  for (const target of TERMINALS) {
    assert.deepEqual(evaluateLiveTransition('active', target), { kind: 'proceed' });
  }
});

test('同终态重复请求 = 幂等 noop (不重写 ended_at 的判定依据)', () => {
  for (const target of TERMINALS) {
    assert.deepEqual(evaluateLiveTransition(target, target), { kind: 'noop' });
  }
});

test('三终态之间互转一律 reject (全 6 个方向)', () => {
  for (const current of TERMINALS) {
    for (const target of TERMINALS) {
      if (current === target) continue;
      const d = evaluateLiveTransition(current, target);
      assert.equal(d.kind, 'reject', `${current} → ${target} 必须被拒`);
      if (d.kind === 'reject') assert.match(d.message, /terminal/);
    }
  }
});

test('assertLiveTransition — proceed/noop 原样返回, reject 抛不可重试 CONFLICT', () => {
  assert.equal(assertLiveTransition('active', 'completed'), 'proceed');
  assert.equal(assertLiveTransition('cancelled', 'cancelled'), 'noop');
  try {
    assertLiveTransition('completed', 'cancelled');
    assert.fail('completed → cancelled 必须抛错');
  } catch (err) {
    assert.ok(err instanceof McpToolError);
    assert.equal(err.code, 'CONFLICT');
    assert.equal(err.retryable, false);
    assert.match(err.recovery_hint, /live_session_start/);
  }
});

// (终态 → active 复活: target 类型上就限定为三终态, 编译期即不可表达 ——
// 下一行若解开注释是类型错误, 这是"终态→任何态非法"里 active 那一半的证明。)
// evaluateLiveTransition('completed', 'active');

// ---------------------------------------------------------------------------
// REST 集成 (bench 库, DB 不可达则 skip)
// ---------------------------------------------------------------------------

let dbAvailable = true;
before(async () => {
  const { db } = await import('../db/client');
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbAvailable = false;
    console.log(
      '[live-session-transitions.test] no live Postgres reachable — REST integration tests will report as skipped.'
    );
    return;
  }
  const { requireBenchDatabase } = await import('./require-bench-db');
  requireBenchDatabase(
    process.env.DATABASE_URL,
    'live-session-transitions.test.ts (seeds 测试学习者/测试老师 pair + live sessions)'
  );
});

const dbSkipNote = () => (dbAvailable ? false : 'DB unreachable in this sandbox');

test('REST: active→completed 正常; 重复 complete 幂等不改 ended_at; 终态互转 409; cancel 同款', { timeout: 30_000 }, async (t) => {
  if (!dbAvailable) return t.skip(dbSkipNote() as string);

  const { db } = await import('../db/client');
  const { learners, agents, learner_agent_pairs, live_sessions } = await import('../db/schema');
  const { default: app } = await import('../index');

  const suffix = `lstrans_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const learnerId = `lrn_${suffix}`;
  const agentId = `agt_${suffix}`;
  const pairId = `pair_${suffix}`;
  const sessionA = `ls_${suffix}_a`; // complete 主线
  const sessionB = `ls_${suffix}_b`; // cancel 主线

  const postJson = (path: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });

  try {
    await db.insert(learners).values({
      id: learnerId,
      display_name: '测试学习者 lstrans',
      preferences: { timezone: 'Asia/Shanghai', locale: 'zh-CN' },
    });
    await db.insert(agents).values({ id: agentId, display_name: '测试老师 lstrans', provider: 'test' });
    await db.insert(learner_agent_pairs).values({ id: pairId, learner_id: learnerId, agent_id: agentId });
    await db.insert(live_sessions).values([
      {
        id: sessionA,
        pair_id: pairId,
        context_type: 'trial',
        context_id: `ctx_${suffix}_a`,
        // 二期下课铃门禁 (迁移 0042): complete 现在多一道"学习者已宣告
        // 收课"的门 — 本测试的靶子是状态机终态锁, 不是宣告门, 故 fixture
        // 直接带上宣告 (门禁自身的全分支覆盖在 routes/
        // teaching.declare-close.db.test.ts)。
        learner_close_declared_at: new Date(),
      },
      { id: sessionB, pair_id: pairId, context_type: 'trial', context_id: `ctx_${suffix}_b` },
    ]);

    // --- active → completed 正常 ---
    const complete1 = await postJson(`/api/teaching/sessions/${sessionA}/complete`, {
      summary: 's',
      teacher_reflection: 'r',
      next_action: 'n',
    });
    assert.equal(complete1.status, 200);
    const completed1 = (await complete1.json()) as { status: string; ended_at: string | null };
    assert.equal(completed1.status, 'completed');
    assert.ok(completed1.ended_at, 'complete 必须落 ended_at');

    // --- completed → completed 幂等 no-op: ended_at 不变, REFLECT 三段不被改写 ---
    const complete2 = await postJson(`/api/teaching/sessions/${sessionA}/complete`, {
      summary: 'OVERWRITE',
      teacher_reflection: 'OVERWRITE',
      next_action: 'OVERWRITE',
    });
    assert.equal(complete2.status, 200);
    const completed2 = (await complete2.json()) as {
      status: string;
      ended_at: string | null;
      summary: string | null;
    };
    assert.equal(completed2.status, 'completed');
    assert.equal(completed2.ended_at, completed1.ended_at, '重复 complete 不得重写 ended_at');
    assert.equal(completed2.summary, 's', '重复 complete 不得改写首次 REFLECT');

    // --- completed → cancelled 终态互转 409 ---
    const cancelCompleted = await postJson(`/api/teaching/sessions/${sessionA}/cancel`);
    assert.equal(cancelCompleted.status, 409);
    const rejectBody = (await cancelCompleted.json()) as { error: string };
    assert.equal(rejectBody.error, 'invalid_transition');

    // DB 里这场仍是 completed, ended_at 仍是首次值。
    const [rowA] = await db.select().from(live_sessions).where(eq(live_sessions.id, sessionA)).limit(1);
    assert.equal(rowA!.status, 'completed');
    assert.equal(rowA!.ended_at!.toISOString(), new Date(completed1.ended_at!).toISOString());

    // --- cancel 主线: active → cancelled 正常, 重复 cancel 幂等不改 ended_at ---
    const cancel1 = await postJson(`/api/teaching/sessions/${sessionB}/cancel`);
    assert.equal(cancel1.status, 200);
    const cancelled1 = (await cancel1.json()) as { status: string; ended_at: string | null };
    assert.equal(cancelled1.status, 'cancelled');
    assert.ok(cancelled1.ended_at);

    const cancel2 = await postJson(`/api/teaching/sessions/${sessionB}/cancel`);
    assert.equal(cancel2.status, 200);
    const cancelled2 = (await cancel2.json()) as { status: string; ended_at: string | null };
    assert.equal(cancelled2.ended_at, cancelled1.ended_at, '重复 cancel 不得重写 ended_at');

    // --- cancelled → completed 终态互转 409 ---
    const completeCancelled = await postJson(`/api/teaching/sessions/${sessionB}/complete`, {
      summary: 's',
      teacher_reflection: 'r',
      next_action: 'n',
    });
    assert.equal(completeCancelled.status, 409);
    const [rowB] = await db.select().from(live_sessions).where(eq(live_sessions.id, sessionB)).limit(1);
    assert.equal(rowB!.status, 'cancelled');
  } finally {
    // live_sessions 经 pair cascade 清掉; learner/agent 显式删。
    await db.delete(live_sessions).where(inArray(live_sessions.id, [sessionA, sessionB]));
    await db.delete(learner_agent_pairs).where(eq(learner_agent_pairs.id, pairId));
    await db.delete(learners).where(eq(learners.id, learnerId));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
});
