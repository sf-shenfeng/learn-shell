// Tests for 断点④ — verify_prep 结果的发布状态展示层判定.
//
// Pure functions, DB-free — no RUN_DB_TESTS gate needed (contrast with
// publish-gate.test.ts's group B, which needs a live Postgres).
//
// node:test / node:assert, zero new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublishStatusNote, publishStatusLabel } from './publish-status-note';

// ---- publishStatusLabel ----

test('publishStatusLabel: null published_at → draft', () => {
  assert.equal(publishStatusLabel(null), 'draft');
});

test('publishStatusLabel: non-null published_at → published', () => {
  assert.equal(publishStatusLabel(new Date('2026-07-17T10:00:00Z')), 'published');
});

// ---- buildPublishStatusNote ----

test('buildPublishStatusNote: PASS + draft → 明确提示尚未发布', () => {
  const note = buildPublishStatusNote('PASS', null);
  assert.match(note, /not yet published/);
  assert.match(note, /publish_lesson/);
});

test('buildPublishStatusNote: PASS_WITH_WARNINGS + draft → 同样提示尚未发布', () => {
  const note = buildPublishStatusNote('PASS_WITH_WARNINGS', null);
  assert.match(note, /not yet published/);
});

test('buildPublishStatusNote: FAIL + draft → 不附加(红灯清单本身已说明白)', () => {
  const note = buildPublishStatusNote('FAIL', null);
  assert.equal(note, '');
});

test('buildPublishStatusNote: already published → 附时间戳, 不提示尚未发布', () => {
  const publishedAt = new Date('2026-07-17T10:00:00Z');
  const note = buildPublishStatusNote('PASS', publishedAt);
  assert.match(note, /published at/);
  assert.match(note, /2026-07-17T10:00:00\.000Z/);
  assert.doesNotMatch(note, /not yet published/);
});

test('buildPublishStatusNote: FAIL + published → 仍附已发布时间戳 (published_at 优先于状态判定)', () => {
  const publishedAt = new Date('2026-07-17T10:00:00Z');
  const note = buildPublishStatusNote('FAIL', publishedAt);
  assert.match(note, /published at/);
});
