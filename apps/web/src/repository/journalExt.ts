// Journal repository extension — 批E 自由笔记
// + 轻量计数案 遗留优化点 (笔记计数轻量端点).
//
// Deliberately NOT folded into packages/contracts/src/repository.ts: this
// pass's red线 keeps packages/contracts read-only. Same local-additive-
// interface move as ./simulatedQuiz.ts's SimulatedQuizRepo — both concrete
// repos (Mock/Http) implement `Repository & JournalRepo`; callers narrow
// `useRepository()`'s return type with `as (Repository & JournalRepo) | null`
// (see journal/useJournalNotes.ts).

import type { AnnotationColorKey, PairId } from '@learn-shell/contracts';
import type { LessonAnnotationWithOrphan } from '../annotation/orphan';

export interface JournalRepo {
  /** All free notes (lesson_id null — 自由笔记, not anchored to any lesson)
   *  for a pair, created_at asc. The existing per-lesson fan-out
   *  (getAnnotationsForLesson) can never surface these — they don't belong
   *  to any lesson — so Journal's notes hook fetches them separately with
   *  this one pair-scoped call. */
  getFreeNotesForPair(pair_id: PairId): Promise<LessonAnnotationWithOrphan[]>;
  /** Create a free note. `color` defaults server/mock-side to 'amber' (same
   *  default as the anchored createAnnotation path) — `note` is the only
   *  required field, a free note that's just whitespace has no reason to
   *  exist. */
  createFreeNote(input: {
    pair_id: PairId;
    color?: AnnotationColorKey;
    note: string;
  }): Promise<LessonAnnotationWithOrphan>;
  /** Total annotation rows (anchored + free, orphaned + active — every state
   *  counts, 永不丢行原则 never drops a row) owned by a pair. 轻量计数案 遗留优化点:
   *  callers that only need a number (RecentRail's "笔记" row) should use
   *  this instead of running the full useJournalNotes() fan-out and taking
   *  entries.length + orphans.length off the end — same total, one query. */
  getAnnotationCountForPair(pair_id: PairId): Promise<number>;
}
