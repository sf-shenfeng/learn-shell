// Annotation orphan status — local type extension (batch D;
// lesson_id override added batch E).
//
// packages/contracts is read-only this batch (发包 red线) — `orphaned_at`
// is a new server column (apps/server/src/db/schema/annotation.ts) but not a
// new field on contracts' `LessonAnnotation`. The server already includes it
// on every row it returns (drizzle `select()` grabs the whole row), so the
// wire payload has the field regardless of what the TS type declares; this
// module just gives the web side an honest local type for it, same pattern
// apps/web/src/repository/simulatedQuiz.ts uses for repo methods missing
// from the shared Repository interface. Flagged for 发包人 to fold into
// contracts properly in a later round.
//
// 批E (自由笔记): free notes don't
// anchor to a lesson, so `lesson_id` is nullable on the wire once they exist
// (server column migrated to nullable — apps/server/src/db/schema/annotation.ts).
// Contracts' `LessonAnnotation.lesson_id` is still the non-null branded
// `LessonId` (contracts stays read-only this batch too) — overridden locally
// here the same way `orphaned_at` is, via `Omit` + re-declare rather than a
// second parallel type, so every existing consumer of
// `LessonAnnotationWithOrphan` (batch D) keeps working unchanged.
//
// 批G (批注宿主泛化): adds `document_id`,
// same nullable-override treatment as `lesson_id` right above it — a row now
// carries at most one of {lesson_id, document_id} non-null (server CHECK
// constraint enforces the exclusivity; see
// apps/server/src/db/schema/annotation.ts). Kept as ONE canonical annotation
// wire type here (not a second parallel type) — every existing
// `LessonAnnotationWithOrphan` consumer just picks up an extra always-there
// field it can ignore.

import type { LessonAnnotation, LessonId, LiveSessionId } from '@learn-shell/contracts';
import type { DocumentId } from '../document/types';

export interface AnnotationOrphanFields {
  /** null = resolves fine; ISO timestamp = orphaned as of the last sweep. */
  orphaned_at: string | null;
}

export type LessonAnnotationWithOrphan = Omit<LessonAnnotation, 'lesson_id'> &
  AnnotationOrphanFields & {
    /** null = 自由笔记 (批E) or document-anchored (批G) — not anchored to any lesson. */
    lesson_id: LessonId | null;
    /** 批G: null = anchored to a lesson (or a free note) instead. */
    document_id: DocumentId | null;
    /** 第三种作用域 (2026-07-18, 教学记录挂批注): non-null = anchored inside
     *  one move of a completed live session's teaching record; page_index
     *  then carries that move's seq. Same additive-wire-field treatment as
     *  document_id above (server CHECK keeps the three hosts exclusive). */
    live_session_id: LiveSessionId | null;
  };

/** Narrow a Repository-shaped `LessonAnnotation[]` (which is really carrying
 *  `orphaned_at` on the wire — see file header) to the orphan-aware type. */
export function withOrphanField(rows: LessonAnnotation[]): LessonAnnotationWithOrphan[] {
  return rows as LessonAnnotationWithOrphan[];
}

export function isOrphaned(a: LessonAnnotationWithOrphan): boolean {
  return a.orphaned_at != null;
}
