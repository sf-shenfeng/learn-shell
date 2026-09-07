import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectFlashcards } from './flashcard-projection';
import { isFlashcardInReviewQueue } from './flashcard-activation';
const sources = [
  { id: 'c1', lesson_id: 'l1', course_id: 'course', flashcard_ids: ['reverse', 'conflict'] },
  { id: 'c2', lesson_id: 'l2', course_id: 'course', flashcard_ids: ['conflict'] },
];
const card = (id: string, concept_id: string | null, activated = true) => ({ id, concept_id, activated,
  paused: false, fsrs_state: { due_at: '2026-01-01', review_count: 7, stability: 3 } });

test('canonical source ignores lesson.concept_ids; exact unique reverse resolves; ambiguity closes gate', () => {
  const result = projectFlashcards([card('forward', 'c1'), card('reverse', null), card('conflict', null),
    card('broken', 'missing'), card('independent', null)], sources, new Set(['l1']));
  assert.deepEqual(result.map((r) => [r.concept_id, r.lesson_id, r.activated, r.source_status]), [
    ['c1', 'l1', true, 'course'], ['c1', 'l1', true, 'course'],
    [null, null, false, 'unresolved'], ['missing', null, false, 'unresolved'],
    [null, null, true, 'independent'],
  ]);
});
test('completion controls previously reviewed/old manual activation and late-added cards; preserves state', () => {
  const pending = card('pending', 'c2');
  const late = { ...card('late', 'c1', false), paused: true };
  const result = projectFlashcards([pending, late], sources, new Set(['l1']));
  assert.equal(result[0]!.activated, false);
  assert.equal(result[1]!.activated, true);
  assert.equal(result[1]!.fsrs_state, late.fsrs_state);
  assert.equal(result[1]!.paused, true);
  assert.equal(isFlashcardInReviewQueue(result[1]!, Date.now()), false);
});
test('forward wins over conflicting reverse; explicit independent opt-out persists', () => {
  const result = projectFlashcards([card('conflict', 'c1'), card('free', null, false)], sources, new Set(['l1']));
  assert.equal(result[0]!.lesson_id, 'l1');
  assert.equal(result[1]!.activated, false);
});
