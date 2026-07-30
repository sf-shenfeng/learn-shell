// DB 集成测试: 假设生命周期 × buildLearnerBrief (真实 Postgres)。
//
// 纯判定已在 hypothesis-lifecycle.test.ts 无库覆盖; 这里验证的是穿过真实
// schema (迁移 0041 的 last_evidence_at 列) 的读路径: 简报限载 (cap=5 排序 +
// 判决排除 + 计数行/在册计数) 与 reinforce 补丁真实落库后简报口径的变化。
// 按 publish-gate.test.ts 的既定纪律 RUN_DB_TESTS=1 门控: 本地无库自动 skip,
// 验收时开 (需已迁移至 0041+ 的 Postgres + DATABASE_URL)。
//
// node:test / node:assert, zero new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const dbSkip = process.env.RUN_DB_TESTS !== '1';
const skipNote = dbSkip && '需 RUN_DB_TESTS=1 + 已迁移(0041+)的 Postgres (待验收时跑)';

test(
  '假设生命周期: 简报限载 cap=5 排序/判决排除/计数行 + reinforce 真实落库后续期生效',
  { skip: skipNote },
  async () => {
    const { requireBenchDatabase } = await import('./require-bench-db');
    // 硬闸门 — 库名不是 *_bench 就直接拒绝, 不把测试数据写进错的库。
    requireBenchDatabase(
      process.env.DATABASE_URL,
      'hypothesis-lifecycle.db.test.ts (creates 测试学习者/测试老师/测试假设)'
    );

    const { db } = await import('../db/client');
    const { eq } = await import('drizzle-orm');
    const { learners, agents, learner_agent_pairs, learner_hypotheses } = await import('../db/schema');
    const { buildLearnerBrief } = await import('./context-brief');
    const { planHypothesisAction, HYPOTHESIS_STALE_AFTER_DAYS } = await import('./hypothesis-lifecycle');

    const suffix = `hyplc_${Date.now()}`;
    const learnerId = `lrn_${suffix}`;
    const agentId = `agt_${suffix}`;
    const pairId = `pair_${suffix}`;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = new Date();
    const daysAgo = (n: number) => new Date(now.getTime() - n * DAY_MS);

    const mkHyp = (id: string, status: string, lastEvidenceDaysAgo: number, extra: Record<string, unknown> = {}) => ({
      id: `hyp_${suffix}_${id}`,
      pair_id: pairId,
      domain: `d_${id}`,
      observation: `obs ${id}`,
      evidence_event_ids: [],
      counterevidence_event_ids: [],
      confidence: 0.5,
      status,
      written_by_agent_id: 'test',
      from_session_id: null,
      user_approved: null,
      user_note: null,
      last_verified_at: null,
      last_evidence_at: daysAgo(lastEvidenceDaysAgo),
      allowed_for_teaching: true,
      created_at: daysAgo(90),
      updated_at: daysAgo(lastEvidenceDaysAgo),
      ...extra,
    });

    try {
      await db.insert(learners).values({
        id: learnerId,
        display_name: '测试学习者 hyplc',
        preferences: { timezone: 'Asia/Shanghai', locale: 'zh-CN' },
      });
      await db.insert(agents).values({ id: agentId, display_name: '测试老师 hyplc', provider: 'test' });
      await db.insert(learner_agent_pairs).values({ id: pairId, learner_id: learnerId, agent_id: agentId });

      // 8 行: 在场 6 (active×3 + confirmed×1 + tentative×2), 排除 3
      // (rejected/frozen/expired)。其中 a_stale 的证据已超阈值。
      await db.insert(learner_hypotheses).values([
        mkHyp('a_fresh', 'active', 1),
        mkHyp('a_mid', 'active', 10),
        mkHyp('a_stale', 'active', HYPOTHESIS_STALE_AFTER_DAYS + 5),
        mkHyp('conf', 'confirmed', 5, { user_approved: true }),
        mkHyp('t_fresh', 'tentative', 0),
        mkHyp('t_old', 'tentative', 60),
        mkHyp('rej', 'rejected', 1, { user_approved: false, allowed_for_teaching: false }),
        mkHyp('frz', 'frozen', 1, { allowed_for_teaching: false }),
        mkHyp('exp', 'expired', 1),
      ]);

      const brief = await buildLearnerBrief(pairId, 5);
      assert.equal(brief.hypotheses_in_book_count, 6, '在册计数排除 rejected/frozen/expired');
      assert.equal(brief.hypotheses_note, '6 on record, brief carries only the 5 most recent with evidence');
      assert.equal(brief.top_confidence_hypotheses.length, 5, '限载 cap=5');
      const ids = brief.top_confidence_hypotheses.map((h) => h.id);
      assert.deepEqual(
        ids,
        [
          `hyp_${suffix}_a_fresh`,
          `hyp_${suffix}_conf`,
          `hyp_${suffix}_a_mid`,
          `hyp_${suffix}_a_stale`,
          `hyp_${suffix}_t_fresh`,
        ],
        'active+confirmed 按证据新鲜度降序优先, tentative 殿后, t_old 被截掉'
      );
      // 学习者判决排除到底: rejected/frozen 连 redacted 存根都不出现。
      assert.ok(!ids.includes(`hyp_${suffix}_rej`) && !ids.includes(`hyp_${suffix}_frz`));
      for (const item of brief.top_confidence_hypotheses) {
        assert.ok(item.allowed_for_teaching, '简报里不应再出现 redacted 存根');
      }
      // 陈旧标注只亮在超阈值那条。
      const staleFlags = Object.fromEntries(
        brief.top_confidence_hypotheses.map((h) => [h.id, 'stale' in h ? h.stale : undefined])
      );
      assert.equal(staleFlags[`hyp_${suffix}_a_stale`], true);
      assert.equal(staleFlags[`hyp_${suffix}_a_fresh`], undefined);

      // reinforce 真实落库: a_stale 续期后翻回最前排且不再 stale。
      const [staleRow] = await db
        .select()
        .from(learner_hypotheses)
        .where(eq(learner_hypotheses.id, `hyp_${suffix}_a_stale`))
        .limit(1);
      assert.ok(staleRow);
      const plan = planHypothesisAction(staleRow!, 'reinforce', { evidence_event_ids: ['evt_new'] }, now);
      assert.equal(plan.kind, 'patch');
      if (plan.kind !== 'patch') return;
      await db.update(learner_hypotheses).set(plan.patch).where(eq(learner_hypotheses.id, staleRow!.id));

      const after = await buildLearnerBrief(pairId, 5);
      const first = after.top_confidence_hypotheses[0]!;
      assert.equal(first.id, `hyp_${suffix}_a_stale`, 'reinforce 后按 last_evidence_at 翻回最前排');
      assert.ok(!('stale' in first), 'reinforce 后不再读作陈旧');
      // 证据账追加落库 (计数=数组长度, 不另立列)。
      const [reRead] = await db
        .select()
        .from(learner_hypotheses)
        .where(eq(learner_hypotheses.id, staleRow!.id))
        .limit(1);
      assert.deepEqual(reRead!.evidence_event_ids, ['evt_new']);
      // 简报模型变了 ⇒ etag 必须翻转 (get_context 去重契约)。
      assert.notEqual(after.brief_etag, brief.brief_etag);
    } finally {
      // learner_agent_pairs cascade 会带走 hypotheses; learners/agents 手动清。
      await db.delete(learner_agent_pairs).where(eq(learner_agent_pairs.id, pairId));
      await db.delete(learners).where(eq(learners.id, learnerId));
      await db.delete(agents).where(eq(agents.id, agentId));
    }
  }
);
