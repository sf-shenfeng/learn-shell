// update_flashcard 核心测试——改卡面的合法通道。
//
// 两组:
//   A) buildFlashcardContentPatch — 纯校验, DB-free, 随套件常跑。
//   B) DB 集成 (bench 库): 成功 patch / FSRS 调度列纹丝不动 / 他 pair 卡
//      NOT_FOUND (与不存在同报文, 不泄露存在性)。
//
// 按既定纪律 RUN_DB_TESTS=1 门控 + requireBenchDatabase 硬闸门 (7/19
// t144test 入侵案后规矩)。node:test / node:assert, zero new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlashcardContentPatch } from './flashcard-update';
import { McpToolError } from './mcp-errors';

// ---- A) buildFlashcardContentPatch (纯, DB-free) ----

test('buildFlashcardContentPatch: 空 patch 拒收 (VALIDATION)', () => {
  assert.throws(
    () => buildFlashcardContentPatch({ flashcard_id: 'fc_x' }),
    (e: unknown) => e instanceof McpToolError && e.code === 'VALIDATION'
  );
});

test('buildFlashcardContentPatch: 空白字符串拒收 (清空不是合法编辑)', () => {
  assert.throws(
    () => buildFlashcardContentPatch({ front: '   ' }),
    (e: unknown) => e instanceof McpToolError && e.code === 'VALIDATION'
  );
});

test('buildFlashcardContentPatch: 非字符串拒收', () => {
  assert.throws(
    () => buildFlashcardContentPatch({ back: 42 }),
    (e: unknown) => e instanceof McpToolError && e.code === 'VALIDATION'
  );
});

test('buildFlashcardContentPatch: 只透传给出的字段, 调度字段结构性不可达', () => {
  const patch = buildFlashcardContentPatch({
    front: '新问题',
    deck_id: 'CFA-Ethics',
    // fsrs_state/paused 即便被塞进来也不会进 patch (schema-guard 在工具面
    // 另有一层 unknown-field 拒收, 这里验证 lib 层自身的白名单)。
    fsrs_state: { due_at: 'evil' },
    paused: true,
  });
  assert.deepEqual(patch, { front: '新问题', deck_id: 'CFA-Ethics' });
});

// ---- B) DB 集成 (bench 库) ----

const dbSkip = process.env.RUN_DB_TESTS !== '1';
const skipNote = dbSkip && '需 RUN_DB_TESTS=1 + 已迁移的 bench Postgres (待验收时跑)';

test('updateFlashcardContent: 成功 patch / FSRS 不动 / 归属 NOT_FOUND 不泄露', { skip: skipNote }, async () => {
  const { requireBenchDatabase } = await import('./require-bench-db');
  requireBenchDatabase(
    process.env.DATABASE_URL,
    'flashcard-update.db.test.ts (creates 测试 pair/flashcard 数据)'
  );

  const { db } = await import('../db/client');
  const { eq, inArray } = await import('drizzle-orm');
  const { learners, agents, learner_agent_pairs, flashcards } = await import('../db/schema');
  const { newCardState } = await import('./fsrs');
  const { updateFlashcardContent } = await import('./flashcard-update');

  const suffix = `fcu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const learnerId = `lrn_${suffix}`;
  const agentId = `agt_${suffix}`;
  const pairA = `pair_${suffix}_a`;
  const pairB = `pair_${suffix}_b`;
  const cardId = `fc_${suffix}`;

  try {
    await db.insert(learners).values({
      id: learnerId,
      display_name: `测试学习者 ${suffix}`,
      preferences: { timezone: 'Asia/Shanghai', locale: 'zh-CN' },
    });
    await db.insert(agents).values({ id: agentId, display_name: `测试老师 ${suffix}`, provider: 'test' });
    // active: false — 不参与 getCurrentPairId 的"当前 pair"解析, 不干扰
    // 并行跑着的 bench 服务。
    await db.insert(learner_agent_pairs).values([
      { id: pairA, learner_id: learnerId, agent_id: agentId, active: false },
      { id: pairB, learner_id: learnerId, agent_id: agentId, active: false },
    ]);

    const fsrsBefore = newCardState(new Date('2026-07-01T00:00:00Z'));
    await db.insert(flashcards).values({
      id: cardId,
      pair_id: pairA,
      deck_id: 'deck-原',
      front: '原问题',
      back: '原答案',
      tags: ['t1'],
      source_refs: [],
      fsrs_state: fsrsBefore,
      paused: false,
    });

    // ---- 1. 单字段 patch ----
    const r1 = await updateFlashcardContent(pairA, cardId, { front: '改后的问题' });
    assert.deepEqual(r1.updated_fields, ['front']);
    assert.equal(r1.row.front, '改后的问题');
    assert.equal(r1.row.back, '原答案', '未给出的字段不动');
    assert.equal(r1.row.deck_id, 'deck-原', '未给出的字段不动');

    // ---- 2. FSRS 调度状态纹丝不动 (编辑卡面不影响复习计划) ----
    const [after1] = await db.select().from(flashcards).where(eq(flashcards.id, cardId));
    assert.ok(after1);
    assert.deepEqual(after1.fsrs_state, fsrsBefore, 'fsrs_state (due_at/stability/进度) 必须原样');
    assert.equal(after1.paused, false, 'paused 不动');
    assert.deepEqual(after1.tags, ['t1'], 'tags 不在 patch 面, 不动');

    // ---- 3. 多字段 patch ----
    const r2 = await updateFlashcardContent(pairA, cardId, {
      back: '改后的答案',
      deck_id: 'deck-新',
    });
    assert.deepEqual(r2.updated_fields, ['back', 'deck_id']);
    const [after2] = await db.select().from(flashcards).where(eq(flashcards.id, cardId));
    assert.ok(after2);
    assert.equal(after2.front, '改后的问题');
    assert.equal(after2.back, '改后的答案');
    assert.equal(after2.deck_id, 'deck-新');
    assert.deepEqual(after2.fsrs_state, fsrsBefore, '第二次编辑后 fsrs_state 仍原样');

    // ---- 4. 归属守卫: 他 pair 的卡 NOT_FOUND ----
    let foreignErr: McpToolError | undefined;
    try {
      await updateFlashcardContent(pairB, cardId, { front: '越权改' });
    } catch (e) {
      foreignErr = e as McpToolError;
    }
    assert.ok(foreignErr instanceof McpToolError && foreignErr.code === 'NOT_FOUND', '他 pair 卡应 NOT_FOUND');

    // ---- 5. 不存在的卡 NOT_FOUND, 且与他 pair 报文同形 (不泄露存在性) ----
    let missingErr: McpToolError | undefined;
    try {
      await updateFlashcardContent(pairA, `fc_${suffix}_nope`, { front: 'x' });
    } catch (e) {
      missingErr = e as McpToolError;
    }
    assert.ok(missingErr instanceof McpToolError && missingErr.code === 'NOT_FOUND');
    assert.equal(
      foreignErr!.message.replace(cardId, '<id>'),
      missingErr!.message.replace(`fc_${suffix}_nope`, '<id>'),
      '他 pair 与不存在必须同一句话 — 读不出存在性差异'
    );

    // ---- 6. 越权尝试没有写进去 ----
    const [finalRow] = await db.select().from(flashcards).where(eq(flashcards.id, cardId));
    assert.ok(finalRow);
    assert.equal(finalRow.front, '改后的问题', '越权 patch 不落库');
  } finally {
    await db.delete(flashcards).where(eq(flashcards.id, cardId));
    await db.delete(learner_agent_pairs).where(inArray(learner_agent_pairs.id, [pairA, pairB]));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(learners).where(eq(learners.id, learnerId));
  }
});
