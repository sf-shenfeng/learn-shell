// Syllabus Registry repository extension.
//
// Deliberately NOT folded into packages/contracts/src/repository.ts — same
// "packages/contracts stays read-only this pass" precedent journalExt.ts's
// JournalRepo and documentExt.ts's DocumentRepo already set. Both concrete
// repos (Mock/Http) implement `Repository & SyllabusRepo`; the one caller
// this ships with (journal/useJournalTimeline.ts) narrows `useRepository()`'s
// return type the same way useJournalNotes.ts does for JournalRepo.
//
// Shape mirrors the server's GET /pairs/:id/syllabus response 1:1 (see
// apps/server/src/routes/syllabus.ts + apps/server/src/lib/syllabus-coverage.ts
// for the derivation these fields carry) — no reshaping at the repository
// boundary, this is a straight passthrough type.

import type { PairId } from '@learn-shell/contracts';

export type SyllabusAssetType = 'lesson' | 'flashcard' | 'quiz_question' | 'document' | 'mindmap_node';
export type SyllabusCoverageState = 'untouched' | 'taught' | 'tested';
export type SyllabusDecayBand = 'fresh' | 'fading' | 'cold';

export interface SyllabusTreeNode {
  id: string;
  parent_id: string | null;
  code: string;
  title: string;
  description: string | null;
  syllabus_version: string;
  exam_weight: number | null;
  sort_order: number;
  /** Node's own (unrolled) state — see syllabus-coverage.ts header comment
   *  for why this is deliberately NOT the same as coverage_pct. */
  coverage: SyllabusCoverageState;
  decay: SyllabusDecayBand | null;
  decay_value: number | null;
  last_touched: string | null;
  /** Tree-rolled 0..100 — always defined, never null (0 for a fully
   *  untouched subtree). */
  coverage_pct: number;
  decay_value_rollup: number | null;
  decay_rollup: SyllabusDecayBand | null;
  last_touched_rollup: string | null;
  children: SyllabusTreeNode[];
}

/** Flat, denormalized mapping row — this is what Journal's syllabus-week
 *  projection buckets by ISO week client-side (same "raw rows in, aggregate
 *  in the hook" shape review-day entries already use for session data). */
export interface SyllabusMappingSummary {
  node_id: string;
  code: string;
  asset_type: SyllabusAssetType;
  asset_id: string;
  created_at: string;
}

export interface SyllabusSnapshot {
  /** null = pair has no syllabus tree at all (brief §5 空态). */
  version: string | null;
  nodes: SyllabusTreeNode[];
  mappings: SyllabusMappingSummary[];
  /** Whole-tree weighted rollup, or null in the empty-tree case. */
  coverage_pct: number | null;
}

export interface SyllabusRepo {
  /** `version` omitted → server defaults to the most recently-created
   *  version present for this pair (see routes/syllabus.ts). */
  getSyllabus(pair_id: PairId, version?: string): Promise<SyllabusSnapshot>;
}
