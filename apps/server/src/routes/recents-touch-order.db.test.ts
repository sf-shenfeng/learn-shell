// DB 集成测试: Recents "最近接触"排序 (2026-07-30) —— 文档行与导图行。
//
// 病根: 两行的排序键都是 `updated_at`(只在创建/编辑时写), 读一份文档、看一张
// 图都不留任何信号, 于是 Recents 显示的永远是"最近被写过"的那份, 不是刚看过
// 的那份。修法: `document.viewed` / `mindmap.viewed` 两个事件类型跑既有
// sessions/events 轨道 (无新表新列), 取数改 greatest(updated_at, 最近一条
// viewed 事件时间)。
//
// 本测试就是那句验收话的机器版——**读 A 之后 A 排前**:
//   · 先建 A 再建 B (B 的 updated_at 更新) → recent 头条是 B;
//   · 读 A (POST /api/sessions/events, document.viewed) → 头条翻成 A;
//   · 再读 B → 头条翻回 B;
//   · 导图侧同样三步 (mindmap.viewed);
//   · 无任何 viewed 事件的存量数据仍按 updated_at 排 (回落兼容不许破)。
//
// RUN_DB_TESTS=1 门控 + requireBenchDatabase 硬闸门, 同仓内既定纪律。
// node:test / node:assert, zero new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const dbSkip = process.env.RUN_DB_TESTS !== '1';
const skipNote = dbSkip && '需 RUN_DB_TESTS=1 + 已迁移的 bench Postgres (待验收时跑)';

test('Recents 最近接触: 读过的文档/看过的导图排到最前, 无事件回落 updated_at', { skip: skipNote }, async () => {
  const { requireBenchDatabase } = await import('../lib/require-bench-db');
  requireBenchDatabase(
    process.env.DATABASE_URL,
    'recents-touch-order.db.test.ts (creates 测试 pair/document/mindmap 数据)'
  );

  const { db } = await import('../db/client');
  const { eq } = await import('drizzle-orm');
  const { learners, agents, learner_agent_pairs, documents, mindmaps, learning_sessions } =
    await import('../db/schema');
  const { default: app } = await import('../index');

  const suffix = `rct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const learnerId = `lrn_${suffix}`;
  const agentId = `agt_${suffix}`;
  const pairId = `pair_${suffix}`;

  const recentDocIds = async (): Promise<string[]> => {
    const res = await app.request(`/api/pairs/${pairId}/documents/recent?limit=5`);
    assert.equal(res.status, 200);
    return ((await res.json()) as { id: string }[]).map((r) => r.id);
  };
  const mindmapIds = async (): Promise<string[]> => {
    const res = await app.request(`/api/pairs/${pairId}/mindmaps`);
    assert.equal(res.status, 200);
    return ((await res.json()) as { id: string }[]).map((r) => r.id);
  };
  const view = async (event_type: string, payload: Record<string, unknown>) => {
    const res = await app.request('/api/sessions/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pair_id: pairId, event_type, payload }),
    });
    assert.equal(res.status, 201, `${event_type} 应被 sessions/events 收下`);
  };

  try {
    await db.insert(learners).values({
      id: learnerId,
      display_name: `测试最近接触学习者 ${suffix}`,
      preferences: { timezone: 'UTC', locale: 'zh-CN' },
    });
    await db.insert(agents).values({
      id: agentId,
      display_name: `测试最近接触老师 ${suffix}`,
      provider: 'test',
    });
    await db.insert(learner_agent_pairs).values({
      id: pairId,
      learner_id: learnerId,
      agent_id: agentId,
      active: true,
    });

    // A 早于 B —— 只按 updated_at 排的话 B 永远在前。
    const docA = `doc_${suffix}_a`;
    const docB = `doc_${suffix}_b`;
    const tA = new Date(Date.now() - 60_000);
    const tB = new Date(Date.now() - 30_000);
    for (const [id, at, title] of [
      [docA, tA, `文档 A ${suffix}`],
      [docB, tB, `文档 B ${suffix}`],
    ] as const) {
      await db.insert(documents).values({
        id,
        pair_id: pairId,
        title,
        content_md: `# ${title}`,
        source: 'paste',
        created_at: at,
        updated_at: at,
      });
    }

    const mapA = `mm_${suffix}_a`;
    const mapB = `mm_${suffix}_b`;
    for (const [id, at, title] of [
      [mapA, tA, `导图 A ${suffix}`],
      [mapB, tB, `导图 B ${suffix}`],
    ] as const) {
      await db.insert(mindmaps).values({
        id,
        owner_pair_id: pairId,
        scope: 'custom',
        title,
        source: 'user',
        agent_seed_snapshot: { nodes: [], links: [] },
        content: { nodes: [], links: [] },
        created_at: at,
        updated_at: at,
      });
    }

    // ---- 回落兼容: 一个 viewed 事件都没有时, 仍是纯 updated_at 序 ----
    assert.deepEqual(await recentDocIds(), [docB, docA], '无 viewed 事件时按 updated_at 排 (存量兼容)');
    assert.deepEqual(await mindmapIds(), [mapB, mapA], '无 viewed 事件时按 updated_at 排 (存量兼容)');

    // ---- 读 A → A 排前 ----
    await view('document.viewed', { document_id: docA });
    assert.deepEqual(await recentDocIds(), [docA, docB], '读了 A 之后 A 应排最前');

    // ---- 再读 B → B 排前 (最近接触是会翻转的, 不是一次性置顶) ----
    await view('document.viewed', { document_id: docB });
    assert.deepEqual(await recentDocIds(), [docB, docA], '再读 B 之后 B 应排最前');

    // ---- 导图侧同一条规则 ----
    await view('mindmap.viewed', { mindmap_id: mapA });
    assert.deepEqual(await mindmapIds(), [mapA, mapB], '看了导图 A 之后 A 应排最前');
    await view('mindmap.viewed', { mindmap_id: mapB });
    assert.deepEqual(await mindmapIds(), [mapB, mapA], '再看导图 B 之后 B 应排最前');

    // ---- 编辑仍然算一次接触: 改 A 的内容 (updated_at 推到最新) → A 回到最前 ----
    await db.update(documents).set({ updated_at: new Date() }).where(eq(documents.id, docA));
    assert.deepEqual(await recentDocIds(), [docA, docB], '编辑过的文档同样算最近接触 (取较新者)');
  } finally {
    await db.delete(documents).where(eq(documents.pair_id, pairId));
    await db.delete(mindmaps).where(eq(mindmaps.owner_pair_id, pairId));
    await db.delete(learning_sessions).where(eq(learning_sessions.pair_id, pairId));
    await db.delete(learner_agent_pairs).where(eq(learner_agent_pairs.id, pairId));
    await db.delete(learners).where(eq(learners.id, learnerId));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
});
