// Confidence 主权立法 · get_submission 教师读路径守卫 (回归 N5)。
//
// 这份文件只干一件事: 盯住 `confidence_pct` 不许出现在 get_submission 的返回体里。
//
// 为什么单开一份而不是塞进 read-back.db.test.ts: 那份的集成组按纪律被
// RUN_DB_TESTS=1 门控, 没库就 skip —— 一条会 skip 的守卫不是守卫。这份纯函数
// 测试零依赖零数据库, 随 `pnpm --filter @learn-shell/server test` 默认套件每次都跑。
//
// 断言姿态是"逐键盯死"而不是"看看有没有那个字段": 键集合精确相等, 所以
//   · 把 confidence_pct 显式加回去    → 红
//   · 图省事写成 { ...s, ... } 整行铺开 → 红 (learner_id / withdrew_at 一起漏出来)
//   · 把序数 confidence 一起误删       → 红 (过度修复也是回归)
// 三种翻车方式各有一条测试兜着。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTeacherSubmissionReadback } from './read-back';
import type { ExerciseSubmissionRow } from '../db/schema';

/** 一整行提交, confidence_pct **故意**填成非空值 —— 守卫要证明的是"喂进去了也
 *  吐不出来", 不是"上游根本没给"。取 97 而不是默认锚值 100: 一来锚值本就归学习者
 *  按 pair 自调(lib/confidence-anchors.ts), 97 是完全合法的一档; 二来这串数字在本
 *  行其它字段(时间戳/分数/id)里都不出现, 下面那条"值有没有换个名字漏出去"的扫描
 *  才不会被巧合噪音污染。 */
const ROW: ExerciseSubmissionRow = {
  id: 'sub_guard_n5',
  exercise_id: 'ex_guard_n5',
  learner_id: 'lrn_guard_n5',
  learner_answer: '学习者的作答正文。',
  status: 'graded',
  submitted_at: new Date('2026-07-20T10:00:00.000Z'),
  withdrew_at: null,
  previous_submission_id: null,
  agent_feedback: '判词: 讲对了主干。',
  agent_score: 0.85,
  graded_at: new Date('2026-07-20T11:00:00.000Z'),
  confidence: 'certain',
  confidence_pct: 97,
  live_response_id: null,
};

const SOURCE = {
  submission: ROW,
  exercise_prompt: '题面一: 请解释概念1。',
  lesson_id: 'lsn_guard_n5',
  course_id: 'crs_guard_n5',
};

/** 教师读回体的完整合法键集合。改这张单子 = 改一次教师可见面, 请当成立法动作。 */
const ALLOWED_KEYS = [
  'agent_feedback',
  'agent_score',
  'confidence',
  'course_id',
  'exercise_id',
  'exercise_prompt_excerpt',
  'graded_at',
  'learner_answer',
  'lesson_id',
  'live_response_id',
  'previous_submission_id',
  'status',
  'submission_id',
  'submitted_at',
];

test('get_submission 载荷不含 confidence_pct —— 建模层百分比不进教师读路径', () => {
  const payload = buildTeacherSubmissionReadback(SOURCE);

  assert.equal(
    Object.hasOwn(payload, 'confidence_pct'),
    false,
    'confidence_pct 出现在教师读回体里 —— Confidence 主权红线被破: ' +
      '百分比是拿学习者自己的锚值配置折算的建模层数值, 教师读路径只给序数。'
  );

  // 序列化后再查一遍: 就算有人把它塞进嵌套结构或用 getter 藏起来, JSON 也躲不掉
  // (MCP 回执最终就是把 data 序列化发出去的)。
  const wire = JSON.stringify(payload);
  assert.equal(
    wire.includes('confidence_pct'),
    false,
    'confidence_pct 出现在序列化后的 MCP 回执载荷里'
  );
  assert.equal(wire.includes('97'), false, '锚值 97 换了个名字/位置漏进了回执');
});

test('get_submission 键集合精确等于白名单 —— 整行铺开(...s)一样会红', () => {
  assert.deepEqual(
    Object.keys(buildTeacherSubmissionReadback(SOURCE)).sort(),
    [...ALLOWED_KEYS].sort(),
    '教师读回体的键集合变了。多出来的键请先确认不是学习者建模层数据; ' +
      '少掉的键说明读回被削瘸了。'
  );
});

test('序数 confidence 必须留着 —— 过度修复也是回归', () => {
  const payload = buildTeacherSubmissionReadback(SOURCE);
  assert.equal(
    payload.confidence,
    'certain',
    'confidence(序数)是"她按了哪个按钮"的事实层, 教师看得到; 删的只是百分比。'
  );
});

test('confidence 可空时照样安全 —— 学习者跳过采集不该把守卫绕开', () => {
  const payload = buildTeacherSubmissionReadback({
    ...SOURCE,
    submission: { ...ROW, confidence: null, confidence_pct: null },
  });
  assert.equal(payload.confidence, null);
  assert.equal(Object.hasOwn(payload, 'confidence_pct'), false);
});
