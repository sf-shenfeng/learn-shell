// Round-trip test for course DELETE (Archive semantics graveyard
// export) → POST /courses/restore reinsert, every table compared row-for-row
// (timestamp fields exempted, per this task's stated acceptance bar). Also
// covers the purge-semantics branch (graveyard file actually removed
// from disk, not just the DB rows) and the restore 409 collision guard.
//
// No live Postgres is reachable in this sandbox — same constraint every
// other DB-touching test file in this repo documents (see
// lib/currentContract.test.ts / lib/idempotency.test.ts headers). Every
// test below pings the DB first and calls `t.skip(...)` instead of failing
// red when it's unreachable, so this is real, runnable coverage the moment
// a real Postgres is up (`docker compose up -d && pnpm --filter
// @learn-shell/server db:migrate`), not a mock standing in for one.
//
// Uses Hono's `app.request()` (no real network socket) against the actual
// exported app (apps/server/src/index.ts only auto-`serve()`s when run as
// the entrypoint, so importing it here is side-effect-free for listening).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { sql, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { requireBenchDatabase } from '../lib/require-bench-db';
import {
  agents,
  learners,
  learner_agent_pairs,
  courses,
  lessons,
  concepts,
  flashcards,
  exercises,
  exercise_submissions,
  lesson_progress,
  lesson_revisions,
  lesson_patches,
  lesson_loop_receipts,
  simulated_quizzes,
  simulated_quiz_attempts,
  syllabus_nodes,
  syllabus_mappings,
  mindmaps,
  mindmap_associations,
} from '../db/schema';
import { newCardState } from '../lib/fsrs';
import app from '../index';

let dbAvailable = true;
before(async () => {
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbAvailable = false;
    console.log(
      '[write.restore.test] no live Postgres reachable in this sandbox — DB-backed round-trip tests will report as skipped, not passed or failed.'
    );
    return;
  }
  // 硬闸门 — DB 可达之后, 写测试数据(seedFixture: 'Test Learner'/
  // 'Test Agent', id 前缀 pair_t144test_...)之前先确认这可达的库真是 bench
  // 库。7/19 就是反过来: 可达检查通过了(DATABASE_URL 悄悄默认成了生产库
  // learn_shell), 于是 18 对测试数据睡进了生产库。这里不静默跳过——库名不
  // 对就直接抛错炸穿 before(), 让所有测试全红, 而不是安安静静地把测试数据
  // 写进错的库。
  requireBenchDatabase(process.env.DATABASE_URL, 'write.restore.test.ts (seedFixture creates Test Learner/Test Agent pairs)');
});

function uid(prefix: string): string {
  return `${prefix}_t144test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Timestamp columns are explicitly exempt from the round-trip comparison
// (this task's acceptance bar) — restore always writes a *new* Date object
// reconstructed from the graveyard's ISO string, and Postgres itself may
// shave sub-millisecond precision, so byte-identical timestamps were never
// the guarantee. What restore promises is: same rows, same non-timestamp
// content, same relationships.
const TS_FIELDS = new Set([
  'created_at',
  'updated_at',
  'submitted_at',
  'withdrew_at',
  'graded_at',
  'declared_at',
  'closed_at',
  'revised_at',
  'started_at',
  'finished_at',
]);

function stripTimestamps(row: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!row) return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!TS_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

function stripTimestampsAll(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows
    .map((r) => stripTimestamps(r)!)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

interface Fixture {
  agentId: string;
  learnerId: string;
  pairId: string;
  courseId: string;
  lessonId: string;
  conceptId: string;
  flashcardId: string;
  exerciseId: string;
  submissionId: string;
  progressId: string;
  revisionId: string;
  patchId: string;
  receiptId: string;
  quizId: string;
  attemptId: string;
  syllabusNodeId: string;
  syllabusMappingId: string;
  mindmapId: string;
  mindmapAssocId: string;
}

// Fixture covers every table the graveyard format touches, at least one row
// each: lesson, concept, flashcard, exercise+submission, progress,
// quiz+attempt (this task's explicit minimum bar) plus lesson_revisions/
// lesson_patches/lesson_loop_receipts/syllabus_mappings/mindmap_associations
// (the rest of the FK chain the restore endpoint's insert order walks).
async function seedFixture(): Promise<Fixture> {
  const now = new Date();
  const f: Fixture = {
    agentId: uid('agent'),
    learnerId: uid('learner'),
    pairId: uid('pair'),
    courseId: uid('course'),
    lessonId: uid('lesson'),
    conceptId: uid('concept'),
    flashcardId: uid('fc'),
    exerciseId: uid('ex'),
    submissionId: uid('sub'),
    progressId: uid('lprog'),
    revisionId: uid('lrev'),
    patchId: uid('lpatch'),
    receiptId: uid('lreceipt'),
    quizId: uid('sq'),
    attemptId: uid('sqa'),
    syllabusNodeId: uid('synode'),
    syllabusMappingId: uid('symap'),
    mindmapId: uid('mm'),
    mindmapAssocId: uid('mma'),
  };

  await db.insert(agents).values({ id: f.agentId, display_name: 'Test Agent', provider: 'test' });
  await db
    .insert(learners)
    .values({ id: f.learnerId, display_name: 'Test Learner', preferences: { timezone: 'UTC', locale: 'en' } });
  await db.insert(learner_agent_pairs).values({ id: f.pairId, learner_id: f.learnerId, agent_id: f.agentId });

  await db.insert(courses).values({
    id: f.courseId,
    pair_id: f.pairId,
    topic: 'Restore round-trip fixture',
    structure: { lesson_ids: [f.lessonId] },
  });
  await db.insert(lessons).values({
    id: f.lessonId,
    course_id: f.courseId,
    order: 1,
    title: 'Fixture lesson',
    concept_ids: [f.conceptId],
  });
  await db.insert(concepts).values({
    id: f.conceptId,
    lesson_id: f.lessonId,
    course_id: f.courseId,
    name: 'Fixture concept',
    flashcard_ids: [f.flashcardId],
  });
  await db.insert(flashcards).values({
    id: f.flashcardId,
    pair_id: f.pairId,
    concept_id: f.conceptId,
    deck_id: 'deck_default',
    front: 'Q',
    back: 'A',
    fsrs_state: newCardState(now),
  });
  await db.insert(exercises).values({
    id: f.exerciseId,
    lesson_id: f.lessonId,
    order: 1,
    prompt: 'Prompt',
    reference_answer: 'Answer',
    agent_skill_used: 'test-skill',
  });
  await db.insert(exercise_submissions).values({
    id: f.submissionId,
    exercise_id: f.exerciseId,
    learner_id: f.learnerId,
    learner_answer: 'My answer',
    status: 'submitted',
    submitted_at: now,
  });
  await db.insert(lesson_progress).values({
    id: f.progressId,
    pair_id: f.pairId,
    lesson_id: f.lessonId,
    state: 'in_progress',
  });
  await db.insert(lesson_revisions).values({
    id: f.revisionId,
    lesson_id: f.lessonId,
    revision: 1,
    prev_title: 'Old title',
    reason: 'test revision',
    revised_by: 'test',
  });
  await db.insert(lesson_patches).values({
    id: f.patchId,
    lesson_id: f.lessonId,
    pair_id: f.pairId,
    kind: 'teacher_note',
    body: 'note body',
  });
  await db.insert(lesson_loop_receipts).values({
    id: f.receiptId,
    pair_id: f.pairId,
    lesson_id: f.lessonId,
    kind: 'teacher_note',
    description: 'receipt body',
  });
  await db.insert(simulated_quizzes).values({
    id: f.quizId,
    pair_id: f.pairId,
    course_id: f.courseId,
    agent_skill_used: 'test-skill',
    questions: [
      {
        id: 'q1',
        stem: 'stem',
        question_type: 'short_answer',
        reference_answer: 'ans',
        concept_tags: [],
      },
    ],
  });
  await db.insert(simulated_quiz_attempts).values({
    id: f.attemptId,
    quiz_id: f.quizId,
    learner_id: f.learnerId,
    answers: [{ question_id: 'q1', answer: 'ans' }],
  });
  await db.insert(syllabus_nodes).values({
    id: f.syllabusNodeId,
    pair_id: f.pairId,
    code: 'TEST-1',
    title: 'Test syllabus node',
    syllabus_version: 'TEST-v1',
  });
  await db.insert(syllabus_mappings).values({
    id: f.syllabusMappingId,
    pair_id: f.pairId,
    node_id: f.syllabusNodeId,
    asset_type: 'lesson',
    asset_id: f.lessonId,
    mapped_by: 'agent',
  });
  await db.insert(mindmaps).values({
    id: f.mindmapId,
    owner_pair_id: f.pairId,
    scope: 'course',
    title: 'Test mindmap',
    agent_seed_snapshot: { nodes: [], links: [] },
    content: { nodes: [], links: [] },
  });
  await db.insert(mindmap_associations).values({
    id: f.mindmapAssocId,
    mindmap_id: f.mindmapId,
    target_type: 'course',
    target_id: f.courseId,
  });

  return f;
}

async function readAllCourseRows(f: Fixture) {
  const [courseRow] = await db.select().from(courses).where(eq(courses.id, f.courseId));
  const [
    lessonRows,
    conceptRows,
    flashcardRows,
    exerciseRows,
    submissionRows,
    progressRows,
    revisionRows,
    patchRows,
    receiptRows,
    quizRows,
    attemptRows,
    mappingRows,
    assocRows,
  ] = await Promise.all([
    db.select().from(lessons).where(eq(lessons.course_id, f.courseId)),
    db.select().from(concepts).where(eq(concepts.course_id, f.courseId)),
    db.select().from(flashcards).where(eq(flashcards.concept_id, f.conceptId)),
    db.select().from(exercises).where(eq(exercises.lesson_id, f.lessonId)),
    db.select().from(exercise_submissions).where(eq(exercise_submissions.exercise_id, f.exerciseId)),
    db.select().from(lesson_progress).where(eq(lesson_progress.lesson_id, f.lessonId)),
    db.select().from(lesson_revisions).where(eq(lesson_revisions.lesson_id, f.lessonId)),
    db.select().from(lesson_patches).where(eq(lesson_patches.lesson_id, f.lessonId)),
    db.select().from(lesson_loop_receipts).where(eq(lesson_loop_receipts.lesson_id, f.lessonId)),
    db.select().from(simulated_quizzes).where(eq(simulated_quizzes.course_id, f.courseId)),
    db.select().from(simulated_quiz_attempts).where(eq(simulated_quiz_attempts.quiz_id, f.quizId)),
    db.select().from(syllabus_mappings).where(eq(syllabus_mappings.id, f.syllabusMappingId)),
    db.select().from(mindmap_associations).where(eq(mindmap_associations.id, f.mindmapAssocId)),
  ]);
  return {
    courseRow,
    lessonRows,
    conceptRows,
    flashcardRows,
    exerciseRows,
    submissionRows,
    progressRows,
    revisionRows,
    patchRows,
    receiptRows,
    quizRows,
    attemptRows,
    mappingRows,
    assocRows,
  };
}

// Cleans up everything seedFixture() created, regardless of which test
// phase we're at (course row may or may not still exist — deleting it
// cascades whatever's left; the independent entities never touched by
// course delete are cleaned explicitly). Best-effort: a row missing because
// an earlier step already removed it is not a teardown failure.
async function teardownFixture(f: Fixture) {
  await db.delete(courses).where(eq(courses.id, f.courseId));
  await db.delete(mindmap_associations).where(eq(mindmap_associations.id, f.mindmapAssocId));
  await db.delete(mindmaps).where(eq(mindmaps.id, f.mindmapId));
  await db.delete(syllabus_mappings).where(eq(syllabus_mappings.id, f.syllabusMappingId));
  await db.delete(syllabus_nodes).where(eq(syllabus_nodes.id, f.syllabusNodeId));
  await db.delete(learner_agent_pairs).where(eq(learner_agent_pairs.id, f.pairId));
  await db.delete(learners).where(eq(learners.id, f.learnerId));
  await db.delete(agents).where(eq(agents.id, f.agentId));
}

test('course DELETE (archive) -> POST /courses/restore round-trips every table', async (t) => {
  if (!dbAvailable) {
    t.skip('no live Postgres reachable in this sandbox — run against docker-compose db to validate');
    return;
  }

  const graveyardDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-graveyard-test-'));
  process.env.LS_GRAVEYARD_DIR = graveyardDir;

  const fixture = await seedFixture();
  try {
    const beforeRows = await readAllCourseRows(fixture);

    const delRes = await app.request(`/api/courses/${fixture.courseId}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const delBody = (await delRes.json()) as { semantics: string; graveyard_file: string | null };
    assert.equal(delBody.semantics, 'archive');
    assert.ok(delBody.graveyard_file, 'archive delete must name its graveyard file');

    // Live rows are gone — cascade + application-layer cleanup did its job.
    const afterDelete = await readAllCourseRows(fixture);
    assert.equal(afterDelete.courseRow, undefined);
    assert.equal(afterDelete.lessonRows.length, 0);
    assert.equal(afterDelete.flashcardRows.length, 0);
    assert.equal(afterDelete.quizRows.length, 0);
    assert.equal(afterDelete.attemptRows.length, 0);
    assert.equal(afterDelete.mappingRows.length, 0);
    assert.equal(afterDelete.assocRows.length, 0);

    const graveyardRaw = await fs.readFile(path.join(graveyardDir, delBody.graveyard_file!), 'utf8');
    const graveyard = JSON.parse(graveyardRaw);

    const restoreRes = await app.request('/api/courses/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graveyard }),
    });
    const restoreBodyText = await restoreRes.text();
    assert.equal(restoreRes.status, 201, `restore should succeed, got: ${restoreBodyText}`);
    const restoreBody = JSON.parse(restoreBodyText) as { restored: boolean; course_id: string };
    assert.equal(restoreBody.restored, true);
    assert.equal(restoreBody.course_id, fixture.courseId);

    const afterRestore = await readAllCourseRows(fixture);
    assert.deepEqual(
      stripTimestamps(afterRestore.courseRow as unknown as Record<string, unknown>),
      stripTimestamps(beforeRows.courseRow as unknown as Record<string, unknown>)
    );
    assert.deepEqual(
      stripTimestampsAll(afterRestore.lessonRows as unknown as Record<string, unknown>[]),
      stripTimestampsAll(beforeRows.lessonRows as unknown as Record<string, unknown>[])
    );
    assert.deepEqual(
      stripTimestampsAll(afterRestore.conceptRows as unknown as Record<string, unknown>[]),
      stripTimestampsAll(beforeRows.conceptRows as unknown as Record<string, unknown>[])
    );
    assert.deepEqual(
      stripTimestampsAll(afterRestore.flashcardRows as unknown as Record<string, unknown>[]),
      stripTimestampsAll(beforeRows.flashcardRows as unknown as Record<string, unknown>[])
    );
    assert.deepEqual(
      stripTimestampsAll(afterRestore.exerciseRows as unknown as Record<string, unknown>[]),
      stripTimestampsAll(beforeRows.exerciseRows as unknown as Record<string, unknown>[])
    );
    assert.deepEqual(
      stripTimestampsAll(afterRestore.submissionRows as unknown as Record<string, unknown>[]),
      stripTimestampsAll(beforeRows.submissionRows as unknown as Record<string, unknown>[])
    );
    assert.deepEqual(
      stripTimestampsAll(afterRestore.progressRows as unknown as Record<string, unknown>[]),
      stripTimestampsAll(beforeRows.progressRows as unknown as Record<string, unknown>[])
    );
    assert.deepEqual(
      stripTimestampsAll(afterRestore.revisionRows as unknown as Record<string, unknown>[]),
      stripTimestampsAll(beforeRows.revisionRows as unknown as Record<string, unknown>[])
    );
    assert.deepEqual(
      stripTimestampsAll(afterRestore.patchRows as unknown as Record<string, unknown>[]),
      stripTimestampsAll(beforeRows.patchRows as unknown as Record<string, unknown>[])
    );
    assert.deepEqual(
      stripTimestampsAll(afterRestore.receiptRows as unknown as Record<string, unknown>[]),
      stripTimestampsAll(beforeRows.receiptRows as unknown as Record<string, unknown>[])
    );
    assert.deepEqual(
      stripTimestampsAll(afterRestore.quizRows as unknown as Record<string, unknown>[]),
      stripTimestampsAll(beforeRows.quizRows as unknown as Record<string, unknown>[])
    );
    assert.deepEqual(
      stripTimestampsAll(afterRestore.attemptRows as unknown as Record<string, unknown>[]),
      stripTimestampsAll(beforeRows.attemptRows as unknown as Record<string, unknown>[])
    );
    assert.deepEqual(
      stripTimestampsAll(afterRestore.mappingRows as unknown as Record<string, unknown>[]),
      stripTimestampsAll(beforeRows.mappingRows as unknown as Record<string, unknown>[])
    );
    assert.deepEqual(
      stripTimestampsAll(afterRestore.assocRows as unknown as Record<string, unknown>[]),
      stripTimestampsAll(beforeRows.assocRows as unknown as Record<string, unknown>[])
    );

    // Restoring again on top of the now-live data must abort, not merge.
    const conflictRes = await app.request('/api/courses/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graveyard }),
    });
    assert.equal(conflictRes.status, 409);
  } finally {
    await teardownFixture(fixture);
    await fs.rm(graveyardDir, { recursive: true, force: true });
    delete process.env.LS_GRAVEYARD_DIR;
  }
});

test('course DELETE ?purge=true removes the graveyard file — no recovery path survives', async (t) => {
  if (!dbAvailable) {
    t.skip('no live Postgres reachable in this sandbox — run against docker-compose db to validate');
    return;
  }

  const graveyardDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-graveyard-test-'));
  process.env.LS_GRAVEYARD_DIR = graveyardDir;

  const fixture = await seedFixture();
  try {
    const delRes = await app.request(`/api/courses/${fixture.courseId}?purge=true`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const delBody = (await delRes.json()) as { semantics: string; graveyard_file: string | null };
    assert.equal(delBody.semantics, 'purge');
    assert.equal(delBody.graveyard_file, null);

    const files = await fs.readdir(graveyardDir);
    assert.equal(files.length, 0, 'purge must leave no graveyard file behind');
  } finally {
    await teardownFixture(fixture);
    await fs.rm(graveyardDir, { recursive: true, force: true });
    delete process.env.LS_GRAVEYARD_DIR;
  }
});

test('DELETE /api/simulated-quizzes/:id cascades attempts and leaves a small graveyard', async (t) => {
  if (!dbAvailable) {
    t.skip('no live Postgres reachable in this sandbox — run against docker-compose db to validate');
    return;
  }

  const graveyardDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-graveyard-test-'));
  process.env.LS_GRAVEYARD_DIR = graveyardDir;

  const fixture = await seedFixture();
  try {
    const delRes = await app.request(`/api/simulated-quizzes/${fixture.quizId}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const delBody = (await delRes.json()) as {
      quiz_id: string;
      attempts_deleted: number;
      graveyard_file: string;
    };
    assert.equal(delBody.quiz_id, fixture.quizId);
    assert.equal(delBody.attempts_deleted, 1);
    assert.ok(delBody.graveyard_file);

    const [remainingQuiz] = await db
      .select()
      .from(simulated_quizzes)
      .where(eq(simulated_quizzes.id, fixture.quizId));
    assert.equal(remainingQuiz, undefined);
    const remainingAttempts = await db
      .select()
      .from(simulated_quiz_attempts)
      .where(eq(simulated_quiz_attempts.quiz_id, fixture.quizId));
    assert.equal(remainingAttempts.length, 0);

    const tombstoneRaw = await fs.readFile(path.join(graveyardDir, delBody.graveyard_file), 'utf8');
    const tombstone = JSON.parse(tombstoneRaw);
    assert.equal(tombstone.simulated_quizzes.length, 1);
    assert.equal(tombstone.simulated_quiz_attempts.length, 1);

    const secondDelete = await app.request(`/api/simulated-quizzes/${fixture.quizId}`, { method: 'DELETE' });
    assert.equal(secondDelete.status, 404);
  } finally {
    await teardownFixture(fixture);
    await fs.rm(graveyardDir, { recursive: true, force: true });
    delete process.env.LS_GRAVEYARD_DIR;
  }
});
