// 下课铃门禁 (二期) — 纯判定单测, 零 DB。
// DB 穿线覆盖 (declare-close 路由/complete 门禁真实落库) 见
// routes/teaching.declare-close.db.test.ts (RUN_DB_TESTS=1 门控)。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEARNER_CLOSE_NOT_DECLARED_MESSAGE,
  evaluateCloseDeclarationGate,
  assertLearnerCloseDeclared,
} from './learner-close-declaration';
import { McpToolError } from './mcp-errors';

test('未宣告 (null/undefined) ⇒ reject, 判词即门禁文案', () => {
  for (const empty of [null, undefined]) {
    const d = evaluateCloseDeclarationGate(empty);
    assert.equal(d.kind, 'reject');
    if (d.kind === 'reject') {
      assert.equal(d.message, LEARNER_CLOSE_NOT_DECLARED_MESSAGE);
    }
  }
});

test('已宣告 (Date 或 ISO 字符串) ⇒ proceed', () => {
  assert.equal(evaluateCloseDeclarationGate(new Date()).kind, 'proceed');
  assert.equal(evaluateCloseDeclarationGate('2026-07-23T12:00:00.000Z').kind, 'proceed');
});

test('assert 包装: 未宣告抛 CONFLICT, 不可原样重试, recovery 带路', () => {
  try {
    assertLearnerCloseDeclared(null, 'ls_test_1');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof McpToolError);
    const err = e as McpToolError;
    assert.equal(err.code, 'CONFLICT');
    assert.equal(err.retryable, false);
    assert.equal(err.message, LEARNER_CLOSE_NOT_DECLARED_MESSAGE);
    // recovery 提示是人话带路: 指向下课铃 + cancel 豁免。
    assert.match(err.recovery_hint, /end-of-class bell/);
    assert.match(err.recovery_hint, /live_session_cancel/);
    assert.deepEqual(err.details, { session_id: 'ls_test_1', learner_close_declared_at: null });
  }
});

test('assert 包装: 已宣告不抛', () => {
  assert.doesNotThrow(() => assertLearnerCloseDeclared(new Date(), 'ls_test_2'));
});
