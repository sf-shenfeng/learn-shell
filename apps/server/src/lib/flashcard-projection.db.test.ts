import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { requireBenchDatabase } from './require-bench-db';

test('bench: completed lessons, reverse provenance, REST review gate, reconcile preservation/idempotency',
  { skip: process.env.RUN_DB_TESTS !== '1' }, async () => {
    requireBenchDatabase(process.env.DATABASE_URL, 'flashcard-projection.db.test');
    const { db, closeDb } = await import('../db/client');
    const { learners, agents, learner_agent_pairs, courses, lessons, concepts, flashcards,
      lesson_progress, live_sessions, exercises } = await import('../db/schema');
    const { getDueFlashcards } = await import('./flashcard-projection');
    const { newCardState } = await import('./fsrs');
    const { default: read } = await import('../routes/read');
    const { default: write } = await import('../routes/write');
    const app = new Hono().route('/api', read).route('/api', write);
    const prefix = `projection_${Date.now()}`;
    const learner = `${prefix}_learner`, agent = `${prefix}_agent`, pair = `${prefix}_pair`;
    const course = `${prefix}_course`, done = `${prefix}_done`, pending = `${prefix}_pending`, live = `${prefix}_live`;
    const cDone = `${prefix}_cd`, cPending = `${prefix}_cp`, cLive = `${prefix}_cl`, cAmbiguous = `${prefix}_ca`;
    const reversed = `${prefix}_reversed`, ambiguous = `${prefix}_ambiguous`, free = `${prefix}_free`, old = `${prefix}_old`, paused = `${prefix}_paused`;
    const request = (path: string, body: object, method = 'POST') => app.request(`/api${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    try {
      await db.insert(learners).values({ id: learner, display_name: 'Projection bench', preferences: { timezone: 'UTC', locale: 'en' } });
      await db.insert(agents).values({ id: agent, display_name: 'Bench', provider: 'test' });
      await db.insert(learner_agent_pairs).values({ id: pair, learner_id: learner, agent_id: agent, active: true });
      await db.insert(courses).values({ id: course, pair_id: pair, topic: 'Bench', structure: { lesson_ids: [done, pending, live] } });
      await db.insert(lessons).values([done, pending, live].map((id, i) => ({ id, course_id: course, title: id, order: i }))); // concept_ids deliberately empty
      await db.insert(concepts).values([
        { id: cDone, lesson_id: done, course_id: course, name: 'Done', flashcard_ids: [reversed, ambiguous] },
        { id: cPending, lesson_id: pending, course_id: course, name: 'Pending' },
        { id: cLive, lesson_id: live, course_id: course, name: 'Live' },
        { id: cAmbiguous, lesson_id: pending, course_id: course, name: 'Ambiguous', flashcard_ids: [ambiguous] },
      ]);
      await db.insert(lesson_progress).values({ id: `${prefix}_progress`, pair_id: pair, lesson_id: done, state: 'completed_declared' });
      await db.insert(live_sessions).values({ id: `${prefix}_session`, pair_id: pair, context_id: live, context_type: 'lesson', status: 'completed' });
      const state = { ...newCardState(new Date('2026-01-01')), review_count: 7, stability: 8, difficulty: 5 };
      await db.insert(flashcards).values([
        { id: old, concept_id: cPending, activated: true, paused: false },
        { id: reversed, concept_id: null, activated: false, paused: false },
        { id: ambiguous, concept_id: null, activated: true, paused: false },
        { id: free, concept_id: null, activated: true, paused: false },
        { id: paused, concept_id: cDone, activated: false, paused: true },
      ].map((c) => ({ ...c, pair_id: pair, deck_id: 'bench', front: 'front', back: 'back', source_refs: [], fsrs_state: state })));
      const create = async (concept_id: string | null) => {
        const response = await request('/flashcards', { pair_id: pair, concept_id, deck_id: 'bench', front: 'front', back: 'back' });
        assert.equal(response.status, 201); return response.json() as Promise<any>;
      };
      const late = await create(cDone), liveCard = await create(cLive), independent = await create(null);
      assert.equal(late.activated, true, 'late card inherits completed lesson');
      assert.equal(liveCard.activated, true, 'completed Live qualifies without lesson_progress');
      assert.equal(independent.activated, false, 'independent starts dormant');
      await db.insert(exercises).values({ id: `${prefix}_ex`, lesson_id: pending, order: 1, prompt: '?', reference_answer: '!', agent_skill_used: 'test' });
      const submission = await request('/submissions', { learner_id: learner, exercise_id: `${prefix}_ex`, learner_answer: 'answer' });
      assert.equal(submission.status, 201);
      const all = await (await app.request(`/api/pairs/${pair}/flashcards`)).json() as any[];
      assert.equal(all.find((c: any) => c.id === old).activated, false, 'submission and old review history do not complete lesson');
      assert.equal(all.find((c: any) => c.id === reversed).lesson_id, done);
      assert.equal(all.find((c: any) => c.id === ambiguous).source_status, 'unresolved');
      const due = await (await app.request(`/api/pairs/${pair}/reviews/due`)).json() as any[];
      assert.deepEqual(due.map((c: any) => c.id), (await getDueFlashcards(db, pair)).map((c) => c.id), 'REST uses same projection as MCP resource');
      assert.equal(due.some((c: any) => c.id === old || c.id === paused), false);
      assert.equal((await request('/reviews', { pair_id: pair, card_id: old, rating: 'Good' })).status, 409);
      assert.equal((await request('/flashcards/' + old, { activated: true }, 'PATCH')).status, 409);
      assert.equal((await request('/flashcards/' + independent.id, { activated: true }, 'PATCH')).status, 200);
      assert.equal((await request('/flashcards/' + ambiguous, { activated: true }, 'PATCH')).status, 409);
      const firstReview = await request('/reviews', { pair_id: pair, card_id: reversed, rating: 'Good' });
      assert.equal(firstReview.status, 200);
      const afterFirstReview = await firstReview.json() as any;
      assert.equal((await request('/reviews', { pair_id: pair, card_id: reversed, rating: 'Good' })).status, 409,
        'a saved review cannot be silently repeated by undo/back/restart UI');
      const [storedAfterRetry] = await db.select().from(flashcards).where(eq(flashcards.id, reversed));
      assert.deepEqual(storedAfterRetry!.fsrs_state, afterFirstReview.fsrs_state, 'rejected retry preserves FSRS');
      const before = await db.select().from(flashcards).where(eq(flashcards.pair_id, pair));
      const script = fileURLToPath(new URL('../../scripts/reconcile-flashcard-eligibility.ts', import.meta.url));
      const reconcile = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', script, `--pair-id=${pair}`, ...args], { encoding: 'utf8', env: process.env }));
      assert.ok(reconcile().changes.length > 0);
      assert.deepEqual(await db.select().from(flashcards).where(eq(flashcards.pair_id, pair)), before, 'dry-run writes nothing');
      reconcile('--apply', `--opt-out-unlinked-ids=${free}`);
      assert.equal(reconcile().changes.length, 0, 'second reconcile is idempotent');
      const after = await db.select().from(flashcards).where(eq(flashcards.pair_id, pair));
      for (const b of before) {
        const a = after.find((c) => c.id === b.id)!;
        const { concept_id: _bc, activated: _ba, ...unchangedBefore } = b;
        const { concept_id: _ac, activated: _aa, ...unchangedAfter } = a;
        assert.deepEqual(unchangedAfter, unchangedBefore, 'only concept_id/activated may change');
      }
      assert.equal(after.find((c) => c.id === reversed)!.concept_id, cDone);
      assert.equal(after.find((c) => c.id === free)!.activated, false);
      assert.equal(after.find((c) => c.id === independent.id)!.activated, true, 'manual independent opt-in survives subsequent reconcile');
    } finally {
      await db.delete(learner_agent_pairs).where(eq(learner_agent_pairs.id, pair));
      await db.delete(agents).where(eq(agents.id, agent));
      await db.delete(learners).where(eq(learners.id, learner));
      await closeDb();
    }
  });
