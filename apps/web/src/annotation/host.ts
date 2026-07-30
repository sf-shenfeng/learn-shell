// AnnotationHost — 批G 批注宿主泛化.
//
// The learning machine (highlight capture, color/note overlay, notes panel,
// generate-flashcard) is written once against this discriminated union
// instead of hardcoding `lessonId` — apps/web/src/annotation/useAnnotations.ts
// and AnnotationOverlay.tsx both branch on `host.kind` to pick the right
// Repository/DocumentRepo method, everything else about them is unchanged
// from batch A/B/D (brief §5: "不新造平行零件").

import type { LessonId, LiveSessionId } from '@learn-shell/contracts';
import type { DocumentId } from '../document/types';

/** 'live' (第三种宿主, 2026-07-18 教学记录挂批注): a COMPLETED live session's
 *  read-only teaching record (Lesson.tsx's history branch). Convention:
 *  page_index = the anchored move's seq; anchors resolve inside that single
 *  move's prose (marked `data-ls-live-move-seq` in MoveStream), never across
 *  moves — see useAnnotations.ts's live branches. */
export type AnnotationHost =
  | { kind: 'lesson'; id: LessonId }
  | { kind: 'document'; id: DocumentId }
  | { kind: 'live'; id: LiveSessionId };

/** 批注计数同步案①修复: the Journal drawer/RecentRail count (journal/useJournalNotes.ts)
 *  read this host's annotations through its OWN React Query keys —
 *  `['journal-annotations', lessonId]` / `['journal-doc-annotations', documentId]`
 *  — literal duplicates of the key construction in that file's per-lesson/
 *  per-document `useQueries` fan-out, not an import (same "shared key,
 *  no shared code" precedent as every other cross-page cache-sharing comment
 *  in this codebase, e.g. RecentRail.tsx's `['courses', pairId]`). Every
 *  document/lesson-side write (useAnnotations.ts's create, AnnotationOverlay
 *  .tsx's color/note update/delete) only ever invalidated the *reading-view*
 *  key (`annotationsQueryKey`, this same file's sibling) and `['notes-count',
 *  pairId]` — never this one. Journal's own `staleTime: 30_000` (main.tsx)
 *  meant a already-opened-once drawer kept showing pre-write data for up to
 *  30s after a highlight/note was created or edited elsewhere — the root
 *  cause of 批注计数同步案①'s "计数 3、抽屉 2条" mismatch. Both write-side files
 *  must invalidate this key alongside their existing ones. */
export function journalHostQueryKey(host: AnnotationHost): [string, string] {
  // 'live' key: subscribed by journal/useJournalNotes.ts's per-completed-
  // session fan-out (2026-07-18 学习者验收补齐 — until that fan-out landed,
  // this arm was a subscriber-less placeholder and live highlights never
  // reached the notes drawer at all). Same 批注计数同步案 symmetric-invalidation
  // contract as the other two hosts: the write side firing this key is what
  // makes a highlight made in the live panel show up in the drawer without
  // a reload.
  return host.kind === 'lesson'
    ? ['journal-annotations', host.id]
    : host.kind === 'document'
      ? ['journal-doc-annotations', host.id]
      : ['journal-live-annotations', host.id];
}
