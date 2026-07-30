// Unit tests for tool-envelope.ts (Agent Surface Hardening 第一批
// — unified machine receipt envelope for MCP tool results).
//
// No DB needed: buildSuccessEnvelope/toResult/success/fail/classifyThrown
// are pure, and runIdempotentMutation's no-key path never touches storage
// (see idempotency.test.ts for why that's safe to exercise here too).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSuccessEnvelope,
  buildErrorEnvelope,
  toResult,
  success,
  fail,
  classifyThrown,
  errorFromException,
  runIdempotentMutation,
} from './tool-envelope';
import { IdempotencyKeyReusedError } from './idempotency';
import { McpToolError, validationError, notFoundError } from './mcp-errors';

test('buildSuccessEnvelope: stamps status success and carries every field through', () => {
  const envelope = buildSuccessEnvelope({
    operation: 'add_lesson',
    resource_id: 'lsn_abc',
    created_refs: { lesson_id: 'lsn_abc', course_id: 'crs_1' },
    next_recommended_actions: ['add_concept'],
    human_note: 'Created lesson lsn_abc',
  });
  assert.equal(envelope.status, 'success');
  assert.equal(envelope.operation, 'add_lesson');
  assert.equal(envelope.resource_id, 'lsn_abc');
  assert.deepEqual(envelope.created_refs, { lesson_id: 'lsn_abc', course_id: 'crs_1' });
  assert.deepEqual(envelope.next_recommended_actions, ['add_concept']);
  assert.equal(envelope.human_note, 'Created lesson lsn_abc');
});

test('toResult: success envelope has no isError, error envelope sets isError true', () => {
  const okResult = toResult(buildSuccessEnvelope({ operation: 'x', human_note: 'ok' }));
  assert.equal(okResult.isError, undefined);
  assert.equal(okResult.content.length, 1);
  assert.equal(okResult.content[0]!.type, 'text');
  const parsedOk = JSON.parse((okResult.content[0] as { text: string }).text);
  assert.equal(parsedOk.status, 'success');

  const errResult = toResult(
    buildErrorEnvelope({
      code: 'VALIDATION',
      message: 'bad input',
      retryable: false,
      recovery_hint: 'fix it',
      human_note: 'bad input',
    })
  );
  assert.equal(errResult.isError, true);
  const parsedErr = JSON.parse((errResult.content[0] as { text: string }).text);
  assert.equal(parsedErr.status, 'error');
  assert.equal(parsedErr.code, 'VALIDATION');
});

test('success()/fail() round-trip through JSON text exactly as constructed', () => {
  const result = success({ operation: 'create_course', resource_id: 'crs_1', human_note: 'Created course crs_1' });
  const parsed = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(parsed.status, 'success');
  assert.equal(parsed.resource_id, 'crs_1');

  const errResult = fail({
    code: 'NOT_FOUND',
    message: 'Lesson lsn_x not found',
    retryable: false,
    recovery_hint: 'check the id',
    human_note: 'Lesson lsn_x not found',
  });
  assert.equal(errResult.isError, true);
});

test('classifyThrown: McpToolError carries its own code/retryable/recovery_hint through untouched', () => {
  const e = validationError('goal is required', { field: 'goal' });
  const classified = classifyThrown(e);
  assert.equal(classified.code, 'VALIDATION');
  assert.equal(classified.retryable, false);
  assert.equal(classified.message, 'goal is required');
  assert.deepEqual(classified.details, { field: 'goal' });
});

test('classifyThrown: notFoundError is not retryable and codes as NOT_FOUND', () => {
  const e = notFoundError('Lesson lsn_x not found', { lesson_id: 'lsn_x' });
  const classified = classifyThrown(e);
  assert.equal(classified.code, 'NOT_FOUND');
  assert.equal(classified.retryable, false);
});

test('classifyThrown: IdempotencyKeyReusedError always codes as CONFLICT, non-retryable', () => {
  const e = new IdempotencyKeyReusedError('key_1', 'add_lesson', 'update_lesson');
  const classified = classifyThrown(e);
  assert.equal(classified.code, 'CONFLICT');
  assert.equal(classified.retryable, false);
  assert.match(classified.message, /key_1/);
});

test('classifyThrown: an unrecognized thrown value falls back to RETRYABLE', () => {
  const classified = classifyThrown(new Error('ECONNRESET'));
  assert.equal(classified.code, 'RETRYABLE');
  assert.equal(classified.retryable, true);
  assert.equal(classified.message, 'ECONNRESET');

  // Non-Error thrown values (e.g. a string) still classify without throwing.
  const classifiedString = classifyThrown('boom');
  assert.equal(classifiedString.code, 'RETRYABLE');
  assert.equal(classifiedString.message, 'boom');
});

test('errorFromException: produces an isError CallToolResult matching classifyThrown', () => {
  const e = new McpToolError('PERMISSION', 'not allowed', { retryable: false });
  const result = errorFromException(e);
  assert.equal(result.isError, true);
  const parsed = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(parsed.code, 'PERMISSION');
  assert.equal(parsed.status, 'error');
});

test('runIdempotentMutation: no key -> runs fn fresh and never stamps idempotent_replay', async () => {
  const result = await runIdempotentMutation(
    'pair_1',
    'add_flashcard',
    undefined,
    { front: 'q', back: 'a' },
    async () =>
      buildSuccessEnvelope({ operation: 'add_flashcard', resource_id: 'fc_1', human_note: 'Created flashcard fc_1' })
  );
  const parsed = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(parsed.status, 'success');
  assert.equal(parsed.resource_id, 'fc_1');
  assert.equal(parsed.idempotent_replay, undefined);
});

// ---- learner_url 绝对化 ----
// buildSuccessEnvelope 是所有写工具回执的唯一豁口, 十处 learner_url 回执
// (add_lesson / publish_lesson / add_document / update_document /
// add_mindmap_seed / update_mindmap_seed / propose_contract /
// live_session_start ×2 / create_course) 全部从这里过——钉这一处就钉住全部。

test('learner_url: LEARNER_APP_BASE_URL set -> relative path becomes absolute (trailing slash trimmed)', () => {
  const saved = process.env.LEARNER_APP_BASE_URL;
  try {
    process.env.LEARNER_APP_BASE_URL = 'https://ls.example.com/';
    const envelope = buildSuccessEnvelope({
      operation: 'add_lesson',
      resource_id: 'lsn_1',
      learner_url: '/courses/crs_1/lessons/lsn_1',
      human_note: 'Created lesson lsn_1',
    });
    assert.equal(envelope.learner_url, 'https://ls.example.com/courses/crs_1/lessons/lsn_1');
    // 拼了绝对链接就不需要指路尾注, human_note 保持原样。
    assert.equal(envelope.human_note, 'Created lesson lsn_1');
  } finally {
    if (saved === undefined) delete process.env.LEARNER_APP_BASE_URL;
    else process.env.LEARNER_APP_BASE_URL = saved;
  }
});

test('learner_url: base unset -> stays relative, human_note gains the one-line pointer (不猜 base)', () => {
  const saved = process.env.LEARNER_APP_BASE_URL;
  try {
    delete process.env.LEARNER_APP_BASE_URL;
    const envelope = buildSuccessEnvelope({
      operation: 'publish_lesson',
      resource_id: 'lsn_1',
      learner_url: '/courses/crs_1/lessons/lsn_1',
      human_note: 'Published lesson lsn_1',
    });
    assert.equal(envelope.learner_url, '/courses/crs_1/lessons/lsn_1');
    assert.match(envelope.human_note, /LEARNER_APP_BASE_URL not configured/);
    assert.match(envelope.human_note, /^Published lesson lsn_1 · /);
  } finally {
    if (saved === undefined) delete process.env.LEARNER_APP_BASE_URL;
    else process.env.LEARNER_APP_BASE_URL = saved;
  }
});

test('learner_url: absent or already-absolute learner_url passes through untouched', () => {
  const saved = process.env.LEARNER_APP_BASE_URL;
  try {
    process.env.LEARNER_APP_BASE_URL = 'https://ls.example.com';
    const noUrl = buildSuccessEnvelope({ operation: 'grade_exercise', human_note: 'Graded sub_1' });
    assert.equal(noUrl.learner_url, undefined);
    assert.equal(noUrl.human_note, 'Graded sub_1');
    const absolute = buildSuccessEnvelope({
      operation: 'add_lesson',
      learner_url: 'https://elsewhere.example.com/lesson',
      human_note: 'x',
    });
    assert.equal(absolute.learner_url, 'https://elsewhere.example.com/lesson');
  } finally {
    if (saved === undefined) delete process.env.LEARNER_APP_BASE_URL;
    else process.env.LEARNER_APP_BASE_URL = saved;
  }
});
