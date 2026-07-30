// DB 集成测试: 首跑入学 — 学习者登记 + create_pair 核心 + 样板间户口
// 排序 (真实 Postgres, bench 库)。
//
// 覆盖任务清单第 6 条的入学侧全分支:
//   · registerLearner / POST /api/onboarding/learner 幂等 (同名未配对复用);
//   · createPairForRegisteredLearner: 无登记拒 (NOT_FOUND) / 成功
//     (is_demo=false) / 重复对拒 (CONFLICT 指路既有 pair);
//   · 默认 pair 解析 demo 靠后: order by is_demo asc, established_at asc
//     (GET /api/pair/current 走真实路由验证);
//   · GET /api/onboarding/status 轻端点。
//
// 按既定纪律 RUN_DB_TESTS=1 门控 + requireBenchDatabase 硬闸门 (7/19
// t144test 入侵案后规矩): 库名不是 *_bench 直接拒绝运行。
// 需已迁移至 0042+ 的 Postgres。node:test / node:assert, zero new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const dbSkip = process.env.RUN_DB_TESTS !== '1';
const skipNote = dbSkip && '需 RUN_DB_TESTS=1 + 已迁移(0042+)的 bench Postgres (待验收时跑)';

test('首跑入学: 登记幂等 / create_pair 三分支 / demo 靠后解析 / status 端点', { skip: skipNote }, async () => {
  const { requireBenchDatabase } = await import('./require-bench-db');
  requireBenchDatabase(
    process.env.DATABASE_URL,
    'first-run-onboarding.db.test.ts (creates 测试学习者/agent/pair 数据)'
  );

  const { db } = await import('../db/client');
  const { eq, inArray } = await import('drizzle-orm');
  const { learners, agents, learner_agent_pairs } = await import('../db/schema');
  const { registerLearner, createPairForRegisteredLearner } = await import('./first-run-onboarding');
  const { McpToolError } = await import('./mcp-errors');
  const { default: app } = await import('../index');

  const suffix = `onb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const learnerName = `测试首跑学习者 ${suffix}`;
  const createdLearnerIds: string[] = [];
  const createdAgentIds: string[] = [];
  const createdPairIds: string[] = [];

  try {
    // ---- 1. 登记: 首次新建 ----
    const reg1 = await registerLearner(learnerName, 'zh-CN');
    assert.equal(reg1.reused, false, '首次登记应新建');
    assert.equal(reg1.display_name, learnerName);
    createdLearnerIds.push(reg1.learner_id);

    // ---- 2. 登记幂等: 同名未配对 ⇒ 复用既有行 ----
    const reg2 = await registerLearner(learnerName);
    assert.equal(reg2.reused, true, '同名未配对应幂等复用');
    assert.equal(reg2.learner_id, reg1.learner_id);

    // REST 面同幂等 (app.request, 无真实网络端口):
    const post1 = await app.request('/api/onboarding/learner', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: `  ${learnerName}  ` }), // trim 验证
    });
    assert.equal(post1.status, 200, 'REST 幂等命中同名未配对行应 200');
    const postBody1 = (await post1.json()) as { learner_id: string; reused: boolean };
    assert.equal(postBody1.learner_id, reg1.learner_id);
    assert.equal(postBody1.reused, true);

    // 名字尺子: 空/超长 ⇒ 400
    const bad = await app.request('/api/onboarding/learner', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: '   ' }),
    });
    assert.equal(bad.status, 400);
    const tooLong = await app.request('/api/onboarding/learner', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'x'.repeat(81) }),
    });
    assert.equal(tooLong.status, 400);

    // ---- 3. create_pair: 无登记 ⇒ NOT_FOUND 拒 ----
    await assert.rejects(
      createPairForRegisteredLearner({
        learner_display_name: `不存在的学习者 ${suffix}`,
        agent_provider: 'test',
        agent_model: 'claude',
        agent_display_name: '测试老师',
      }),
      (e: unknown) => e instanceof McpToolError && e.code === 'NOT_FOUND',
      '未登记的名字必须被拒 — 名字主权, 不许 agent 代造'
    );

    // ---- 4. create_pair 成功: is_demo=false 真 pair ----
    const created = await createPairForRegisteredLearner({
      learner_display_name: learnerName,
      agent_provider: 'test',
      agent_model: 'claude',
      agent_display_name: `测试老师 ${suffix}`,
      locale: 'zh-CN',
      preferences: { learning_style_notes: '喜欢寓言' },
    });
    createdAgentIds.push(created.agent_id);
    createdPairIds.push(created.pair_id);
    assert.equal(created.learner_id, reg1.learner_id, '应配对到登记的那行 learner');

    const [pairRow] = await db
      .select()
      .from(learner_agent_pairs)
      .where(eq(learner_agent_pairs.id, created.pair_id))
      .limit(1);
    assert.ok(pairRow);
    assert.equal(pairRow!.is_demo, false, '真入学正门建的 pair 永远 is_demo=false');
    assert.equal(pairRow!.active, true);

    const [agentRow] = await db.select().from(agents).where(eq(agents.id, created.agent_id)).limit(1);
    assert.equal(agentRow!.provider, 'test');
    assert.equal(agentRow!.model_family, 'claude');

    // learner-owned 可选补充落位 (浅合并):
    const [learnerRow] = await db.select().from(learners).where(eq(learners.id, reg1.learner_id)).limit(1);
    const prefs = learnerRow!.preferences as Record<string, unknown>;
    assert.equal(prefs.locale, 'zh-CN');
    assert.equal(prefs.learning_style_notes, '喜欢寓言');

    // ---- 5. 守卫: 该 learner 已有 active pair ⇒ CONFLICT 指路既有关系 ----
    await assert.rejects(
      createPairForRegisteredLearner({
        learner_display_name: learnerName,
        agent_provider: 'test',
        agent_model: 'claude',
        agent_display_name: '第二个老师',
      }),
      (e: unknown) =>
        e instanceof McpToolError &&
        e.code === 'CONFLICT' &&
        (e.details as Record<string, unknown> | undefined)?.existing_pair_id === created.pair_id,
      '重复建对必须被拒且指路既有 pair'
    );

    // ---- 6. 登记侧: 同名者已配对 ⇒ 新登记新建新行 (不是复用已配对者) ----
    const reg3 = await registerLearner(learnerName);
    assert.equal(reg3.reused, false, '同名者已全部配对时, 新登记应得到自己的新行');
    assert.notEqual(reg3.learner_id, reg1.learner_id);
    createdLearnerIds.push(reg3.learner_id);

    // ---- 7. 默认 pair 解析: demo 靠后 (order by is_demo asc, established_at asc) ----
    // 把两对都放到 epoch 附近, 排在 bench 库任何既有 pair 之前:
    // demo 资历更老 (1970-01-01) 但身份是样板间; 真 pair 晚一天 (1970-01-02)。
    // 若排序退化回纯资历优先, /pair/current 会错选 demo。
    const demoLearnerId = `lrn_${suffix}_demo`;
    const demoAgentId = `agt_${suffix}_demo`;
    const demoPairId = `pair_${suffix}_demo`;
    createdLearnerIds.push(demoLearnerId);
    createdAgentIds.push(demoAgentId);
    createdPairIds.push(demoPairId);
    await db.insert(learners).values({
      id: demoLearnerId,
      display_name: `测试样板间学习者 ${suffix}`,
      preferences: { timezone: 'UTC', locale: 'en' },
    });
    await db.insert(agents).values({ id: demoAgentId, display_name: 'Demo Agent', provider: 'test' });
    await db.insert(learner_agent_pairs).values({
      id: demoPairId,
      learner_id: demoLearnerId,
      agent_id: demoAgentId,
      established_at: new Date('1970-01-01T00:00:00.000Z'),
      active: true,
      is_demo: true,
    });
    await db
      .update(learner_agent_pairs)
      .set({ established_at: new Date('1970-01-02T00:00:00.000Z') })
      .where(eq(learner_agent_pairs.id, created.pair_id));

    const currentRes = await app.request('/api/pair/current');
    assert.equal(currentRes.status, 200);
    const current = (await currentRes.json()) as { id: string; is_demo: boolean } | null;
    assert.ok(current);
    assert.equal(
      current!.id,
      created.pair_id,
      '真 pair 必须压过资历更老的样板间当选"当前关系" (is_demo asc 先于 established_at asc)'
    );

    // ---- 8. GET /api/onboarding/status ----
    const statusRes = await app.request('/api/onboarding/status');
    assert.equal(statusRes.status, 200);
    const status = (await statusRes.json()) as {
      has_active_pair: boolean;
      has_real_pair: boolean;
      demo_pair_count: number;
    };
    assert.equal(status.has_active_pair, true);
    assert.equal(status.has_real_pair, true);
    assert.ok(status.demo_pair_count >= 1, '刚插入的样板间应计入 demo_pair_count');
  } finally {
    // 清账: pair → agent → learner (agents 的 pair FK 是 restrict, 先删 pair)。
    if (createdPairIds.length)
      await db.delete(learner_agent_pairs).where(inArray(learner_agent_pairs.id, createdPairIds));
    if (createdAgentIds.length) await db.delete(agents).where(inArray(agents.id, createdAgentIds));
    if (createdLearnerIds.length) await db.delete(learners).where(inArray(learners.id, createdLearnerIds));
  }
});
