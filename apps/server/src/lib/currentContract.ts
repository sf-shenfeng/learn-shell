// currentContract — single source of truth for "which TeachingContract is
// the pair's current one".
//
// Retires `teaching_contracts.active` as a selection signal: a full-repo
// grep confirmed the real (non
// LS_SIMULATE) backend has NO write path that ever flips that column to
// `true` — every consumer that filtered on `active = true` (getActiveContract,
// the `pair://contract/active` MCP resource, `_stack`'s pickSkillStack,
// get_context's active_contracts, the ical-token rotate route) was silently
// dead code on production data, always falling through to its null/empty
// fallback. Product call (2026-07-10): don't wire up a real `active: true`
// flip — retire the field as a signal and select on setup_status instead.
//
// Criterion (verified against the real dogfood DB, 2026-07-10 — pair_demo_cfa
// carries three contracts at established / ready / ready, so an
// 'established'-only filter would have missed the fully-provisioned ones):
// a contract is "current-eligible" when it has been SIGNED and is NOT
// terminal — setup_status ∈ {established, outlining, outline_ready,
// in_progress, generating, ready}. Excluded: proposed / draft
// (pre-signature) and failed / cancelled (terminal).
//
// (2026-07-11): the outline/generate pipeline was dismantled and
// 'established' is now the contract lifecycle's terminal state — see
// packages/contracts/src/pair.ts ContractSetupStatus. outlining /
// outline_ready / in_progress / generating / ready are all @deprecated
// there; nothing in the real backend writes them anymore (the one former
// writer, POST /contracts/:id/setup/start, was dead code — zero real
// callers — and was removed alongside this pipeline teardown). They stay
// in CURRENT_CONTRACT_STATUSES below purely for backward compat with
// existing rows written under the old pipeline (e.g. pair_demo_cfa's
// 'ready' contracts referenced above) — a contract stuck in one of these
// legacy states must still resolve as "current", not silently vanish.
//
// No dedicated `established_at` timestamp column exists on teaching_contracts
// (unlike learner_agent_pairs.established_at) — `updated_at` is the best
// available proxy: it's stamped on every PATCH, including the Establish
// transition itself (routes/write.ts `PATCH /contracts/:id`), so among
// several eligible contracts the most-recently-updated one wins.
//
// All "pick the current contract" call sites (routes/read.ts, routes/write.ts,
// lib/context-brief.ts, mcp/server.ts) must go through this module — no
// scattered `eq(teaching_contracts.active, true)` (or setup_status-equivalent)
// queries elsewhere.

import { desc, eq } from 'drizzle-orm';
import type { ContractSetupStatus } from '@learn-shell/contracts';
import { db } from '../db/client';
import { teaching_contracts } from '../db/schema';

/**
 * Signed + non-terminal — the statuses that make a contract "current"-eligible.
 *
 * 'established' is the only one of these a real contract can be in going
 * forward (2026-07-11). outlining/outline_ready/in_progress/
 * generating/ready are @deprecated legacy-data-only states (see
 * packages/contracts ContractSetupStatus) kept here only so pre-existing
 * rows still resolve as current — no code should produce them anymore.
 */
export const CURRENT_CONTRACT_STATUSES: readonly ContractSetupStatus[] = [
  'established',
  'outlining',
  'outline_ready',
  'in_progress', // deprecated alias of 'generating' — legacy data only, nothing writes this anymore
  'generating',
  'ready',
];

function isCurrentEligible(status: string): boolean {
  return (CURRENT_CONTRACT_STATUSES as readonly string[]).includes(status);
}

export type ContractRow = typeof teaching_contracts.$inferSelect;

// 迁移 0027 (Void, not delete — 审计留痕): a voided contract (voided_at set)
// is never "current," regardless of its setup_status — voiding is an
// orthogonal axis from the setup lifecycle (a signed, otherwise-eligible
// 'established' contract can still be voided by either party; see
// mcp/server.ts's void_contract tool). This is the one place that decision
// needs to live, per this module's own "no scattered queries elsewhere"
// contract above — every consumer (get_context, routes/read.ts, mcp/
// server.ts's pickSkillStack / pair://contract/active / create_course's
// no-contract warning, the ical-token rotate route) goes through
// pickCurrentContract(s) below, so patching the predicate here is sufficient
// to keep all of them consistent without touching each call site.
function isVoided(row: { voided_at?: Date | null }): boolean {
  return row.voided_at != null;
}

// 迁移 0032 起 complete_contract 写 completed_at——工具自述"与 established/voided
// 并列的第三种终态"。结业合同与作废合同同理：永远不再是"现役"，get_context /
// pair://contract/active / create_course 履约校验等全部读路径就此一致退役它。
// (E2E first-run 实测曾复现：结业后仍被当现役返回——此判定即修复。)
function isCompleted(row: { completed_at?: Date | null }): boolean {
  return row.completed_at != null;
}

/**
 * Pure selection logic, split out from the DB fetch so it's unit-testable
 * without a database (see currentContract.test.ts) — the fetch below just
 * hands it every contract row for the pair.
 */
export function pickCurrentContract<
  T extends { setup_status: string; updated_at: Date; voided_at?: Date | null; completed_at?: Date | null },
>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (!isCurrentEligible(row.setup_status)) continue;
    if (isVoided(row)) continue;
    if (isCompleted(row)) continue;
    if (!best || row.updated_at.getTime() > best.updated_at.getTime()) best = row;
  }
  return best;
}

/** Every current-eligible contract for a pair, most-recently-updated first. */
export function pickCurrentContracts<
  T extends { setup_status: string; updated_at: Date; voided_at?: Date | null; completed_at?: Date | null },
>(rows: readonly T[]): T[] {
  return rows
    .filter((row) => isCurrentEligible(row.setup_status) && !isVoided(row) && !isCompleted(row))
    .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
}

async function listContractsForPair(pairId: string): Promise<ContractRow[]> {
  return db
    .select()
    .from(teaching_contracts)
    .where(eq(teaching_contracts.pair_id, pairId))
    .orderBy(desc(teaching_contracts.updated_at));
}

/**
 * The pair's single "current" contract — direct replacement for every former
 * `WHERE active = true ... LIMIT 1` query (getActiveContract, `pair://contract/
 * active`, pickSkillStack, ical-token rotate). Null if the pair has no
 * contract in a signed, non-terminal setup_status (see
 * CURRENT_CONTRACT_STATUSES).
 */
export async function getCurrentContract(pairId: string): Promise<ContractRow | null> {
  const rows = await listContractsForPair(pairId);
  return pickCurrentContract(rows);
}

/**
 * All of the pair's current-eligible contracts, most-recent first —
 * replacement for get_context's `active_contracts` (plural; a pair can carry
 * more than one simultaneously-relevant contract, see learner_agent_pairs.ts
 * comment).
 */
export async function listCurrentContracts(pairId: string): Promise<ContractRow[]> {
  const rows = await listContractsForPair(pairId);
  return pickCurrentContracts(rows);
}
