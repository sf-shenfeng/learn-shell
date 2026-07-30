// Hono REST route — full pair data export.
//
// Product contract promise: "人可以暂停、导出、删除这段教学关系的数据" — delete
// side already exists (per-entity deletes across the app); this is the export
// side, previously zero. Data-sovereignty / open-source trust floor, not a
// power-user feature — one JSON bundle, everything this pair owns, nothing
// held back.
//
// Kept as its own route file rather than folded into read.ts: read.ts is
// already a long flat list of narrow single-entity reads (one route ≈ one
// table). This route is categorically different — one endpoint that joins
// ~25 tables into a single aggregate document — and giving it its own file
// keeps that "aggregate export" concern auditable as a unit (a GDPR-style
// surface someone will want to re-check in isolation) instead of buried
// mid-list in read.ts's per-entity routes.
//
// Coverage: every table in db/schema with a pair_id / owner_pair_id column,
// plus every table reachable from those by a foreign key one hop away
// (lessons under this pair's courses, exercises under those lessons, etc).
// Deliberately excluded: question_banks / quiz_questions — shared reference
// curriculum content, not this pair's data (their pair-scoped counterpart,
// quiz_attempts, IS included). See bottom of file for the full inventory.

import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import {
  learner_agent_pairs,
  learners,
  agents,
  teaching_contracts,
  courses,
  lessons,
  lesson_revisions,
  concepts,
  flashcards,
  exercises,
  exercise_submissions,
  documents,
  lesson_annotations,
  mindmaps,
  mindmap_associations,
  pending_mindmap_cards,
  learner_hypotheses,
  teacher_reflections,
  learning_sessions,
  session_events,
  post_lesson_evaluations,
  simulated_quizzes,
  simulated_quiz_attempts,
  quiz_attempts,
  reminders,
  learner_feedback,
  ad_hoc_threads,
  ad_hoc_messages,
  live_sessions,
  teaching_moves,
  teaching_responses,
  mid_lesson_snapshots,
  bridge_states,
} from '../db/schema';
import { listAvailablePairs, pairExists } from '../lib/context-brief';

const r = new Hono();

/** inArray() on an empty list produces invalid SQL — every join-by-id below
 *  guards with this instead (same pattern as read.ts's mindmap association
 *  lookups). */
async function byIds<T>(ids: string[], query: (ids: string[]) => Promise<T[]>): Promise<T[]> {
  return ids.length ? query(ids) : [];
}

r.get('/pairs/:pairId/export', async (c) => {
  const pairId = c.req.param('pairId');
  if (!(await pairExists(pairId))) {
    return c.json(
      { error: 'pair_not_found', pair_id: pairId, available_pairs: await listAvailablePairs() },
      404
    );
  }

  const [pairRows] = await Promise.all([
    db.select().from(learner_agent_pairs).where(eq(learner_agent_pairs.id, pairId)).limit(1),
  ]);
  const pair = pairRows[0]!;

  const [learnerRows, agentRows, bridgeStateRows] = await Promise.all([
    db.select().from(learners).where(eq(learners.id, pair.learner_id)).limit(1),
    db.select().from(agents).where(eq(agents.id, pair.agent_id)).limit(1),
    db.select().from(bridge_states).where(eq(bridge_states.pair_id, pairId)).limit(1),
  ]);

  // First layer: everything with a direct pair_id / owner_pair_id column.
  const [
    contracts,
    coursesRows,
    flashcardsRows,
    documentsRows,
    annotationsRows,
    mindmapsRows,
    pendingCardsRows,
    hypothesesRows,
    reflectionsRows,
    sessionsRows,
    eventsRows,
    evaluationsRows,
    simQuizzesRows,
    remindersRows,
    feedbackRows,
    threadsRows,
    liveSessionsRows,
  ] = await Promise.all([
    db.select().from(teaching_contracts).where(eq(teaching_contracts.pair_id, pairId)),
    db.select().from(courses).where(eq(courses.pair_id, pairId)),
    db.select().from(flashcards).where(eq(flashcards.pair_id, pairId)),
    db.select().from(documents).where(eq(documents.pair_id, pairId)),
    db.select().from(lesson_annotations).where(eq(lesson_annotations.pair_id, pairId)),
    db.select().from(mindmaps).where(eq(mindmaps.owner_pair_id, pairId)),
    db.select().from(pending_mindmap_cards).where(eq(pending_mindmap_cards.owner_pair_id, pairId)),
    db.select().from(learner_hypotheses).where(eq(learner_hypotheses.pair_id, pairId)),
    db.select().from(teacher_reflections).where(eq(teacher_reflections.pair_id, pairId)),
    db.select().from(learning_sessions).where(eq(learning_sessions.pair_id, pairId)),
    db.select().from(session_events).where(eq(session_events.pair_id, pairId)),
    db.select().from(post_lesson_evaluations).where(eq(post_lesson_evaluations.pair_id, pairId)),
    db.select().from(simulated_quizzes).where(eq(simulated_quizzes.pair_id, pairId)),
    db.select().from(reminders).where(eq(reminders.pair_id, pairId)),
    db.select().from(learner_feedback).where(eq(learner_feedback.pair_id, pairId)),
    db.select().from(ad_hoc_threads).where(eq(ad_hoc_threads.pair_id, pairId)),
    db.select().from(live_sessions).where(eq(live_sessions.pair_id, pairId)),
  ]);

  const courseIds = coursesRows.map((row) => row.id);
  const mindmapIds = mindmapsRows.map((row) => row.id);
  const simQuizIds = simQuizzesRows.map((row) => row.id);
  const threadIds = threadsRows.map((row) => row.id);
  const liveSessionIds = liveSessionsRows.map((row) => row.id);

  // Second layer: one hop from courses / mindmaps / quizzes / threads / live sessions.
  const [lessonsRows, conceptsRows, mindmapAssocRows, simQuizAttemptsRows, adHocMessagesRows] =
    await Promise.all([
      byIds(courseIds, (ids) => db.select().from(lessons).where(inArray(lessons.course_id, ids))),
      byIds(courseIds, (ids) => db.select().from(concepts).where(inArray(concepts.course_id, ids))),
      byIds(mindmapIds, (ids) =>
        db.select().from(mindmap_associations).where(inArray(mindmap_associations.mindmap_id, ids))
      ),
      byIds(simQuizIds, (ids) =>
        db.select().from(simulated_quiz_attempts).where(inArray(simulated_quiz_attempts.quiz_id, ids))
      ),
      byIds(threadIds, (ids) =>
        db.select().from(ad_hoc_messages).where(inArray(ad_hoc_messages.thread_id, ids))
      ),
    ]);

  const lessonIds = lessonsRows.map((row) => row.id);

  // Third layer: one hop from lessons / live sessions.
  const [exercisesRows, lessonRevisionsRows, teachingMovesRows, teachingResponsesRows, midLessonSnapshotsRows] =
    await Promise.all([
      byIds(lessonIds, (ids) => db.select().from(exercises).where(inArray(exercises.lesson_id, ids))),
      byIds(lessonIds, (ids) =>
        db.select().from(lesson_revisions).where(inArray(lesson_revisions.lesson_id, ids))
      ),
      byIds(liveSessionIds, (ids) =>
        db.select().from(teaching_moves).where(inArray(teaching_moves.session_id, ids))
      ),
      byIds(liveSessionIds, (ids) =>
        db.select().from(teaching_responses).where(inArray(teaching_responses.session_id, ids))
      ),
      byIds(liveSessionIds, (ids) =>
        db.select().from(mid_lesson_snapshots).where(inArray(mid_lesson_snapshots.session_id, ids))
      ),
    ]);

  const exerciseIds = exercisesRows.map((row) => row.id);

  // Fourth layer: one hop from exercises. exercise_submissions has no course/
  // pair chain of its own — scoping by exercise_id (already pair-scoped
  // above) is what keeps this correct instead of over-broad by learner_id
  // (a learner could in principle sit in more than one pair).
  const [exerciseSubmissionsRows, quizAttemptsRows] = await Promise.all([
    byIds(exerciseIds, (ids) =>
      db.select().from(exercise_submissions).where(inArray(exercise_submissions.exercise_id, ids))
    ),
    // quiz_attempts (真题路径) has no pair_id at all — it hangs off
    // learner_id + a shared question_banks row. learner_id is the only
    // scoping key available; single-tenant self-host today means one
    // learner ↔ one pair in practice, so this is exact, not a superset.
    db.select().from(quiz_attempts).where(eq(quiz_attempts.learner_id, pair.learner_id)),
  ]);

  return c.json({
    format_version: 1,
    exported_at: new Date().toISOString(),
    pair_id: pairId,

    pair,
    learner: learnerRows[0] ?? null,
    agent: agentRows[0] ?? null,
    agent_bridge_state: bridgeStateRows[0] ?? null,

    contracts,
    courses: coursesRows,
    lessons: lessonsRows,
    lesson_revisions: lessonRevisionsRows,
    concepts: conceptsRows,
    flashcards: flashcardsRows,
    exercises: exercisesRows,
    exercise_submissions: exerciseSubmissionsRows,

    documents: documentsRows,
    annotations: annotationsRows,

    mindmaps: mindmapsRows,
    mindmap_associations: mindmapAssocRows,
    pending_mindmap_cards: pendingCardsRows,

    learner_hypotheses: hypothesesRows,
    teacher_reflections: reflectionsRows,

    learning_sessions: sessionsRows,
    session_events: eventsRows,
    post_lesson_evaluations: evaluationsRows,

    simulated_quizzes: simQuizzesRows,
    simulated_quiz_attempts: simQuizAttemptsRows,
    quiz_attempts: quizAttemptsRows,

    reminders: remindersRows,
    learner_feedback: feedbackRows,

    ad_hoc_threads: threadsRows,
    ad_hoc_messages: adHocMessagesRows,

    live_sessions: liveSessionsRows,
    teaching_moves: teachingMovesRows,
    teaching_responses: teachingResponsesRows,
    mid_lesson_snapshots: midLessonSnapshotsRows,
  });
});

export default r;

// ============================================================================
// Inventory (grep pair_id / owner_pair_id across db/schema, 2026-07-09):
//
// Direct pair_id:        teaching_contracts, courses, flashcards, documents,
//                        lesson_annotations, learner_hypotheses,
//                        teacher_reflections, learning_sessions,
//                        session_events, post_lesson_evaluations,
//                        simulated_quizzes, reminders, learner_feedback,
//                        ad_hoc_threads, live_sessions, bridge_states (PK).
// Direct owner_pair_id:  mindmaps, pending_mindmap_cards.
// One hop (via FK):      lessons (courses), concepts (courses),
//                        mindmap_associations (mindmaps),
//                        simulated_quiz_attempts (simulated_quizzes),
//                        ad_hoc_messages (ad_hoc_threads),
//                        teaching_moves / teaching_responses /
//                        mid_lesson_snapshots (live_sessions).
// Two hops:              exercises, lesson_revisions (lessons).
// Three hops:            exercise_submissions (exercises).
// Learner-scoped, no
//   pair chain at all:   quiz_attempts (learner_id only — see comment above).
// Deliberately excluded: question_banks, quiz_questions — shared reference
//                        exam content, not owned by any one pair.
// ============================================================================
