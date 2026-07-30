// Drizzle: idempotency_keys — Agent Surface Hardening 第一批
// (red-team P1-3).
//
// One small generic table rather than a bespoke unique column per mutation
// (the pattern ad_hoc_messages.client_message_id / teaching_responses.
// client_response_id already use for their one table each) — the receipts
// vary in shape across every write path this batch wires idempotency into
// (add_lesson / update_lesson / add_flashcard / grade_exercise /
// reflect_on_teaching / record_learner_hypothesis / the flashcard-grading
// REST route), so a generic {key -> stored response} cache is far less
// invasive than adding a unique column + dedupe query to each of them.
//
// Expiry: NOT enforced by this table (no TTL column, nothing sweeps it).
// Rows accumulate forever at this pass. Documented intended semantics for
// whoever adds a sweep later: a key's replay guarantee only needs to survive
// the caller's own retry window (seconds-to-minutes) — a cron/manual job
// deleting rows older than, say, 7 days would be safe to add without
// touching any call site, since nothing here depends on a row surviving past
// its first successful replay. Left as a follow-up, not a correctness gap
// for a self-hosted single-tenant deployment at dogfood scale.
//
// migration 0043 (P1-06 claim-first hardening): two shape changes layered on
// top of the original table without touching any of the above —
//   · response_json dropped its NOT NULL: the row is now written twice —
//     once at claim time (response_json still empty, "I'm working on this
//     key") and once more after `fn` finishes (backfilled). A row whose
//     response_json is still empty means either genuinely in flight or an
//     orphaned claim from a crashed process — see idempotency.ts's
//     `decideClaimOutcome` for how the two are told apart (claim age vs a
//     60s staleness threshold).
//   · payload_hash (nullable, additive): sha256 of a stable (key-sorted)
//     serialization of the mutation's input, stamped on at claim time.
//     Nullable for two reasons — existing rows written before this migration
//     never had one (backfill not attempted, treated as "no fingerprint on
//     file" rather than a forced mismatch), and a caller of withIdempotency
//     that doesn't pass a `payload` yet still gets a (constant) hash rather
//     than a hard requirement. See idempotency.ts for the current wiring
//     state — no call site passes real per-call arguments yet, that wiring
//     is a follow-up (see idempotency.ts top-of-file note).

import { sql } from 'drizzle-orm';
import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const idempotency_keys = pgTable('idempotency_keys', {
  /** Caller-minted key (uuid or similar) — one per logical mutation intent. */
  key: text('key').primaryKey(),
  /** Not a FK: outlives a deleted pair harmlessly (it's a cache, not a domain
   *  record), and keeping it FK-free avoids coupling this table's insert
   *  ordering to pair lifecycle. */
  pair_id: text('pair_id').notNull(),
  /** Tool/route name, e.g. 'add_lesson' or 'rest:reviews' — a replay request
   *  whose stored operation doesn't match the requested one is key reuse
   *  across two different logical mutations, surfaced as a CONFLICT rather
   *  than silently returning the wrong cached response. */
  operation: text('operation').notNull(),
  /** sha256 of a stable (key-sorted) JSON serialization of the request's
   *  input payload, stamped at claim time (before `fn` runs) — lets a replay
   *  request under the same key but with *different* arguments be rejected
   *  as CONFLICT instead of silently replaying a response that doesn't match
   *  what was actually asked this time. Nullable: rows from before migration
   *  0043 never had one (treated as "no fingerprint on file", not a forced
   *  mismatch — see idempotency.ts). */
  payload_hash: text('payload_hash'),
  /** The exact success envelope (or REST body) returned the first time —
   *  replayed byte-for-byte plus `idempotent_replay: true` stamped on by the
   *  caller. Empty (SQL NULL) between claim and backfill — see migration
   *  0043 note above and idempotency.ts's claim-first flow. */
  response_json: jsonb('response_json'),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type IdempotencyKeyRow = typeof idempotency_keys.$inferSelect;
