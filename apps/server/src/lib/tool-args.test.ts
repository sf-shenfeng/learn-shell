// Regression tests for bench fresh-agent run 0:
// adhoc_message_send died six times in a row with postgres-js
// `UNDEFINED_VALUE: Undefined values are not allowed` because the MCP SDK
// doesn't enforce inputSchema `required`, and a missing client_message_id
// flowed as `undefined` into the dedupe select's eq() — the one drizzle
// position where undefined is lethal (see lib/tool-args.ts header for the
// per-position semantics verified against drizzle-orm 0.36.4's source).
//
// These tests pin the pure half of the fix (no DB in this sandbox — same
// constraint as currentContract.test.ts): requireStringArg/requireNumberArg
// throw precise VALIDATION McpToolErrors instead of letting undefined reach
// a query, resolveClientMessageId makes the bare no-client_message_id call
// legal, and classifyThrown maps the driver/DB error codes honestly instead
// of the blanket RETRYABLE that sent the candidate into a retry loop.
// Live-fire integration proof ran against the bench instance
// (learn_shell_bench via bench/candidate-mcp.sh) — see the batch report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireStringArg, requireNumberArg, resolveClientMessageId } from './tool-args';
import { McpToolError } from './mcp-errors';
import { classifyThrown } from './tool-envelope';

// ---------------------------------------------------------------------------
// requireStringArg / requireNumberArg
// ---------------------------------------------------------------------------

test('requireStringArg: passes through a normal string', () => {
  assert.equal(requireStringArg({ thread_id: 'ah_123' }, 'thread_id'), 'ah_123');
});

test('requireStringArg: missing key throws VALIDATION naming the field', () => {
  assert.throws(
    () => requireStringArg({}, 'thread_id'),
    (e: unknown) => {
      assert.ok(e instanceof McpToolError);
      assert.equal(e.code, 'VALIDATION');
      assert.equal(e.retryable, false);
      assert.match(e.message, /thread_id is required/);
      assert.deepEqual(e.details, { field: 'thread_id' });
      return true;
    }
  );
});

test('requireStringArg: empty/whitespace-only string rejected like missing', () => {
  assert.throws(() => requireStringArg({ session_id: '' }, 'session_id'), McpToolError);
  assert.throws(() => requireStringArg({ session_id: '   ' }, 'session_id'), McpToolError);
});

test('requireStringArg: non-string values (the schema-bypass case) rejected', () => {
  assert.throws(() => requireStringArg({ lesson_id: 42 }, 'lesson_id'), McpToolError);
  assert.throws(() => requireStringArg({ lesson_id: null }, 'lesson_id'), McpToolError);
  assert.throws(() => requireStringArg({ lesson_id: { id: 'x' } }, 'lesson_id'), McpToolError);
});

test('requireNumberArg: passes finite numbers, rejects missing/NaN/strings', () => {
  assert.equal(requireNumberArg({ order: 3 }, 'order'), 3);
  assert.equal(requireNumberArg({ order: 0 }, 'order'), 0);
  assert.throws(() => requireNumberArg({}, 'order'), McpToolError);
  assert.throws(() => requireNumberArg({ order: NaN }, 'order'), McpToolError);
  assert.throws(() => requireNumberArg({ order: '3' }, 'order'), McpToolError);
});

// ---------------------------------------------------------------------------
// resolveClientMessageId — the bare-call contract:
//   无 client_message_id 的裸调用 → server mints one, call proceeds (green);
//   有 → caller's key wins, dedupe semantics unchanged.
// ---------------------------------------------------------------------------

test('resolveClientMessageId: caller-supplied id is used verbatim, not flagged generated', () => {
  const r = resolveClientMessageId('my-uuid-1');
  assert.deepEqual(r, { id: 'my-uuid-1', generated: false });
});

test('resolveClientMessageId: undefined -> server-minted id (bare call is legal)', () => {
  const r = resolveClientMessageId(undefined);
  assert.equal(r.generated, true);
  assert.match(r.id, /^ahmcli_/);
});

test('resolveClientMessageId: empty/blank/non-string treated as absent', () => {
  for (const raw of ['', '   ', null, 42, {}]) {
    const r = resolveClientMessageId(raw);
    assert.equal(r.generated, true, `expected generated=true for ${JSON.stringify(raw)}`);
    assert.match(r.id, /^ahmcli_/);
  }
});

test('resolveClientMessageId: two generated ids never collide', () => {
  const a = resolveClientMessageId(undefined);
  const b = resolveClientMessageId(undefined);
  assert.notEqual(a.id, b.id);
});

// ---------------------------------------------------------------------------
// classifyThrown — driver/DB error code mapping (an incident: the six-retry loop was
// fed by UNDEFINED_VALUE landing in the blanket-RETRYABLE fallback).
// ---------------------------------------------------------------------------

function fakeDbError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

test('classifyThrown: postgres-js UNDEFINED_VALUE -> VALIDATION, not retryable', () => {
  const classified = classifyThrown(
    fakeDbError('UNDEFINED_VALUE', 'UNDEFINED_VALUE: Undefined values are not allowed')
  );
  assert.equal(classified.code, 'VALIDATION');
  assert.equal(classified.retryable, false);
  assert.match(classified.recovery_hint, /required fields/i);
});

test('classifyThrown: 23502 not-null violation -> VALIDATION, not retryable', () => {
  const classified = classifyThrown(
    fakeDbError('23502', 'null value in column "title" violates not-null constraint')
  );
  assert.equal(classified.code, 'VALIDATION');
  assert.equal(classified.retryable, false);
});

test('classifyThrown: 23503 FK violation -> NOT_FOUND, not retryable', () => {
  const classified = classifyThrown(
    fakeDbError('23503', 'insert or update on table "teaching_moves" violates foreign key constraint')
  );
  assert.equal(classified.code, 'NOT_FOUND');
  assert.equal(classified.retryable, false);
});

test('classifyThrown: 23505 unique violation -> CONFLICT, not retryable', () => {
  const classified = classifyThrown(fakeDbError('23505', 'duplicate key value violates unique constraint'));
  assert.equal(classified.code, 'CONFLICT');
  assert.equal(classified.retryable, false);
});

test('classifyThrown: unrecognized errors still fall back to RETRYABLE', () => {
  const classified = classifyThrown(new Error('ECONNRESET'));
  assert.equal(classified.code, 'RETRYABLE');
  assert.equal(classified.retryable, true);
});
