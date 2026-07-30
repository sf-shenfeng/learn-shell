// Tests for reflect_on_teaching 挂锚推断阶梯 (lib/reflection-anchor.ts)。
//
// 真实误读案例: reflect_on_teaching 成功 + close_lesson_loop 成功, 但
// closure_progress 仍报 reflection 缺——无主反思 (lesson_id=null) 聚合数不进。
// 写入侧的断根就是这套推断: 上下文能指认唯一一节课时替调用方挂上, 指认不了
// 时明确落"无主 + 警告", 绝不瞎猜。
//
// node:test / node:assert, DB-free 纯函数测试 (候选采集在 mcp/server.ts, 这里
// 只测判定)。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFLECTION_ANCHOR_RECENCY_WINDOW_MS,
  UNANCHORED_REFLECTION_WARNING,
  describeReflectionAnchorSource,
  resolveInferredReflectionAnchor,
} from './reflection-anchor';

test('阶梯1: live_session_id 参数指向 lesson 场次 → 挂那节课 (确定性链路)', () => {
  const r = resolveInferredReflectionAnchor({
    liveSessionParam: { sessionId: 'live_1', contextType: 'lesson', contextId: 'lesson_A' },
    activeLessonSessions: [],
  });
  assert.deepEqual(r, { lessonId: 'lesson_A', source: 'live_session_param', sessionId: 'live_1' });
});

test('阶梯2: live_session_id 是非 lesson 上下文 → 停止推断, 不从别处翻课出来', () => {
  const r = resolveInferredReflectionAnchor({
    liveSessionParam: { sessionId: 'live_1', contextType: 'exercise', contextId: 'ex_1' },
    // 哪怕同时有 active 教室也不看——调用方已显式挂了非课上下文。
    activeLessonSessions: [{ sessionId: 'live_2', lessonId: 'lesson_B' }],
    recentLessonSession: { sessionId: 'live_3', lessonId: 'lesson_C' },
  });
  assert.deepEqual(r, { lessonId: null, reason: 'non_lesson_live_session' });
});

test('阶梯3: 恰好一间 active 教室 → 挂它的课', () => {
  const r = resolveInferredReflectionAnchor({
    activeLessonSessions: [{ sessionId: 'live_2', lessonId: 'lesson_B' }],
  });
  assert.deepEqual(r, { lessonId: 'lesson_B', source: 'active_live_session', sessionId: 'live_2' });
});

test('阶梯3: 多间 active 教室 → 歧义不猜 (哪怕还有 recent 候选也不落到阶梯4)', () => {
  const r = resolveInferredReflectionAnchor({
    activeLessonSessions: [
      { sessionId: 'live_2', lessonId: 'lesson_B' },
      { sessionId: 'live_3', lessonId: 'lesson_C' },
    ],
    recentLessonSession: { sessionId: 'live_4', lessonId: 'lesson_D' },
  });
  assert.deepEqual(r, { lessonId: null, reason: 'ambiguous_active' });
});

test('阶梯4: 无 active 但 24h 内有最近场次 → 挂它的课 (常规流: 刚 complete 完就写反思)', () => {
  const r = resolveInferredReflectionAnchor({
    activeLessonSessions: [],
    recentLessonSession: { sessionId: 'live_5', lessonId: 'lesson_E' },
  });
  assert.deepEqual(r, { lessonId: 'lesson_E', source: 'recent_live_session', sessionId: 'live_5' });
});

test('阶梯5: 什么上下文都没有 → no_context, 由调用方落无主+警告', () => {
  const r = resolveInferredReflectionAnchor({ activeLessonSessions: [] });
  assert.deepEqual(r, { lessonId: null, reason: 'no_context' });
});

test('active 教室优先于 recent 候选 (人在教室里写反思, 上下文以教室为准)', () => {
  const r = resolveInferredReflectionAnchor({
    activeLessonSessions: [{ sessionId: 'live_2', lessonId: 'lesson_B' }],
    recentLessonSession: { sessionId: 'live_5', lessonId: 'lesson_E' },
  });
  assert.equal(r.lessonId, 'lesson_B');
});

test('回执措辞: 每个来源都有人话描述, 警告文案点名 lesson_id 与 closure 后果', () => {
  for (const source of ['live_session_param', 'active_live_session', 'recent_live_session'] as const) {
    assert.ok(describeReflectionAnchorSource(source).length > 0);
  }
  assert.match(UNANCHORED_REFLECTION_WARNING, /lesson_id/);
  assert.match(UNANCHORED_REFLECTION_WARNING, /closure/);
});

test('推断窗口常量存在且为正 (阶梯4 的"最近"有明确定义, 不是无限回看)', () => {
  assert.ok(REFLECTION_ANCHOR_RECENCY_WINDOW_MS > 0);
  assert.equal(REFLECTION_ANCHOR_RECENCY_WINDOW_MS, 24 * 60 * 60 * 1000);
});
