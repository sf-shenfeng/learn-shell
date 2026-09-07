import test from 'node:test';
import assert from 'node:assert/strict';
import type { Flashcard } from '@learn-shell/contracts';
import { cardLessonId, cardCourseId, dueReviewCards, isActiveCard, isDueReviewCard } from './cardEligibility';

const now = Date.parse('2026-09-06T12:00:00Z');
function card(id: string, patch: Partial<Flashcard> = {}): Flashcard {
  return { id, activated: true, paused: false, fsrs_state: { due_at: '2026-09-05T12:00:00Z' }, ...patch } as Flashcard;
}

test('review excludes unlearned, paused and future cards while management retains everything', () => {
  const learned = card('learned');
  const unlearned = card('unlearned', { activated: false });
  const testCard = card('test', { activated: false, concept_id: null });
  const paused = card('paused', { paused: true });
  const future = card('future', { fsrs_state: { due_at: '2026-09-07T00:00:00Z' } as Flashcard['fsrs_state'] });
  const all = [learned, unlearned, testCard, paused, future];
  assert.deepEqual(dueReviewCards(all, now), [learned]);
  assert.equal(all.length, 5);
  assert.deepEqual(all.filter(isActiveCard), [learned, paused, future]);
});

test('missing activation is not proof of having learned a card', () => {
  assert.equal(isDueReviewCard(card('legacy', { activated: undefined }), now), false);
});

test('due order is oldest first and exact due boundary is eligible', () => {
  const boundary = card('boundary', { fsrs_state: { due_at: new Date(now).toISOString() } as Flashcard['fsrs_state'] });
  const older = card('older');
  assert.deepEqual(dueReviewCards([boundary, older], now), [older, boundary]);
});

test('authoritative lesson/course provenance wins over stale inverse concept indexes', () => {
  const located = { ...card('located'), lesson_id: 'real-lesson' as NonNullable<Flashcard['lesson_id']>, course_id: 'real-course' as NonNullable<Flashcard['course_id']> };
  assert.equal(cardLessonId(located, 'stale-lesson'), 'real-lesson');
  assert.equal(cardCourseId(located, 'stale-course'), 'real-course');
});

test('explicit unresolved provenance never groups a test card from a legacy hint', () => {
  const unresolved = { ...card('test'), lesson_id: null, course_id: null };
  assert.equal(cardLessonId(unresolved, 'guessed-lesson'), undefined);
  assert.equal(cardCourseId(unresolved, 'guessed-course'), undefined);
});

test('older repository fixtures may use verified concept indexes as fallback', () => {
  assert.equal(cardLessonId(card('old'), 'lesson'), 'lesson');
  assert.equal(cardCourseId(card('old'), 'course'), 'course');
});

test('default, course, lesson and deck scopes all obey FSRS eligibility', async () => {
  const { scopeDueReviewCards } = await import('./cardEligibility');
  const location = { lesson_id: 'lesson' as NonNullable<Flashcard['lesson_id']>, course_id: 'course' as NonNullable<Flashcard['course_id']>, deck_id: 'deck' as Flashcard['deck_id'] };
  const learned = { ...card('learned'), ...location };
  const unlearned = { ...card('unlearned', { activated: false }), ...location };
  const future = { ...card('future', { fsrs_state: { due_at: '2026-09-07T00:00:00Z' } as Flashcard['fsrs_state'] }), ...location };
  for (const scope of [{}, { courseId: 'course' }, { lessonId: 'lesson' }, { deckId: 'deck' }]) {
    assert.deepEqual(scopeDueReviewCards([future, unlearned, learned], now, scope), [learned]);
  }
  assert.deepEqual(scopeDueReviewCards([learned], now, { courseId: 'different' }), []);
  const sharedDeckOtherCourse = { ...card('other'), deck_id: 'deck' as Flashcard['deck_id'], course_id: 'other-course' as NonNullable<Flashcard['course_id']> };
  assert.deepEqual(
    scopeDueReviewCards([learned, sharedDeckOtherCourse], now, { courseId: 'course', deckId: 'deck' }),
    [learned],
    'course scope owns the queue even when a stale/single-deck hint is also present'
  );
});

test('only genuinely independent cards expose manual enrollment', async () => {
  const { isIndependentCard } = await import('./cardEligibility');
  assert.equal(isIndependentCard({ ...card('independent'), concept_id: null, lesson_id: null }), true);
  assert.equal(isIndependentCard({ ...card('resolved'), concept_id: null, lesson_id: 'lesson' as NonNullable<Flashcard['lesson_id']> }), false);
  assert.equal(isIndependentCard({ ...card('legacy'), concept_id: 'concept' as Flashcard['concept_id'] }), false);
  assert.equal(isIndependentCard({ ...card('broken'), concept_id: 'missing' as Flashcard['concept_id'], lesson_id: null }), false);
  assert.equal(isIndependentCard({ ...card('ambiguous'), concept_id: null, lesson_id: null, source_status: 'unresolved' }), false);
  assert.equal(isIndependentCard({ ...card('explicit'), concept_id: null, lesson_id: null, source_status: 'independent' }), true);
});
