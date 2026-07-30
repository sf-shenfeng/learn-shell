// currentContract — Mock-side mirror of apps/server/src/lib/currentContract.ts
// (合同签名态改革). Same semantics, no DB: MockRepository is the browser-only
// stand-in for a live server (analogous to the server's LS_SIMULATE demo
// path), so its own `.active` writes stay untouched (self-consistent demo),
// but "which contract is current" must resolve the same way HttpRepository's
// server-backed answer now does — off setup_status, not the retired `active`
// boolean.
//
// Criterion (mirrors the server helper exactly; verified against a real
// dogfood DB 2026-07-10 — a demo pair carried established / ready / ready):
// signed + non-terminal, i.e. setup_status ∈ {established, outlining,
// outline_ready, in_progress, generating, ready}; excluded: proposed / draft
// (pre-signature), failed / cancelled (terminal). Most-recently-`updated_at`
// wins among several eligible contracts.
//
// Kept as a small standalone module (not inlined in MockRepository.ts) so
// every mock consumer (getActiveContract, rotateIcalToken, …) shares one
// selection, per the "no scattered queries" rule from the 合同签名态改革 brief.

import type { ContractSetupStatus, TeachingContract } from '@learn-shell/contracts';

/** Signed + non-terminal — the statuses that make a contract "current"-eligible. */
export const CURRENT_CONTRACT_STATUSES: readonly ContractSetupStatus[] = [
  'established',
  'outlining',
  'outline_ready',
  'in_progress', // deprecated alias of 'generating', still on the wire
  'generating',
  'ready',
];

/** Pure selection — mirrors the server's pickCurrentContract exactly, just
 *  operating on TeachingContract[] with string `updated_at` (wire shape)
 *  instead of Date. */
export function pickCurrentContract(contracts: readonly TeachingContract[]): TeachingContract | null {
  let best: TeachingContract | null = null;
  for (const c of contracts) {
    if (!CURRENT_CONTRACT_STATUSES.includes(c.setup_status)) continue;
    if (!best || new Date(c.updated_at).getTime() > new Date(best.updated_at).getTime()) best = c;
  }
  return best;
}
