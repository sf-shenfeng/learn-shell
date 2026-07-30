// Unit tests for idempotency.ts (Agent Surface Hardening 第一批,
// red-team P1-3; hardened by red-team P1-06 — claim-first + payload
// fingerprint).
//
// Same sandbox constraint as currentContract.test.ts: no live Postgres is
// reachable here. Two layers get exercised:
//   1. `decideClaimOutcome` — the pure run/replay/reject/retry_later/takeover
//      decision — directly, without a database.
//   2. `withIdempotency` end-to-end against a tiny in-memory fake `DbClient`
//      (see `makeFakeDb` below) that mimics just the drizzle call shapes
//      idempotency.ts actually uses (insert().values().onConflictDoNothing().
//      returning(), select().from().where().limit(), update().set().where()) —
//      enough to exercise the real claim/backfill/takeover flow without a
//      live connection. The no-key passthrough path never touches storage at
//      all, so it's exercised against the real module-level `db` default
//      with no fake needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideClaimOutcome,
  withIdempotency,
  hashPayload,
  IdempotencyKeyReusedError,
  type DbClient,
  type StoredIdempotencyRow,
} from './idempotency';
import { McpToolError } from './mcp-errors';

// ---------------------------------------------------------------------------
// decideClaimOutcome — pure decision, no DB
// ---------------------------------------------------------------------------

test('decideClaimOutcome: existing row vanished between insert-conflict and read-back -> retry_later', () => {
  const decision = decideClaimOutcome({
    key: 'key_1',
    requestedOperation: 'add_lesson',
    requestedPayloadHash: hashPayload({ title: 'x' }),
    existing: null,
    now: new Date(),
  });
  assert.equal(decision.action, 'retry_later');
  if (decision.action === 'retry_later') {
    assert.ok(decision.error instanceof McpToolError);
    assert.equal((decision.error as McpToolError).code, 'RETRYABLE');
  }
});

test('decideClaimOutcome: different operation under the same key -> reject as key reuse', () => {
  const existing: StoredIdempotencyRow = {
    operation: 'add_lesson',
    payload_hash: hashPayload({ title: 'x' }),
    response_json: { resource_id: 'lsn_abc' },
    created_at: new Date(),
  };
  const decision = decideClaimOutcome({
    key: 'key_1',
    requestedOperation: 'update_lesson',
    requestedPayloadHash: hashPayload({ title: 'x' }),
    existing,
    now: new Date(),
  });
  assert.equal(decision.action, 'reject');
  if (decision.action === 'reject') {
    assert.ok(decision.error instanceof IdempotencyKeyReusedError);
    assert.match(decision.error.message, /mint a fresh key/i);
  }
});

test('decideClaimOutcome: same operation, same payload, response already stored -> replay', () => {
  const payloadHash = hashPayload({ title: 'Intro to CAPM' });
  const existing: StoredIdempotencyRow = {
    operation: 'add_lesson',
    payload_hash: payloadHash,
    response_json: { resource_id: 'lsn_abc' },
    created_at: new Date(),
  };
  const decision = decideClaimOutcome<{ resource_id: string }>({
    key: 'key_1',
    requestedOperation: 'add_lesson',
    requestedPayloadHash: payloadHash,
    existing,
    now: new Date(),
  });
  assert.equal(decision.action, 'replay');
  if (decision.action === 'replay') {
    assert.deepEqual(decision.value, { resource_id: 'lsn_abc' });
  }
});

test('decideClaimOutcome: same operation, different payload, response already stored -> reject as CONFLICT (同 key 不同载荷)', () => {
  const existing: StoredIdempotencyRow = {
    operation: 'add_lesson',
    payload_hash: hashPayload({ title: 'Intro to CAPM' }),
    response_json: { resource_id: 'lsn_abc' },
    created_at: new Date(),
  };
  const decision = decideClaimOutcome({
    key: 'key_1',
    requestedOperation: 'add_lesson',
    requestedPayloadHash: hashPayload({ title: 'A totally different lesson' }),
    existing,
    now: new Date(),
  });
  assert.equal(decision.action, 'reject');
  if (decision.action === 'reject') {
    assert.ok(decision.error instanceof McpToolError);
    assert.equal((decision.error as McpToolError).code, 'CONFLICT');
    assert.match(decision.error.message, /same key, different payload/);
  }
});

test('decideClaimOutcome: legacy row with no payload_hash on file (pre-migration-0043) replays without a forced mismatch', () => {
  const existing: StoredIdempotencyRow = {
    operation: 'add_lesson',
    payload_hash: null,
    response_json: { resource_id: 'lsn_legacy' },
    created_at: new Date(),
  };
  const decision = decideClaimOutcome<{ resource_id: string }>({
    key: 'key_1',
    requestedOperation: 'add_lesson',
    requestedPayloadHash: hashPayload({ title: 'anything' }),
    existing,
    now: new Date(),
  });
  assert.equal(decision.action, 'replay');
});

test('decideClaimOutcome: claimed but not yet backfilled, fresh (< staleMs) -> retry_later', () => {
  const now = new Date();
  const existing: StoredIdempotencyRow = {
    operation: 'add_lesson',
    payload_hash: hashPayload({ title: 'x' }),
    response_json: null,
    created_at: new Date(now.getTime() - 5_000), // claimed 5s ago
  };
  const decision = decideClaimOutcome({
    key: 'key_1',
    requestedOperation: 'add_lesson',
    requestedPayloadHash: hashPayload({ title: 'x' }),
    existing,
    now,
    staleMs: 60_000,
  });
  assert.equal(decision.action, 'retry_later');
  if (decision.action === 'retry_later') {
    assert.equal((decision.error as McpToolError).code, 'RETRYABLE');
  }
});

test('decideClaimOutcome: claimed but not yet backfilled, stale (> staleMs) -> takeover', () => {
  const now = new Date();
  const existing: StoredIdempotencyRow = {
    operation: 'add_lesson',
    payload_hash: hashPayload({ title: 'x' }),
    response_json: null,
    created_at: new Date(now.getTime() - 120_000), // claimed 120s ago
  };
  const decision = decideClaimOutcome({
    key: 'key_1',
    requestedOperation: 'add_lesson',
    requestedPayloadHash: hashPayload({ title: 'x' }),
    existing,
    now,
    staleMs: 60_000,
  });
  assert.equal(decision.action, 'takeover');
});

// ---------------------------------------------------------------------------
// withIdempotency: no-key passthrough (never touches storage)
// ---------------------------------------------------------------------------

test('withIdempotency: no key given -> runs fn fresh every time, never touches storage', async () => {
  let calls = 0;
  const outcome1 = await withIdempotency('pair_1', 'add_lesson', undefined, async () => {
    calls += 1;
    return { resource_id: `lsn_${calls}` };
  });
  const outcome2 = await withIdempotency('pair_1', 'add_lesson', undefined, async () => {
    calls += 1;
    return { resource_id: `lsn_${calls}` };
  });

  assert.equal(calls, 2, 'fn should run every time when no key is supplied');
  assert.equal(outcome1.replayed, false);
  assert.equal(outcome2.replayed, false);
  assert.deepEqual(outcome1.value, { resource_id: 'lsn_1' });
  assert.deepEqual(outcome2.value, { resource_id: 'lsn_2' });
});

// ---------------------------------------------------------------------------
// withIdempotency end-to-end against a fake DbClient
// ---------------------------------------------------------------------------

interface FakeRow {
  key: string;
  pair_id: string;
  operation: string;
  payload_hash: string | null;
  response_json: unknown;
  created_at: Date;
}

/** Minimal in-memory stand-in for the one table idempotency.ts touches.
 *  Deliberately not a general drizzle mock — it only implements the exact
 *  call shapes withIdempotency issues (see file header), ignoring the actual
 *  `where`/`select` condition objects since every test here only ever has a
 *  single key in flight. Good enough to exercise claim/conflict/backfill/
 *  takeover without a live Postgres connection. */
function makeFakeDb(initial?: FakeRow) {
  let row: FakeRow | undefined = initial;

  const dbClient = {
    insert: (_table: unknown) => ({
      values: (vals: Partial<FakeRow>) => ({
        onConflictDoNothing: () => ({
          returning: async (_sel: unknown) => {
            if (row) return [];
            row = {
              key: vals.key as string,
              pair_id: vals.pair_id as string,
              operation: vals.operation as string,
              payload_hash: (vals.payload_hash as string | null) ?? null,
              response_json: vals.response_json ?? null,
              created_at: new Date(),
            };
            return [{ key: row.key }];
          },
        }),
      }),
    }),
    select: (_sel?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: async (_n: number) => (row ? [row] : []),
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (vals: Partial<FakeRow>) => ({
        where: async (_cond: unknown) => {
          if (row && row.response_json === null) {
            row = { ...row, ...vals };
          }
          return [];
        },
      }),
    }),
  };

  return { dbClient: dbClient as unknown as DbClient, getRow: () => row };
}

test('withIdempotency: fresh claim runs fn once and backfills response_json', async () => {
  const { dbClient, getRow } = makeFakeDb();
  let calls = 0;
  const outcome = await withIdempotency(
    'pair_1',
    'add_lesson',
    'key_fresh',
    async () => {
      calls += 1;
      return { resource_id: 'lsn_1' };
    },
    { dbClient, payload: { title: 'Intro' } }
  );

  assert.equal(calls, 1);
  assert.equal(outcome.replayed, false);
  assert.deepEqual(outcome.value, { resource_id: 'lsn_1' });
  assert.deepEqual(getRow()?.response_json, { resource_id: 'lsn_1' });
});

test('withIdempotency: same key + same payload replays without re-executing fn', async () => {
  const { dbClient } = makeFakeDb();
  let calls = 0;
  const runFn = async () => {
    calls += 1;
    return { resource_id: `lsn_${calls}` };
  };

  const first = await withIdempotency('pair_1', 'add_lesson', 'key_replay', runFn, {
    dbClient,
    payload: { title: 'Intro' },
  });
  const second = await withIdempotency('pair_1', 'add_lesson', 'key_replay', runFn, {
    dbClient,
    payload: { title: 'Intro' },
  });

  assert.equal(calls, 1, 'fn must not run a second time on replay');
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.value, first.value);
});

test('withIdempotency: same key + different payload is rejected as CONFLICT, not replayed', async () => {
  const { dbClient } = makeFakeDb();
  await withIdempotency('pair_1', 'add_lesson', 'key_diff_payload', async () => ({ resource_id: 'lsn_1' }), {
    dbClient,
    payload: { title: 'Intro' },
  });

  await assert.rejects(
    withIdempotency('pair_1', 'add_lesson', 'key_diff_payload', async () => ({ resource_id: 'lsn_2' }), {
      dbClient,
      payload: { title: 'A completely different lesson' },
    }),
    (e: unknown) => {
      assert.ok(e instanceof McpToolError);
      assert.equal((e as McpToolError).code, 'CONFLICT');
      assert.match((e as McpToolError).message, /same key, different payload/);
      return true;
    }
  );
});

test('withIdempotency: same key + different operation is rejected as key reuse', async () => {
  const { dbClient } = makeFakeDb();
  await withIdempotency('pair_1', 'add_lesson', 'key_op_reuse', async () => ({ resource_id: 'lsn_1' }), {
    dbClient,
  });

  await assert.rejects(
    withIdempotency('pair_1', 'update_lesson', 'key_op_reuse', async () => ({ resource_id: 'lsn_2' }), {
      dbClient,
    }),
    (e: unknown) => e instanceof IdempotencyKeyReusedError
  );
});

test('withIdempotency: concurrent double request with the same key — fn executes exactly once, the loser gets RETRYABLE', async () => {
  const { dbClient } = makeFakeDb();
  let calls = 0;

  // Both calls are fired back-to-back with no `await` in between. Thanks to
  // JS run-to-completion semantics, `first`'s synchronous prefix — including
  // its claim INSERT, which is itself synchronous in this fake — fully
  // executes before `second`'s body starts, exactly mirroring two real
  // concurrent requests where the first INSERT commits before the second is
  // attempted. This is the scenario the claim-first fix targets: the loser
  // must never run `fn`.
  const first = withIdempotency(
    'pair_1',
    'add_lesson',
    'key_concurrent',
    async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { resource_id: 'lsn_1' };
    },
    { dbClient, payload: { title: 'Intro' } }
  );
  const second = withIdempotency(
    'pair_1',
    'add_lesson',
    'key_concurrent',
    async () => {
      calls += 1;
      return { resource_id: 'lsn_should_not_run' };
    },
    { dbClient, payload: { title: 'Intro' } }
  );

  await assert.rejects(second, (e: unknown) => {
    assert.ok(e instanceof McpToolError);
    assert.equal((e as McpToolError).code, 'RETRYABLE');
    return true;
  });

  const firstOutcome = await first;
  assert.equal(calls, 1, 'fn should run exactly once despite two concurrent callers sharing a key');
  assert.equal(firstOutcome.replayed, false);
  assert.deepEqual(firstOutcome.value, { resource_id: 'lsn_1' });
});

test('withIdempotency: stale claim (crashed executor, > 60s old) is taken over and re-run', async () => {
  const { dbClient, getRow } = makeFakeDb({
    key: 'key_stale',
    pair_id: 'pair_1',
    operation: 'add_lesson',
    payload_hash: hashPayload({ title: 'Intro' }),
    response_json: null,
    created_at: new Date(Date.now() - 120_000), // claimed 120s ago, past the 60s threshold
  });

  let calls = 0;
  const outcome = await withIdempotency(
    'pair_1',
    'add_lesson',
    'key_stale',
    async () => {
      calls += 1;
      return { resource_id: 'lsn_recovered' };
    },
    { dbClient, payload: { title: 'Intro' } }
  );

  assert.equal(calls, 1);
  assert.equal(outcome.replayed, false);
  assert.deepEqual(outcome.value, { resource_id: 'lsn_recovered' });
  assert.deepEqual(getRow()?.response_json, { resource_id: 'lsn_recovered' });
});
