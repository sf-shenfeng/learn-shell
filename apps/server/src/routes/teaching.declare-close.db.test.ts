// DB 集成测试: 下课铃 (二期, 迁移 0042) — declare-close 路由 + complete
// 门禁 + 桥事件可见性 (真实 Postgres, bench 库)。
//
// 覆盖任务清单第 6 条的下课铃侧全分支:
//   · POST /sessions/:id/declare-close: 首次宣告 (201, 落列+翻 awaiting+
//     追加 live.learner_close_declared 事件) / 幂等 (200, 原 declared_at,
//     不重复追加事件) / 终态 409;
//   · complete 门禁: 未宣告 CONFLICT(409) / 已宣告通过 / cancel 不受门;
//   · computeBridgeWaitEvents: 已宣告的 active 场产 live_close_declared
//     事件, event_id 确定性 (同场两次扫描同 id, 游标 ack 得住)。
//
// RUN_DB_TESTS=1 门控 + requireBenchDatabase 硬闸门, 同仓内既定纪律。
// 需已迁移至 0042+ 的 Postgres。node:test / node:assert, zero new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const dbSkip = process.env.RUN_DB_TESTS !== '1';
const skipNote = dbSkip && '需 RUN_DB_TESTS=1 + 已迁移(0042+)的 bench Postgres (待验收时跑)';

test('下课铃: declare-close 全分支 + complete 门禁 + 桥事件', { skip: skipNote }, async () => {
  const { requireBenchDatabase } = await import('../lib/require-bench-db');
  requireBenchDatabase(
    process.env.DATABASE_URL,
    'teaching.declare-close.db.test.ts (creates 测试 pair/live session 数据)'
  );

  const { db } = await import('../db/client');
  const { and, eq } = await import('drizzle-orm');
  const { learners, agents, learner_agent_pairs, live_sessions, session_events } = await import(
    '../db/schema'
  );
  const { computeBridgeWaitEvents } = await import('../lib/live-wait');
  const { default: app } = await import('../index');

  const suffix = `bell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const learnerId = `lrn_${suffix}`;
  const agentId = `agt_${suffix}`;
  const pairId = `pair_${suffix}`;

  const mkSession = async (id: string, status: 'active' | 'completed' | 'cancelled') => {
    const now = new Date();
    await db.insert(live_sessions).values({
      id,
      pair_id: pairId,
      context_type: 'lesson',
      context_id: `lsn_${suffix}_${id}`,
      status,
      awaiting_role: status === 'active' ? 'learner' : 'none',
      started_at: now,
      last_activity_at: now,
      ...(status !== 'active' ? { ended_at: now } : {}),
    });
  };

  try {
    await db.insert(learners).values({
      id: learnerId,
      display_name: `测试下课铃学习者 ${suffix}`,
      preferences: { timezone: 'UTC', locale: 'zh-CN' },
    });
    await db.insert(agents).values({ id: agentId, display_name: '测试老师 bell', provider: 'test' });
    await db.insert(learner_agent_pairs).values({ id: pairId, learner_id: learnerId, agent_id: agentId });

    // ---- 1. complete 门禁: 未宣告 ⇒ 409, cancel 不受门 ----
    const sGate = `ls_${suffix}_gate`;
    await mkSession(sGate, 'active');
    const completeBlocked = await app.request(`/api/teaching/sessions/${sGate}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 's', teacher_reflection: 'r', next_action: 'n' }),
    });
    assert.equal(completeBlocked.status, 409, '未摇铃不许收官');
    const blockedBody = (await completeBlocked.json()) as { error: string; message: string };
    assert.equal(blockedBody.error, 'learner_close_not_declared');
    assert.match(blockedBody.message, /end-of-class bell/);
    // cancel 不受此门 (取消≠收官):
    const cancelOk = await app.request(`/api/teaching/sessions/${sGate}/cancel`, { method: 'POST' });
    assert.equal(cancelOk.status, 200, 'cancel 不受下课铃门禁');

    // ---- 2. declare-close 首次宣告 ----
    const sMain = `ls_${suffix}_main`;
    await mkSession(sMain, 'active');
    const declare1 = await app.request(`/api/teaching/sessions/${sMain}/declare-close`, {
      method: 'POST',
    });
    assert.equal(declare1.status, 201, '首次宣告应 201');
    const d1 = (await declare1.json()) as {
      session_id: string;
      learner_close_declared_at: string;
      already_declared: boolean;
    };
    assert.equal(d1.already_declared, false);
    assert.ok(d1.learner_close_declared_at);

    const [afterDeclare] = await db
      .select()
      .from(live_sessions)
      .where(eq(live_sessions.id, sMain))
      .limit(1);
    assert.ok(afterDeclare!.learner_close_declared_at, '宣告列已落');
    assert.equal(afterDeclare!.status, 'active', '按铃=落宣告, 不是杀进程 — 会话仍 active');
    assert.equal(afterDeclare!.awaiting_role, 'agent', '铃响后合幕是老师的债 — awaiting 翻回 agent');

    // 事件流落痕: live.learner_close_declared 追加了恰好一条。
    const eventsAfter1 = await db
      .select()
      .from(session_events)
      .where(
        and(eq(session_events.pair_id, pairId), eq(session_events.event_type, 'live.learner_close_declared'))
      );
    assert.equal(eventsAfter1.length, 1, '首次宣告追加一条事件');
    assert.equal(eventsAfter1[0]!.actor_type, 'learner', '按铃的是学习者');
    const payload = eventsAfter1[0]!.payload as { live_session_id: string; declared_at: string };
    assert.equal(payload.live_session_id, sMain);

    // ---- 3. 幂等: 二次宣告返回原 declared_at, 不重复追加 ----
    const declare2 = await app.request(`/api/teaching/sessions/${sMain}/declare-close`, {
      method: 'POST',
    });
    assert.equal(declare2.status, 200, '重复宣告应幂等 200');
    const d2 = (await declare2.json()) as {
      learner_close_declared_at: string;
      already_declared: boolean;
    };
    assert.equal(d2.already_declared, true);
    assert.equal(d2.learner_close_declared_at, d1.learner_close_declared_at, '不重写她按铃的时刻');
    const eventsAfter2 = await db
      .select()
      .from(session_events)
      .where(
        and(eq(session_events.pair_id, pairId), eq(session_events.event_type, 'live.learner_close_declared'))
      );
    assert.equal(eventsAfter2.length, 1, '幂等重放不追加第二条事件');

    // ---- 4. 桥事件可见性: live_close_declared, event_id 确定性 ----
    const wait1 = await computeBridgeWaitEvents(pairId);
    const closeEvents1 = wait1.filter((e) => e.reason === 'live_close_declared');
    assert.equal(closeEvents1.length, 1, '已宣告的 active 场应产 live_close_declared 桥事件');
    assert.equal(closeEvents1[0]!.session_id, sMain);
    assert.ok(closeEvents1[0]!.event_id.startsWith('lcd_'));
    assert.equal(
      closeEvents1[0]!.session?.learner_close_declared_at,
      d1.learner_close_declared_at,
      'stub 随行宣告时刻'
    );
    const wait2 = await computeBridgeWaitEvents(pairId);
    const closeEvents2 = wait2.filter((e) => e.reason === 'live_close_declared');
    assert.equal(
      closeEvents2[0]!.event_id,
      closeEvents1[0]!.event_id,
      'event_id 确定性 — 同场铃两次扫描同 id, 游标 ack 得住'
    );

    // ---- 5. complete 门禁: 已宣告 ⇒ 放行 ----
    const completeOk = await app.request(`/api/teaching/sessions/${sMain}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 's', teacher_reflection: 'r', next_action: 'n' }),
    });
    assert.equal(completeOk.status, 200, '铃已响, 收官放行');
    const completed = (await completeOk.json()) as { status: string };
    assert.equal(completed.status, 'completed');

    // 收官后铃事件退场 (只扫 active 场):
    const wait3 = await computeBridgeWaitEvents(pairId);
    assert.equal(
      wait3.filter((e) => e.reason === 'live_close_declared').length,
      0,
      '已合幕的场不再产铃事件'
    );

    // ---- 6. 终态 declare-close ⇒ 409 ----
    const declareTerminal = await app.request(`/api/teaching/sessions/${sMain}/declare-close`, {
      method: 'POST',
    });
    assert.equal(declareTerminal.status, 200, '已宣告过的终态场仍幂等返回首次宣告 (不 409)');
    const sDone = `ls_${suffix}_done`;
    await mkSession(sDone, 'cancelled');
    const declareCancelled = await app.request(`/api/teaching/sessions/${sDone}/declare-close`, {
      method: 'POST',
    });
    assert.equal(declareCancelled.status, 409, '从未宣告过的终态场按铃 ⇒ 409');
    const terminalBody = (await declareCancelled.json()) as { error: string };
    assert.equal(terminalBody.error, 'session_terminal');

    // 404 分支顺手:
    const declare404 = await app.request(`/api/teaching/sessions/ls_${suffix}_nope/declare-close`, {
      method: 'POST',
    });
    assert.equal(declare404.status, 404);
  } finally {
    // 清账: 删 pair 级联带走 sessions/session_events/learning_sessions,
    // 再删 agent (restrict FK) 与 learner。
    await db.delete(learner_agent_pairs).where(eq(learner_agent_pairs.id, pairId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(learners).where(eq(learners.id, learnerId));
  }
});
