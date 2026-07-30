// Keeps `courses.structure.lesson_ids` in sync with the `lessons` table.
//
// Bug: Courses.tsx list page reads `course.structure.lesson_ids.length`
// for the lesson count, but lesson-creation write paths only ever inserted into
// `lessons` — they never touched the course's `structure`. Result: courses with
// real lessons in the table showed 0 lessons in the list (structure.lesson_ids
// stuck at the `create_course` seed value `[]`).
//
// Fix: `structure.lesson_ids` is a derived value, not independently authored —
// any write path that inserts or deletes a `lessons` row for a course must call
// `syncCourseLessonIds(courseId)` afterward. This rebuilds the full array from
// the lessons table (ordered by `order` asc, the navigation-order source of
// truth) rather than hand-appending/removing one id at a time, so it can't drift
// even if a future write path forgets edge cases (e.g. reorder, bulk delete).

import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { courses, lessons } from '../db/schema';

/**
 * Rebuild `course.structure.lesson_ids` from the `lessons` table (ordered by
 * `order` ascending) and write it back to `courses.structure`. Call this after
 * any insert or delete against `lessons` for the given `courseId`.
 */
export async function syncCourseLessonIds(courseId: string): Promise<string[]> {
  const rows = await db
    .select({ id: lessons.id })
    .from(lessons)
    .where(eq(lessons.course_id, courseId))
    .orderBy(asc(lessons.order));

  const lessonIds = rows.map((r) => r.id);

  await db
    .update(courses)
    .set({ structure: { lesson_ids: lessonIds }, updated_at: new Date() })
    .where(eq(courses.id, courseId));

  return lessonIds;
}
