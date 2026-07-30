// Journal — "我的笔记" 数据装配 (batch D,
// 2026-07-07 art-direction 定版; 批E 扩展见下).
//
// Cross-lesson index of every Annotation the pair has, grouped/sorted/filtered
// by the panel (journal/NotesDrawer.tsx, 批F 起 — was JournalNotesPanel.tsx
// pre-批F + noteGrouping.ts) + a separate 待重新安放 (orphan) bucket. Summoned
// as its own drawer (卡池抽屉化's Pool drawer treatment, extended to notes) —
// a different surface from the in-lesson 课内笔记栏
// (AnnotationNotesPanel.tsx, batch B, one lesson at a time).
//
// Data source: same client-side fan-out pattern useJournalTimeline.ts already
// established ("客户端聚合窗口 — 数据量小" 允许) — reuses its exact
// ['journal-courses', pairId] / ['journal-lessons', courseId] query keys so
// React Query dedupes against whatever useJournalTimeline already fetched on
// the same page (no duplicate network calls), then fans out one NEW query
// per lesson: getAnnotationsForLesson (already exists, batch A — no new
// Repository method needed for the read side).
//
// Sweep trigger: deliberately NOT called from here. `orphaned_at` is kept
// fresh by update_lesson's own post-write resweep (server-side, brief §4);
// the standalone POST /pairs/:pairId/annotations/sweep-orphans endpoint is
// the brief's "一次性 sweep" entry point, not something this read-only page
// silently triggers on every visit.
//
// 批E (自由笔记): free notes don't
// belong to any lesson, so the per-lesson fan-out above can never surface
// them — fetched separately via the JournalRepo extension's
// getFreeNotesForPair (packages/contracts 只读, local additive interface —
// see ../repository/journalExt.ts) and merged into the same `entries` list.
// Grouping/sorting/filtering itself moved out of this hook and into
// noteGrouping.ts's pure functions — this hook's job is now just "fetch +
// merge + attach ordering metadata", not "decide how to arrange them" (that
// decision is the panel's own UI state: 批E items 5/6/7).

import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { CourseId, Lesson, LessonId, LiveSessionId, Repository } from '@learn-shell/contracts';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';
import type { JournalRepo } from '../repository/journalExt';
import { withOrphanField, isOrphaned, type LessonAnnotationWithOrphan } from '../annotation/orphan';
import { useDocumentRepo } from '../document/useDocumentRepo';
import type { DocumentId } from '../document/types';

export interface JournalNoteEntry {
  annotation: LessonAnnotationWithOrphan;
  /** null = 自由笔记 (批E) or document-anchored (批G) — not anchored to any lesson. */
  lessonId: LessonId | null;
  lessonTitle: string | null;
  courseId: CourseId | null;
  courseTopic: string | null;
  /** 批G (批注宿主泛化): null unless this
   *  entry is anchored to a document instead of a lesson. Mutually exclusive
   *  with lessonId/courseId — an entry has at most one host. */
  documentId: DocumentId | null;
  documentTitle: string | null;
  /** 第三种宿主 (教学记录挂批注, 2026-07-18): non-null = anchored inside a
   *  completed live session's teaching record. Unlike documentId this is NOT
   *  mutually exclusive with lessonId — the session belongs to a lesson, and
   *  the entry carries that lesson's metadata for grouping/labels. Check
   *  this field FIRST wherever behavior branches on host kind (invalidation,
   *  jump link): a live entry would otherwise satisfy the lesson branch. */
  liveSessionId: LiveSessionId | null;
  /** True for 批E 自由笔记 — drives "无跳原文动作" + "自由笔记" identity
   *  label in the panel; never true for anything from the per-lesson or
   *  per-document fan-out. */
  isFree: boolean;
  /** Fetch order among this entry's own bucket kind — courses use their
   *  `getCourses()` index (same order CourseChips renders in), documents use
   *  their `getDocuments()` index offset past every course so a "按课程"
   *  sort lists courses first, then documents, then free notes last
   *  (noteGrouping.ts's groupByCourse — 批G: 课程/文档 both feed this one
   *  ordering field, "宿主" is the generalized concept, field name kept for
   *  minimal diff). Free notes get `Infinity`. */
  courseOrderIndex: number;
  /** `Lesson.order` within its course — only meaningful when courseOrderIndex
   *  is finite AND this is a lesson entry; free notes and document entries
   *  carry 0 (unused — document buckets aren't sub-grouped by anything, and
   *  free notes' courseOrderIndex already sorts them into their own bucket). */
  lessonOrder: number;
}

export interface JournalNotesData {
  isLoading: boolean;
  hasRepo: boolean;
  /** Active (non-orphan) notes — anchored + free, created_at desc. Grouping/
   *  sorting/filtering for display is the panel's job (noteGrouping.ts). */
  entries: JournalNoteEntry[];
  /** 待重新安放 — sorted newest-orphaned-first. Empty array when none;
   *  caller hides the whole section on empty (卡池抽屉化 判例). Free notes never
   *  appear here — they have no anchor to fail. */
  orphans: JournalNoteEntry[];
  /** entries.length > 0 || orphans.length > 0 — drives whether the panel
   *  mounts at all (item 0: 零笔记且零孤儿时面板整体不渲染、不占宽). */
  hasContent: boolean;
}

/** `/courses/:courseId/lessons/:lessonId?page=N` — reuses PagedLesson's
 *  existing anchor-resolve-on-mount (deep link only jumps the page; the
 *  highlight itself paints via the pre-existing resolve pass, nothing new
 *  needed there). 导图深链案 precedent (Mindmap's ?map=). */
export function buildLessonPageLink(courseId: CourseId, lessonId: LessonId, pageIndex: number): string {
  return `/courses/${courseId}/lessons/${lessonId}?page=${pageIndex}`;
}

/** 批G: document counterpart — no page param (documents don't page, brief
 *  §4 continuous scroll), just the reading page itself. */
export function buildDocumentLink(documentId: DocumentId): string {
  return `/documents/${documentId}`;
}

/** 教学记录 counterpart (2026-07-18): a live-hosted note's "原文" is the
 *  lesson page's Live Teaching history panel, not a lesson text page — so no
 *  ?page param (a live note's page_index is a move seq, which ?page= would
 *  misread as a text page index). */
export function buildLessonLiveLink(courseId: CourseId, lessonId: LessonId): string {
  return `/courses/${courseId}/lessons/${lessonId}`;
}

/** `useRepository()` narrowed to the batch E free-note extension — same
 *  narrowing dance pages/Quiz.tsx's useSimulatedQuizRepo does for
 *  SimulatedQuizRepo. Exported so the panel's own mutations (create free
 *  note) can reuse the same narrowed handle without re-deriving it. */
export function useJournalRepo(): (Repository & JournalRepo) | null {
  return useRepository() as (Repository & JournalRepo) | null;
}

export function useJournalNotes(): JournalNotesData {
  const repo = useRepository();
  const journalRepo = useJournalRepo();
  const documentRepo = useDocumentRepo();
  const { pairId } = usePair();
  const enabled = !!repo && !!pairId;

  const coursesQ = useQuery({
    queryKey: ['journal-courses', pairId],
    queryFn: () => (repo && pairId ? repo.getCourses(pairId) : Promise.resolve([])),
    enabled,
  });
  const courses = useMemo(() => coursesQ.data ?? [], [coursesQ.data]);

  const lessonsQs = useQueries({
    queries: courses.map((c) => ({
      queryKey: ['journal-lessons', c.id],
      queryFn: () => (repo ? repo.getLessons(c.id) : Promise.resolve([])),
      enabled,
    })),
  });
  const lessons: Lesson[] = useMemo(() => lessonsQs.flatMap((q) => q.data ?? []), [lessonsQs]);
  const lessonsSettled = courses.length === 0 || lessonsQs.every((q) => q.isSuccess || q.isError);

  const annotationsQs = useQueries({
    queries: lessons.map((l) => ({
      queryKey: ['journal-annotations', l.id],
      queryFn: () => (repo ? repo.getAnnotationsForLesson(l.id) : Promise.resolve([])),
      enabled,
    })),
  });
  const annotationsSettled = lessons.length === 0 || annotationsQs.every((q) => q.isSuccess || q.isError);

  // 第三种宿主 (教学记录挂批注, 2026-07-18): live-hosted annotations fan out
  // one more hop past the lesson layer — per lesson, its latest COMPLETED
  // live session (the only kind that carries a frozen, annotatable record;
  // 学习者验收: live 里划的高亮必须实时进抽屉). The session layer reuses the
  // Lesson page's own ['live-completed-session-for-lesson', pairId, lessonId]
  // key (React Query dedupes — no second network fetch when the lesson page
  // already asked), and the annotation layer's ['journal-live-annotations',
  // sessionId] key is EXACTLY what the write side already invalidates
  // (useAnnotations.ts createMut / AnnotationOverlay's invalidateAnnotations
  // both go through host.ts's journalHostQueryKey — the 批注计数同步案 symmetric-
  // invalidation contract; that key was a subscriber-less placeholder until
  // this fan-out, which is why live notes never appeared in the drawer).
  const liveSessionQs = useQueries({
    queries: lessons.map((l) => ({
      queryKey: ['live-completed-session-for-lesson', pairId, l.id],
      queryFn: () =>
        repo && pairId
          ? repo.getCompletedLiveSessionForLesson(pairId, l.id)
          : Promise.resolve(null),
      enabled,
    })),
  });
  const liveSessions = useMemo(
    () =>
      liveSessionQs
        .map((q, i) => ({ session: q.data ?? null, lesson: lessons[i] ?? null }))
        .filter((x): x is { session: NonNullable<typeof x.session>; lesson: Lesson } => !!x.session && !!x.lesson),
    [liveSessionQs, lessons]
  );
  const liveSessionsSettled =
    lessons.length === 0 || liveSessionQs.every((q) => q.isSuccess || q.isError);

  const liveAnnotationsQs = useQueries({
    queries: liveSessions.map(({ session }) => ({
      queryKey: ['journal-live-annotations', session.id],
      queryFn: () =>
        repo ? repo.getAnnotationsForLiveSession(session.id) : Promise.resolve([]),
      enabled,
    })),
  });
  const liveAnnotationsSettled =
    liveSessions.length === 0 || liveAnnotationsQs.every((q) => q.isSuccess || q.isError);

  // 批G ("学习机器换宿主"): documents fan
  // out the exact same way courses→lessons do above — one ['journal-documents',
  // pairId] list query, then one ['journal-doc-annotations', d.id] per
  // document. NotesDrawer's分组维度"课程"泛化为"宿主" needs both host kinds
  // merged into the same entries list, not a separate section.
  const documentsQ = useQuery({
    queryKey: ['journal-documents', pairId],
    queryFn: () =>
      documentRepo && pairId ? documentRepo.getDocuments(pairId) : Promise.resolve([]),
    enabled: !!documentRepo && !!pairId,
  });
  const documentsList = useMemo(() => documentsQ.data ?? [], [documentsQ.data]);

  const docAnnotationsQs = useQueries({
    queries: documentsList.map((doc) => ({
      queryKey: ['journal-doc-annotations', doc.id],
      queryFn: () =>
        documentRepo ? documentRepo.getAnnotationsForDocument(doc.id) : Promise.resolve([]),
      enabled: !!documentRepo && !!pairId,
    })),
  });
  const docAnnotationsSettled =
    documentsList.length === 0 || docAnnotationsQs.every((q) => q.isSuccess || q.isError);

  // 批E: 自由笔记, 按 pair 一次拿全部 (不经过 lesson 扇出 — 它们不属于任何
  // lesson). Own query key ['journal-free-notes', pairId], not shared with
  // anything else fetched on this page.
  const freeNotesQ = useQuery({
    queryKey: ['journal-free-notes', pairId],
    queryFn: () =>
      journalRepo && pairId ? journalRepo.getFreeNotesForPair(pairId) : Promise.resolve([]),
    enabled: !!journalRepo && !!pairId,
  });

  const { entries, orphans } = useMemo(() => {
    const lessonMeta = new Map(
      lessons.map((l) => [l.id, { title: l.title, courseId: l.course_id, order: l.order }])
    );
    const courseTopicById = new Map(courses.map((c) => [c.id, c.topic]));
    const courseOrderIndexById = new Map(courses.map((c, i) => [c.id, i]));
    // Documents sort after every course in a "按课程" (now 按宿主) view —
    // offset their order index past courses.length so the two never collide.
    const documentOrderIndexById = new Map(
      documentsList.map((doc, i) => [doc.id, courses.length + i])
    );
    const documentTitleById = new Map(documentsList.map((doc) => [doc.id, doc.title]));

    const anchored: JournalNoteEntry[] = [];
    annotationsQs.forEach((q, i) => {
      const lesson = lessons[i];
      if (!lesson) return;
      const meta = lessonMeta.get(lesson.id);
      if (!meta) return;
      for (const raw of withOrphanField(q.data ?? [])) {
        anchored.push({
          annotation: raw,
          lessonId: lesson.id,
          lessonTitle: meta.title,
          courseId: meta.courseId,
          courseTopic: courseTopicById.get(meta.courseId) ?? null,
          documentId: null,
          documentTitle: null,
          liveSessionId: null,
          isFree: false,
          courseOrderIndex: courseOrderIndexById.get(meta.courseId) ?? Number.POSITIVE_INFINITY,
          lessonOrder: meta.order,
        });
      }
    });

    // 第三种宿主: live-hosted entries ride their session's OWN lesson metadata
    // (session.context = the lesson) so they group under the same course/
    // lesson bucket as that lesson's text notes — the record IS part of that
    // lesson's study history. liveSessionId kept on the entry so behavior
    // branches (invalidation, jump link) can tell them apart; see the field's
    // doc comment.
    const liveAnchored: JournalNoteEntry[] = [];
    liveAnnotationsQs.forEach((q, i) => {
      const owner = liveSessions[i];
      if (!owner) return;
      const meta = lessonMeta.get(owner.lesson.id);
      if (!meta) return;
      for (const raw of withOrphanField(q.data ?? [])) {
        liveAnchored.push({
          annotation: raw,
          lessonId: owner.lesson.id,
          lessonTitle: meta.title,
          courseId: meta.courseId,
          courseTopic: courseTopicById.get(meta.courseId) ?? null,
          documentId: null,
          documentTitle: null,
          liveSessionId: owner.session.id,
          isFree: false,
          courseOrderIndex: courseOrderIndexById.get(meta.courseId) ?? Number.POSITIVE_INFINITY,
          lessonOrder: meta.order,
        });
      }
    });

    const documentAnchored: JournalNoteEntry[] = [];
    docAnnotationsQs.forEach((q, i) => {
      const doc = documentsList[i];
      if (!doc) return;
      for (const raw of q.data ?? []) {
        documentAnchored.push({
          annotation: raw,
          lessonId: null,
          lessonTitle: null,
          courseId: null,
          courseTopic: null,
          documentId: doc.id,
          documentTitle: documentTitleById.get(doc.id) ?? doc.title,
          liveSessionId: null,
          isFree: false,
          courseOrderIndex: documentOrderIndexById.get(doc.id) ?? Number.POSITIVE_INFINITY,
          lessonOrder: 0,
        });
      }
    });

    const free: JournalNoteEntry[] = (freeNotesQ.data ?? []).map((raw) => ({
      annotation: raw,
      lessonId: null,
      lessonTitle: null,
      courseId: null,
      courseTopic: null,
      documentId: null,
      documentTitle: null,
      liveSessionId: null,
      isFree: true,
      courseOrderIndex: Number.POSITIVE_INFINITY,
      lessonOrder: 0,
    }));

    const all = [...anchored, ...liveAnchored, ...documentAnchored, ...free];
    const active = all
      .filter((e) => !isOrphaned(e.annotation))
      .sort((a, b) => new Date(b.annotation.created_at).getTime() - new Date(a.annotation.created_at).getTime());
    // 自由笔记永不孤儿 (无锚点可失败) — isOrphaned 对它们恒 false, 这里的
    // filter 只会挑出 anchored 里 orphaned_at 非空的那些, 自然排除.
    const orphaned = all
      .filter((e) => isOrphaned(e.annotation))
      .sort(
        (a, b) =>
          new Date(b.annotation.orphaned_at ?? 0).getTime() -
          new Date(a.annotation.orphaned_at ?? 0).getTime()
      );

    return { entries: active, orphans: orphaned };
  }, [
    lessons,
    courses,
    annotationsQs,
    liveSessions,
    liveAnnotationsQs,
    documentsList,
    docAnnotationsQs,
    freeNotesQ.data,
  ]);

  const isLoading =
    coursesQ.isLoading ||
    !lessonsSettled ||
    !annotationsSettled ||
    !liveSessionsSettled ||
    !liveAnnotationsSettled ||
    documentsQ.isLoading ||
    !docAnnotationsSettled ||
    freeNotesQ.isLoading;

  return {
    isLoading,
    hasRepo: !!repo,
    entries,
    orphans,
    hasContent: entries.length > 0 || orphans.length > 0,
  };
}
