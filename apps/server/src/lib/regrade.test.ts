// Unit tests for 重批持证 (⑤) — lib/regrade.ts 纯判定核心。
// Run via `pnpm --filter @learn-shell/server test` (node:test, zero deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PREVIOUS_FEEDBACK_SUMMARY_CHARS,
  resolveRegradeAttempt,
  summarizePreviousFeedback,
} from './regrade';

const fresh = { status: 'submitted', graded_at: null, agent_score: null, agent_feedback: null };
const graded = {
  status: 'graded',
  graded_at: new Date('2026-07-20T00:00:00Z'),
  agent_score: 0.6,
  agent_feedback: '方向搞反了',
};

test('首判: 未 graded 的提交不需要 regrade 标志', () => {
  assert.deepEqual(resolveRegradeAttempt(fresh, undefined), { kind: 'fresh' });
  // 带了也无妨 — regrade 只在已有判决时才有语义。
  assert.deepEqual(resolveRegradeAttempt(fresh, true), { kind: 'fresh' });
});

test('已 graded + 无 regrade 标志 → refused (CONFLICT 素材)', () => {
  for (const flag of [undefined, false] as const) {
    const r = resolveRegradeAttempt(graded, flag);
    assert.equal(r.kind, 'refused');
    if (r.kind !== 'refused') return;
    assert.match(r.message, /regrade/);
    assert.match(r.message, /already has a verdict/);
  }
});

test('已 graded + regrade:true → 放行, 旧判决摘要随行 (改判自由, 痕迹免费)', () => {
  const r = resolveRegradeAttempt(graded, true);
  assert.equal(r.kind, 'regrade');
  if (r.kind !== 'regrade') return;
  assert.equal(r.previous.previous_score, 0.6);
  assert.equal(r.previous.previous_feedback, '方向搞反了');
});

test('graded_at 落笔但 status 异常的行也算已有判决 (双信号任一即判)', () => {
  const r = resolveRegradeAttempt({ ...graded, status: 'submitted' }, undefined);
  assert.equal(r.kind, 'refused');
});

test('旧评语摘要截断: 超长评语只留前 N 字符 + 省略号, null 原样', () => {
  assert.equal(summarizePreviousFeedback(null), null);
  assert.equal(summarizePreviousFeedback('短评'), '短评');
  const long = 'x'.repeat(PREVIOUS_FEEDBACK_SUMMARY_CHARS + 50);
  const summary = summarizePreviousFeedback(long);
  assert.equal(summary?.length, PREVIOUS_FEEDBACK_SUMMARY_CHARS + 1);
  assert.ok(summary?.endsWith('…'));
});
