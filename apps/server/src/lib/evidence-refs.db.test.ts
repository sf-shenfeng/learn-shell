// DB 集成测试: 证据引用真伪校验 (lib/evidence-refs.ts) + 迁移 0044 三表新列。
//
// 覆盖 (真实 Postgres, bench 库):
//   · assertSessionEventEvidence (③) — 真 id 放行 / 幽灵 id 拒并列坏 id /
//     他 pair id 拒 (归属)
//   · assertEvidenceRefs — 多落点表放行 / 幽灵拒
//   · assertActionLinkTarget (④) — 按 type 落点验存在+归属
//   · checkLiveResponseRef — 真 Live 回答放行 / 他 pair 拒
//   · 0044 新列读写 — 评估两表 learner_note/evidence_refs; learners.locale
//     贯通 buildIdentity; exercise_submissions.live_response_id 贯通
//     getSubmissionReadback
//
// 按 publish-gate.test.ts 的既定纪律 RUN_DB_TESTS=1 门控: 本地无库自动 skip。
// node:test / node:assert, zero new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const dbSkip = process.env.RUN_DB_TESTS !== '1';
const skipNote = dbSkip && '需 RUN_DB_TESTS=1 + 已迁移(0044+)的 Postgres bench 库';

test('证据引用硬闸 + 0044 三通道/locale/live_response_id 贯通', { skip: skipNote }, async () => {
  const { requireBenchDatabase } = await import('./require-bench-db');
  requireBenchDatabase(
    process.env.DATABASE_URL,
    'evidence-refs.db.test.ts (creates 测试学习者/测试老师/测试证据链)'
  );

  const { db } = await import('../db/client');
  const { inArray, eq } = await import('drizzle-orm');
  const schema = await import('../db/schema');
  const {
    learners,
    agents,
    learner_agent_pairs,
    learning_sessions,
    session_events,
    courses,
    lessons,
    exercises,
    exercise_submissions,
    learner_hypotheses,
    live_sessions,
    teaching_moves,
    teaching_responses,
    live_session_evaluations,
    post_lesson_evaluations,
  } = schema;
  const {
    assertSessionEventEvidence,
    assertEvidenceRefs,
    assertActionLinkTarget,
    checkLiveResponseRef,
  } = await import('./evidence-refs');
  const { buildIdentity } = await import('./context-brief');
  const { getSubmissionReadback } = await import('./read-back');
  const { McpToolError } = await import('./mcp-errors');

  const suffix = `evref_${Date.now()}`;
  const id = (p: string) => `${p}_${suffix}`;
  const now = new Date();

  // 主 pair + 陪练 pair (归属校验的对照组)。
  const pairId = id('pair');
  const otherPairId = id('pair_other');

  try {
    // ---- fixtures ----
    await db.insert(learners).values([
      {
        id: id('lrn'),
        display_name: '测试学习者 evref',
        preferences: { timezone: 'UTC', locale: 'zh-CN' },
        locale: 'zh-CN',
      },
      {
        id: id('lrn_other'),
        display_name: '测试学习者 evref 对照',
        preferences: { timezone: 'UTC', locale: 'en' },
        locale: null,
      },
    ]);
    await db.insert(agents).values({ id: id('agt'), display_name: '测试老师 evref', provider: 'test' });
    await db.insert(learner_agent_pairs).values([
      { id: pairId, learner_id: id('lrn'), agent_id: id('agt') },
      { id: otherPairId, learner_id: id('lrn_other'), agent_id: id('agt') },
    ]);

    // 事件流: 本 pair 一条, 他 pair 一条。
    await db.insert(learning_sessions).values([
      { id: id('ls'), pair_id: pairId, started_at: now },
      { id: id('ls_other'), pair_id: otherPairId, started_at: now },
    ]);
    const mkEvent = (eid: string, pid: string, sid: string) => ({
      event_id: eid,
      pair_id: pid,
      session_id: sid,
      event_type: 'exercise.submitted' as const,
      actor_type: 'learner' as const,
      actor_id: 'test',
      recorded_by: 'test',
      occurred_at: now,
      permission_state: 'authorized' as const,
      payload: {},
    });
    await db.insert(session_events).values([
      mkEvent(id('evt'), pairId, id('ls')),
      mkEvent(id('evt_other'), otherPairId, id('ls_other')),
    ]);

    // 课程链: course → lesson → exercise → submission。
    await db.insert(courses).values({
      id: id('crs'),
      pair_id: pairId,
      topic: 'evref 测试课',
      structure: { lesson_ids: [id('lsn')] },
    });
    await db.insert(lessons).values({ id: id('lsn'), course_id: id('crs'), order: 1, title: '测试课文' });
    await db.insert(exercises).values({
      id: id('ex'),
      lesson_id: id('lsn'),
      order: 1,
      prompt: '题面',
      reference_answer: '参考答案',
      agent_skill_used: 'test',
    });

    // Live 链: session → move → response。
    await db.insert(live_sessions).values([
      { id: id('live'), pair_id: pairId, context_type: 'lesson', context_id: id('lsn') },
      { id: id('live_other'), pair_id: otherPairId, context_type: 'lesson', context_id: 'lsn_x' },
    ]);
    await db.insert(teaching_moves).values({
      id: id('mv'),
      session_id: id('live'),
      seq: 1,
      move_type: 'ASK',
      content: '问题',
      response_kind: 'text',
    });
    await db.insert(teaching_responses).values({
      id: id('tr'),
      session_id: id('live'),
      move_id: id('mv'),
      client_response_id: id('cli'),
      content: 'Live 里的回答原文',
    });

    // 假设 (action_link hypothesis_update 落点)。
    await db.insert(learner_hypotheses).values({
      id: id('hyp'),
      pair_id: pairId,
      domain: 'evref-domain',
      observation: 'obs',
      confidence: 0.5,
      written_by_agent_id: 'test',
    });

    // ---- ③ assertSessionEventEvidence ----
    await assertSessionEventEvidence(pairId, [id('evt')]); // 真 id 放行
    await assertSessionEventEvidence(pairId, []); // 空数组合法 (① 的领地)
    await assert.rejects(
      () => assertSessionEventEvidence(pairId, [id('evt'), 'evt_ghost']),
      (e: unknown) => {
        assert.ok(e instanceof McpToolError);
        assert.equal(e.code, 'VALIDATION');
        assert.match(e.message, /evt_ghost/);
        assert.ok(!e.message.includes(id('evt')), '坏 id 清单不冤枉真 id');
        return true;
      },
      '幽灵 id 必须被拒并点名'
    );
    await assert.rejects(
      () => assertSessionEventEvidence(pairId, [id('evt_other')]),
      /invalid evidence id/,
      '他 pair 的真事件 = 本 pair 的幽灵 (归属校验)'
    );

    // ---- submission (含 live_response_id 贯通) ----
    await db.insert(exercise_submissions).values({
      id: id('sub'),
      exercise_id: id('ex'),
      learner_id: id('lrn'),
      learner_answer: '我的作答',
      status: 'submitted',
      submitted_at: now,
      live_response_id: id('tr'),
    });

    // ---- 三通道 assertEvidenceRefs ----
    await assertEvidenceRefs(pairId, [id('sub'), id('tr'), id('evt')]); // 多落点放行
    await assert.rejects(
      () => assertEvidenceRefs(pairId, [id('sub'), 'sub_ghost']),
      /invalid reference id.*sub_ghost/s
    );
    await assert.rejects(() => assertEvidenceRefs(otherPairId, [id('sub')]), /invalid reference id/);

    // ---- ④ assertActionLinkTarget ----
    await assertActionLinkTarget(pairId, 'hypothesis_update', id('hyp'));
    await assertActionLinkTarget(pairId, 'lesson_revision', id('lsn')); // 课文本体也是合法落点
    await assert.rejects(
      () => assertActionLinkTarget(pairId, 'hypothesis_update', 'hyp_ghost'),
      (e: unknown) => {
        assert.ok(e instanceof McpToolError);
        assert.equal(e.code, 'VALIDATION');
        assert.match(e.message, /hyp_ghost/);
        return true;
      }
    );
    await assert.rejects(
      // 类型不匹配的落点: 真实存在的 lesson 不是 hypothesis_update 的合法落点。
      () => assertActionLinkTarget(pairId, 'hypothesis_update', id('lsn')),
      /does not exist or does not belong to the current pair/
    );

    // ---- checkLiveResponseRef ----
    const okRef = await checkLiveResponseRef(pairId, id('tr'));
    assert.deepEqual(okRef, { ok: true, live_session_id: id('live') });
    assert.deepEqual(await checkLiveResponseRef(pairId, 'tr_ghost'), { ok: false });
    assert.deepEqual(await checkLiveResponseRef(otherPairId, id('tr')), { ok: false }, '跨 pair 拒');

    // ---- 0044 新列读写: 评估两表 ----
    await db.insert(live_session_evaluations).values({
      id: id('lse'),
      pair_id: pairId,
      live_session_id: id('live'),
      agent_observation: '内账判词 (tr 引用见 evidence_refs)',
      learner_note: '这节课你把间接法的骨架立住了',
      evidence_refs: [id('tr')],
    });
    const [lseRow] = await db
      .select()
      .from(live_session_evaluations)
      .where(eq(live_session_evaluations.id, id('lse')));
    assert.equal(lseRow!.learner_note, '这节课你把间接法的骨架立住了');
    assert.deepEqual(lseRow!.evidence_refs, [id('tr')]);

    await db.insert(post_lesson_evaluations).values({
      id: id('ple'),
      pair_id: pairId,
      lesson_id: id('lsn'),
      flashcards_rating_distribution: { Again: 0, Hard: 0, Good: 1, Easy: 0 },
      agent_observation: '内账总评',
      learner_note: '总评人话版',
      evidence_refs: [id('sub')],
    });
    const [pleRow] = await db
      .select()
      .from(post_lesson_evaluations)
      .where(eq(post_lesson_evaluations.id, id('ple')));
    assert.equal(pleRow!.learner_note, '总评人话版');
    assert.deepEqual(pleRow!.evidence_refs, [id('sub')]);
    // 未写的存量形状: 可空, 不是空字符串。
    assert.equal(lseRow!.created_at instanceof Date, true);

    // ---- locale 贯通 brief identity ----
    const identity = await buildIdentity(pairId);
    assert.equal(identity?.learner.locale, 'zh-CN');
    const identityOther = await buildIdentity(otherPairId);
    assert.equal(identityOther?.learner.locale, null, '没表达过语言 = null, 不猜');

    // ---- 读回面贯通 ----
    const readback = await getSubmissionReadback(pairId, id('sub'));
    assert.equal(readback.live_response_id, id('tr'));
  } finally {
    // 清理: pair 级 cascade 覆盖大多数表; learners/agents 单独清。
    await db.delete(learner_agent_pairs).where(inArray(learner_agent_pairs.id, [pairId, otherPairId]));
    await db.delete(learners).where(inArray(learners.id, [id('lrn'), id('lrn_other')]));
    await db.delete(agents).where(eq(agents.id, id('agt')));
  }
});
