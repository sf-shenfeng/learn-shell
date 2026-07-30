// Idempotency for MCP tool / REST mutation call sites — Agent Surface
// Hardening 第一批 (red-team P1-3: "关键 mutation 接受可选
// idempotency_key; 同 key 重放返回首次结果不重复写"), hardened by red-team
// P1-06 (2026-07-24): "claim after write" → "claim first" + payload
// fingerprint.
//
// Minimal single-tenant implementation, on purpose: caller supplies an
// idempotency_key (any string — typically a uuid the agent mints once per
// logical mutation intent, e.g. right before calling add_lesson). Replaying
// the same key returns the first call's stored result without re-executing
// the write; a different key (or none) executes normally. The claim/replay/
// reject/takeover decision is split out as pure logic (no DB) in
// `decideClaimOutcome` so it's unit-testable the same way currentContract.ts's
// pickCurrentContract is — see idempotency.test.ts.
//
// P1-06 fix (residual invariant): the old flow was select-existing → run fn →
// insert-key, three steps with no DB-visible claim until *after* `fn` had
// already executed — two truly concurrent callers with the same fresh key
// could both observe "no existing row" and both run `fn`. The new flow flips
// step order: INSERT the row first (`response_json` still empty — "I'm
// working on this key"), *then* run `fn`, *then* UPDATE to backfill the
// result. A claim now exists in the DB before `fn` ever runs, so a second
// concurrent caller loses the INSERT race immediately and never runs `fn` at
// all — duplicate execution is no longer possible once the claim row exists.
// The remaining edge case is a claim whose owner crashed (or is simply slow)
// before backfilling: `decideClaimOutcome` tells "still running" (fresh
// claim, < 60s old → RETRYABLE, ask the caller to wait) apart from "orphaned"
// (stale claim, > 60s old → take over and run `fn` ourselves, then backfill).
// 60s is a judgment call, not a measured SLA — generous enough that no
// legitimate in-flight mutation in this codebase should be mistaken for
// orphaned, short enough that a genuinely crashed claim doesn't block retries
// for long. See idempotency.test.ts for the four flows this now covers:
// same-key-same-payload replay, same-key-different-payload reject,
// concurrent-double-request single-execution, and stale-claim takeover.
//
// Payload fingerprint: `payload_hash` (migration 0043) is a sha256 of a
// stable (key-sorted) JSON serialization of the mutation's input, stamped on
// at claim time. A replay whose stored payload_hash doesn't match the
// current call's is rejected as CONFLICT ("same key, different payload")
// instead of silently handing back a response that doesn't correspond to
// what was actually asked this time.
//
// Payload wiring: `runIdempotentMutation` (tool-envelope.ts) threads every MCP
// tool's raw arguments into `payload` (idempotency_key itself stripped before
// hashing, done once at the envelope layer). "Same key, different payload"
// rejection is live in production.

import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db, type DbClient } from '../db/client';
import { idempotency_keys } from '../db/schema';
import { McpToolError } from './mcp-errors';

export type { DbClient };

export class IdempotencyKeyReusedError extends Error {
  constructor(
    public readonly key: string,
    public readonly storedOperation: string,
    public readonly requestedOperation: string
  ) {
    super(
      `idempotency_key '${key}' was already used for operation '${storedOperation}', not ` +
        `'${requestedOperation}' — mint a fresh key per logical mutation, don't reuse one across tools.`
    );
    this.name = 'IdempotencyKeyReusedError';
  }
}

export interface IdempotencyOutcome<T> {
  value: T;
  replayed: boolean;
}

/** Legacy "claim after write" decision shape — kept verbatim (same signature,
 *  same behavior) because routes/write.ts's POST /reviews route calls this
 *  directly with its own hand-rolled select-then-decide-then-insert flow,
 *  outside this batch's file domain (routes/** is untouched here). Only
 *  operation-match is checked — no payload fingerprint, since that route
 *  never adopted one. New code should go through `withIdempotency` (below),
 *  which uses the claim-first `decideClaimOutcome` instead. */
interface StoredRecord {
  operation: string;
  response_json: unknown;
}

/**
 * Pure decision (legacy, unchanged): given what's already stored under a key
 * (or nothing) and the operation this call is trying to perform, decide
 * whether to replay the stored value, run fresh, or reject as key reuse.
 */
export function decideIdempotency<T>(
  key: string,
  existing: StoredRecord | null,
  requestedOperation: string
): { action: 'run' } | { action: 'replay'; value: T } | { action: 'reject'; error: IdempotencyKeyReusedError } {
  if (!existing) return { action: 'run' };
  if (existing.operation !== requestedOperation) {
    return {
      action: 'reject',
      error: new IdempotencyKeyReusedError(key, existing.operation, requestedOperation),
    };
  }
  return { action: 'replay', value: existing.response_json as T };
}

/** Row shape as read back from `idempotency_keys` — the bits `decideClaimOutcome`
 *  needs to make its decision. `created_at` doubles as "claimed_at": the
 *  claim-first INSERT and the row's creation are the same event. */
export interface StoredIdempotencyRow {
  operation: string;
  payload_hash: string | null;
  response_json: unknown;
  created_at: Date;
}

/** How long a claimed-but-not-yet-backfilled row is given the benefit of the
 *  doubt as "still genuinely running" before a fresh caller is allowed to
 *  take over and re-run it. See top-of-file note. */
export const STALE_CLAIM_MS = 60_000;

/** Recursively sorts object keys so semantically-identical payloads hash the
 *  same regardless of the order fields happened to be constructed/serialized
 *  in. Arrays keep their order (order is meaningful there); only plain object
 *  key order is normalized. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

/** Stable (key-sorted) JSON serialization — the input to the payload hash.
 *  `JSON.stringify` returns the *value* `undefined` (not a string) for inputs
 *  like `undefined` itself — falls back to the literal string `'null'` so
 *  this always returns a hashable string, notably for `withIdempotency`
 *  callers that don't pass a `payload` at all. */
export function stableStringify(value: unknown): string {
  const json = JSON.stringify(sortKeysDeep(value));
  return json === undefined ? 'null' : json;
}

/** sha256 of `stableStringify(payload)`, hex-encoded. Exported for tests. */
export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export type ClaimOutcome<T> =
  | { action: 'replay'; value: T }
  | { action: 'takeover' }
  | { action: 'reject'; error: Error }
  | { action: 'retry_later'; error: Error };

/**
 * Pure decision (no DB, no `fn` call — the part of withIdempotency worth
 * unit-testing directly, see idempotency.test.ts): given the row already
 * stored under `key` (present because our own claim INSERT lost the
 * conflict — i.e. someone got there first, possibly us on a prior attempt)
 * and the current call's operation/payload, decide whether to replay,
 * reject, ask the caller to retry later, or take the claim over.
 *
 * Not called at all when our own claim INSERT *wins* — that path is a
 * fresh claim with nothing to decide, `withIdempotency` runs `fn` directly.
 */
export function decideClaimOutcome<T>(params: {
  key: string;
  requestedOperation: string;
  requestedPayloadHash: string;
  existing: StoredIdempotencyRow | null;
  now: Date;
  staleMs?: number;
}): ClaimOutcome<T> {
  const { key, requestedOperation, requestedPayloadHash, existing, now } = params;
  const staleMs = params.staleMs ?? STALE_CLAIM_MS;

  if (!existing) {
    // We lost the INSERT race (a row existed to conflict against) but by the
    // time we read it back it was gone — should not happen in this codebase
    // (nothing deletes idempotency_keys rows today), but fail toward "ask the
    // caller to retry the whole call" rather than guessing.
    return {
      action: 'retry_later',
      error: new McpToolError(
        'RETRYABLE',
        `idempotency claim for key '${key}' vanished between insert and read-back — retry the call.`,
        { retryable: true, details: { key } }
      ),
    };
  }

  if (existing.operation !== requestedOperation) {
    return { action: 'reject', error: new IdempotencyKeyReusedError(key, existing.operation, requestedOperation) };
  }

  if (existing.response_json !== null && existing.response_json !== undefined) {
    if (existing.payload_hash != null && existing.payload_hash !== requestedPayloadHash) {
      return {
        action: 'reject',
        error: new McpToolError(
          'CONFLICT',
          `idempotency_key '${key}' was already used for operation '${requestedOperation}' with a different ` +
            `payload — same key, different payload; refusing to replay a response that doesn't match this call's arguments. ` +
            `Mint a fresh idempotency_key whenever the arguments change.`,
          { retryable: false, details: { key, operation: requestedOperation } }
        ),
      };
    }
    return { action: 'replay', value: existing.response_json as T };
  }

  // response_json still empty: claimed but not backfilled yet — either
  // genuinely in flight (fresh) or an orphaned claim from a crashed process
  // (stale). Age is measured off the claim's created_at, since claiming and
  // row-creation are the same INSERT.
  const ageMs = now.getTime() - existing.created_at.getTime();
  if (ageMs <= staleMs) {
    return {
      action: 'retry_later',
      error: new McpToolError(
        'RETRYABLE',
        `idempotency_key '${key}' is currently being executed elsewhere (claimed ${ageMs}ms ago) — ` +
          `retry shortly once the in-flight call finishes.`,
        { retryable: true, details: { key, claimed_ms_ago: ageMs } }
      ),
    };
  }
  return { action: 'takeover' };
}

export interface WithIdempotencyOptions {
  /** Transaction handle to share a caller's transaction (e.g. a route that
   *  wraps a whole read-compute-write in one transaction and wants the
   *  idempotency claim inside it too). Defaults to the module-level pool. */
  dbClient?: DbClient;
  /** The mutation's input, used to compute `payload_hash` at claim time
   *  (threaded from every runIdempotentMutation call site). */
  payload?: unknown;
}

/**
 * Runs `fn` and caches its result under `key`, scoped to `operation`, using a
 * claim-first flow: a declaration row (payload_hash set, response_json still
 * empty) is INSERTed *before* `fn` runs, and backfilled with an UPDATE after.
 * When `key` is undefined, this is a no-op passthrough — always runs `fn`
 * fresh, so every call site stays backward-compatible for a caller that
 * doesn't pass a key.
 */
export async function withIdempotency<T>(
  pairId: string,
  operation: string,
  key: string | undefined,
  fn: () => Promise<T>,
  opts: WithIdempotencyOptions = {}
): Promise<IdempotencyOutcome<T>> {
  if (!key) {
    return { value: await fn(), replayed: false };
  }

  const dbClient = opts.dbClient ?? db;
  const payloadHash = hashPayload(opts.payload);

  const [claimed] = await dbClient
    .insert(idempotency_keys)
    .values({ key, pair_id: pairId, operation, payload_hash: payloadHash, response_json: null })
    .onConflictDoNothing()
    .returning({ key: idempotency_keys.key });

  if (claimed) {
    // We won the claim race — nobody else can also win it (key is the
    // primary key), so this UPDATE targets a row only we could have left
    // empty. Guard on response_json IS NULL anyway: cheap, and keeps this
    // symmetric with the takeover branch below.
    const value = await fn();
    await dbClient
      .update(idempotency_keys)
      .set({ response_json: value as unknown })
      .where(and(eq(idempotency_keys.key, key), isNull(idempotency_keys.response_json)));
    return { value, replayed: false };
  }

  const [existingRow] = await dbClient
    .select()
    .from(idempotency_keys)
    .where(eq(idempotency_keys.key, key))
    .limit(1);

  const existing: StoredIdempotencyRow | null = existingRow
    ? {
        operation: existingRow.operation,
        payload_hash: existingRow.payload_hash,
        response_json: existingRow.response_json,
        created_at: existingRow.created_at,
      }
    : null;

  const decision = decideClaimOutcome<T>({
    key,
    requestedOperation: operation,
    requestedPayloadHash: payloadHash,
    existing,
    now: new Date(),
  });

  if (decision.action === 'reject' || decision.action === 'retry_later') {
    throw decision.error;
  }
  if (decision.action === 'replay') {
    return { value: decision.value, replayed: true };
  }

  // decision.action === 'takeover': the original claim is stale (presumed
  // crashed executor) — run fn ourselves and backfill, guarded so we don't
  // clobber a completion that raced in between our read and now.
  const value = await fn();
  await dbClient
    .update(idempotency_keys)
    .set({ response_json: value as unknown, payload_hash: payloadHash })
    .where(and(eq(idempotency_keys.key, key), isNull(idempotency_keys.response_json)));
  return { value, replayed: false };
}
