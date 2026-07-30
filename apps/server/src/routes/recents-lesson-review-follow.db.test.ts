// DB 集成测试: Recents "最近接触"二期 (2026-07-30) —— Lesson 行与 Review 行。
//
// 病根 (学习者实测): 一期修好了文档行/导图行, 但左栏另外两行还在撒谎 ——
//   · Lesson 行认的是**活跃契约**的 course_id。契约不换课, 这行就永远指着同
//     一门, 她读了别的课回来纹丝不动。
//   · Review 行只有一个到期计数, 零最近性语义, 完全不反映她刚复习的那组卡。
// 修法: `lesson.viewed` 的 payload 加一枚可选 `course_id`; 新增
// `review.viewed` 事件类型 (payload 带 deck_id)。两者都跑既有 sessions/events
// 轨道 —— session_events.payload 是 text 列, **零迁移**, 不动 drizzle。
//
// 本测试守的是服务端这一半 (选取规则那一半在
// apps/web/src/shell/recentSignals.test.ts, 无库可跑):
//   · 新事件类型 review.viewed 被 /api/sessions/events 白名单收下 (201);
//   · lesson.viewed 带 course_id 能原样落库并读回来 (payload 不被裁字段);
//   · **向后兼容**: 不带 course_id 的 lesson.viewed 依旧收 201 并原样存 ——
//     存量事件不迁移不回填, 老写法必须继续能写;
//   · 白名单仍然拦得住没登记的类型 (400), 别一改就把闸门开漏了。
//
// RUN_DB_TESTS=1 门控 + requireBenchDatabase 硬闸门, 同仓内既定纪律。
// node:test / node:assert, zero new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const dbSkip = process.env.RUN_DB_TESTS !== '1';
const skipNote = dbSkip && '需 RUN_DB_TESTS=1 + 已迁移的 bench Postgres (待验收时跑)';

test('Recents 二期: lesson.viewed 带 course_id / review.viewed 入轨, 且旧写法不破', { skip: skipNote }, async () => {
  const { requireBenchDatabase } = await import('../lib/require-bench-db');
  requireBenchDatabase(
    process.env.DATABASE_URL,
    'recents-lesson-review-follow.db.test.ts (creates 测试 pair/session 数据)'
  );

  const { db } = await import('../db/client');
  const { eq } = await import('drizzle-orm');
  const { learners, agents, learner_agent_pairs, learning_sessions } = await import('../db/schema');
  const { default: app } = await import('../index');

  const suffix = `rlr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const learnerId = `lrn_${suffix}`;
  const agentId = `agt_${suffix}`;
  const pairId = `pair_${suffix}`;

  /** 发一枚事件, 返回 [status, session_id]。 */
  const fire = async (
    event_type: string,
    payload: Record<string, unknown>
  ): Promise<[number, string | null]> => {
    const res = await app.request('/api/sessions/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pair_id: pairId, event_type, payload }),
    });
    if (res.status !== 201) return [res.status, null];
    return [res.status, ((await res.json()) as { session_id: string }).session_id];
  };

  const eventsOf = async (sessionId: string) => {
    const res = await app.request(`/api/sessions/${sessionId}/events`);
    assert.equal(res.status, 200);
    return (await res.json()) as { event_type: string; payload: Record<string, unknown> }[];
  };

  try {
    await db.insert(learners).values({
      id: learnerId,
      display_name: `测试最近接触二期学习者 ${suffix}`,
      preferences: { timezone: 'UTC', locale: 'zh-CN' },
    });
    await db.insert(agents).values({
      id: agentId,
      display_name: `测试最近接触二期老师 ${suffix}`,
      provider: 'test',
    });
    await db.insert(learner_agent_pairs).values({
      id: pairId,
      learner_id: learnerId,
      agent_id: agentId,
      active: true,
    });

    // ---- lesson.viewed 带 course_id: 收下并原样存 ----
    const [statusWithCourse, sessionId] = await fire('lesson.viewed', {
      lesson_id: 'lsn_x',
      position_at_close: 0.6,
      course_id: 'crs_x',
    });
    assert.equal(statusWithCourse, 201, '带 course_id 的 lesson.viewed 应被收下');
    assert.ok(sessionId, '应返回 session_id');

    // ---- 向后兼容: 不带 course_id 的老写法照样收 ----
    const [statusLegacy] = await fire('lesson.viewed', {
      lesson_id: 'lsn_legacy',
      position_at_close: 0.2,
    });
    assert.equal(statusLegacy, 201, '不带 course_id 的老写法必须继续能写 (存量不迁移)');

    // ---- 新类型 review.viewed 入白名单 ----
    const [statusReview] = await fire('review.viewed', { deck_id: 'FSA', course_id: 'crs_x' });
    assert.equal(statusReview, 201, 'review.viewed 应被 sessions/events 白名单收下');
    // "全部到期"那一档: deck_id 记 null, 同样是合法载荷
    const [statusReviewAll] = await fire('review.viewed', { deck_id: null, course_id: null });
    assert.equal(statusReviewAll, 201, 'deck_id 为 null 的 review.viewed 同样合法');

    // ---- 读回来: payload 字段不被裁 ----
    const events = await eventsOf(sessionId!);
    const withCourse = events.find(
      (e) => e.event_type === 'lesson.viewed' && e.payload.lesson_id === 'lsn_x'
    );
    assert.ok(withCourse, '应能读回带 course_id 的那枚 lesson.viewed');
    assert.equal(withCourse.payload.course_id, 'crs_x', 'course_id 必须原样存活 (左栏靠它选课)');

    const legacy = events.find(
      (e) => e.event_type === 'lesson.viewed' && e.payload.lesson_id === 'lsn_legacy'
    );
    assert.ok(legacy, '应能读回不带 course_id 的那枚');
    assert.equal(legacy.payload.course_id, undefined, '老事件读回来仍然没有 course_id');

    const review = events.find(
      (e) => e.event_type === 'review.viewed' && e.payload.deck_id === 'FSA'
    );
    assert.ok(review, '应能读回 review.viewed');
    assert.equal(review.payload.deck_id, 'FSA', 'deck_id 就是左栏显示的名字, 必须原样存活');

    // ---- 闸门仍在: 没登记的类型照样 400 ----
    const [statusBogus] = await fire('lesson.teleported', { lesson_id: 'nope' });
    assert.equal(statusBogus, 400, '白名单外的 event_type 仍应被拒 (别一改就开漏)');
  } finally {
    await db.delete(learning_sessions).where(eq(learning_sessions.pair_id, pairId));
    await db.delete(learner_agent_pairs).where(eq(learner_agent_pairs.id, pairId));
    await db.delete(learners).where(eq(learners.id, learnerId));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
});
