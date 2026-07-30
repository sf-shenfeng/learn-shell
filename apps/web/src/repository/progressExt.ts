// Async teaching-loop repository extension (前端施工批, 2026-07-11).
//
// Deliberately NOT folded into packages/contracts/src/repository.ts — same
// "packages/contracts stays read-only this pass" precedent journalExt.ts's
// JournalRepo / syllabusExt.ts's SyllabusRepo already set. Both concrete
// repos (Mock/Http) implement `Repository & ProgressRepo`; callers narrow
// `useRepository()`'s return type the same way ExerciseCard already does for
// ConfidenceCaptureRepo.
//
// Types (LessonProgress / LessonPatch / LessonLoopReceipt / checklist input
// shape) are already in packages/contracts/src/progress.ts — that file
// shipped with the backend batch (3b92095) as a shared read-only type, not
// a repository method; this file only adds the *methods* that move them.

import type {
  ExerciseSubmission,
  ExerciseSubmissionId,
  LessonId,
  CourseId,
  PairId,
  LessonProgress,
  LessonPatch,
  LessonLoopReceipt,
} from '@learn-shell/contracts';

/**
 * PATCH /submissions/:id's 409 (already_graded) is a real state, not an
 * error condition — the reflection window (§3) closed under the learner's
 * feet between opening the edit box and hitting save (agent graded it
 * meanwhile). Thrown by editSubmission() specifically for that status code
 * so ExerciseCard can show "批改已定格" instead of a generic failure toast.
 */
export class AlreadyGradedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyGradedError';
  }
}

export interface ProgressRepo {
  /** Single-lesson progress read. Synthesizes `not_started` when no row
   *  exists yet (server does the same — see routes/read.ts's
   *  synthesizedProgress) so callers never special-case "row missing". */
  getLessonProgress(pair_id: PairId, lesson_id: LessonId): Promise<LessonProgress>;
  /** Batch read, one row per lesson in course order — course list + lesson
   *  page badges both want "whole course's state" in one call rather than
   *  N single-lesson fetches. */
  getCourseProgress(pair_id: PairId, course_id: CourseId): Promise<LessonProgress[]>;
  /** §6 学习者宣布已学完 — checklist_snapshot is computed server-side at
   *  this exact moment (exercises_submitted is a real DB count; pages_total
   *  is whatever the caller reports, since page-splitting is a frontend-only
   *  concept the server doesn't track). Allowed to declare with gaps — the
   *  gap list itself is the point (§6: "自评与批改的差距是全系统最贵的校准
   *  数据"), not a validation error.
   *  `current_page_index` (迁移 0037, 学习者裁决第三针, 2026-07-20) — 0-based,
   *  replaces the old `pages_read` field: pages_read used to be a client-
   *  trusted "current page" number at the moment of declaring, which is
   *  exactly the bug ("学完全部后翻回第 4 页复习再声明，快照记成 4/12") —
   *  the server now computes pages_read itself from lesson_progress.
   *  pages_visited (footprint accumulated by touchLessonProgress's page_index
   *  calls) unioned with this current_page_index as a fallback for whichever
   *  page a touch() call didn't make it to the server for. */
  declareLessonCompleted(
    pair_id: PairId,
    lesson_id: LessonId,
    input: { pages_total?: number | null; current_page_index?: number | null; gaps?: string[] }
  ): Promise<LessonProgress>;
  /** §4 改课三律落点 — teacher_note (学习中的课) / erratum (已学完的课).
   *  Read-only from the learner-facing web app; writes are MCP-only
   *  (add_lesson_patch), authored by the agent. */
  getLessonPatches(lesson_id: LessonId): Promise<LessonPatch[]>;
  /** §5 回执制 — closed by MCP close_lesson_loop; read-only here too. */
  getLessonLoopReceipts(lesson_id: LessonId): Promise<LessonLoopReceipt[]>;
  /** §3 反刍窗口 — edit a submitted-but-ungraded answer in place (PATCH, not
   *  a new submission — that's resubmitExercise's job for the *post*-grade
   *  case). Throws AlreadyGradedError if the 409 lands (grading beat the
   *  edit to the wire). */
  editSubmission(
    submission_id: ExerciseSubmissionId,
    learner_answer: string
  ): Promise<ExerciseSubmission>;
}
