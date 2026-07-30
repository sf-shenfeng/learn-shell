// Unit tests for content-hash.ts — 纯函数, 无 DB。
// Run via `pnpm --filter @learn-shell/server test`
// (tsx --test / node:assert, zero deps, same harness as close-loop-guard.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, contentHash12 } from './content-hash';

test('contentHash12: 12 lowercase hex chars', () => {
  const h = contentHash12({ a: 1 });
  assert.match(h, /^[0-9a-f]{12}$/);
});

test('canonicalJson: key order does not change the serialization (deep)', () => {
  const a = { x: 1, y: { b: 2, a: [{ q: 1, p: 2 }] } };
  const b = { y: { a: [{ p: 2, q: 1 }], b: 2 }, x: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(contentHash12(a), contentHash12(b));
});

test('canonicalJson: arrays keep their order (order IS content)', () => {
  assert.notEqual(contentHash12({ a: [1, 2] }), contentHash12({ a: [2, 1] }));
});

test('contentHash12: different content → different hash (sanity)', () => {
  assert.notEqual(contentHash12({ a: 1 }), contentHash12({ a: 2 }));
});

test('canonicalJson: undefined fields drop, matching JSON.stringify semantics', () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
});

test('canonicalJson: Date serializes as its ISO string', () => {
  const d = new Date('2026-07-14T00:00:00.000Z');
  assert.equal(canonicalJson({ t: d }), canonicalJson({ t: '2026-07-14T00:00:00.000Z' }));
});
