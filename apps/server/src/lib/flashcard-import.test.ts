// Unit tests for the flashcard Markdown import parser (flashcard-import.ts).
//
// No test runner was wired up anywhere in this repo yet (no vitest/jest dep,
// no *.test.ts precedent) — this uses Node's built-in test runner
// (node:test / node:assert), which needs zero new dependencies. Run via
// `pnpm --filter @learn-shell/server test` (see package.json's new "test"
// script: `tsx --test src/**/*.test.ts`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlashcardMarkdown, normalizeCardFace } from './flashcard-import';

test('single card, single deck', () => {
  const { cards, errors } = parseFlashcardMarkdown(
    ['#deck 固收', 'Q: What does duration measure?', 'A: Price sensitivity to yield changes.'].join('\n')
  );
  assert.equal(errors.length, 0);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], {
    deck: '固收',
    front: 'What does duration measure?',
    back: 'Price sensitivity to yield changes.',
    line: 2,
  });
});

test('multi-line answer (and multi-line question) captured until next marker', () => {
  const src = [
    '#deck 固收',
    'Q: What does duration measure?',
    'A: Price sensitivity to yield changes.',
    'Second line of the answer.',
    '',
    'Third paragraph after a blank line.',
    'Q: Next question',
    'A: Next answer',
  ].join('\n');
  const { cards, errors } = parseFlashcardMarkdown(src);
  assert.equal(errors.length, 0);
  assert.equal(cards.length, 2);
  assert.equal(
    cards[0]!.back,
    'Price sensitivity to yield changes.\nSecond line of the answer.\n\nThird paragraph after a blank line.'
  );
  assert.equal(cards[1]!.front, 'Next question');
  assert.equal(cards[1]!.back, 'Next answer');
});

test('multi-line question captured until A:', () => {
  const src = [
    '#deck 固收',
    'Q: What does duration measure,',
    'exactly, in terms of price sensitivity?',
    'A: It measures percentage price change per 100bp yield move.',
  ].join('\n');
  const { cards, errors } = parseFlashcardMarkdown(src);
  assert.equal(errors.length, 0);
  assert.equal(cards.length, 1);
  assert.equal(
    cards[0]!.front,
    'What does duration measure,\nexactly, in terms of price sensitivity?'
  );
});

test('CRLF line endings + trailing whitespace tolerated', () => {
  const src = ['#deck 固收  ', 'Q: Q1\t', 'A: A1  '].join('\r\n');
  const { cards, errors } = parseFlashcardMarkdown(src);
  assert.equal(errors.length, 0);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], { deck: '固收', front: 'Q1', back: 'A1', line: 2 });
});

test('multiple decks in one file, cards attributed to the right section', () => {
  const src = [
    '#deck 固收',
    'Q: Fixed income Q1',
    'A: Fixed income A1',
    '',
    '#deck 权益',
    'Q: Equity Q1',
    'A: Equity A1',
  ].join('\n');
  const { cards, errors } = parseFlashcardMarkdown(src);
  assert.equal(errors.length, 0);
  assert.equal(cards.length, 2);
  assert.equal(cards[0]!.deck, '固收');
  assert.equal(cards[1]!.deck, '权益');
});

test('orphan Q/A before any #deck reports an error and drops the card', () => {
  const src = ['Q: orphan question', 'A: orphan answer', '#deck 固收', 'Q: real Q', 'A: real A'].join('\n');
  const { cards, errors } = parseFlashcardMarkdown(src);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.front, 'real Q');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.line, 1);
  assert.match(errors[0]!.message, /orphan/i);
});

test('Q with no A reports an error with the Q line number, does not crash the rest of the file', () => {
  const src = [
    '#deck 固收',
    'Q: unanswered question',
    'still no answer here',
    'Q: answered question',
    'A: answered',
  ].join('\n');
  const { cards, errors } = parseFlashcardMarkdown(src);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.front, 'answered question');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.line, 2);
  assert.match(errors[0]!.message, /no matching A/i);
});

test('Q with no A at end of file (EOF) still reports the error', () => {
  const src = ['#deck 固收', 'Q: dangling question with no answer at all'].join('\n');
  const { cards, errors } = parseFlashcardMarkdown(src);
  assert.equal(cards.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.line, 2);
});

test('duplicate card faces within the same file are both returned by the parser (no silent merge)', () => {
  const src = [
    '#deck 固收',
    'Q: What does duration measure?',
    'A: First answer.',
    'Q: What does duration measure?',
    'A: Second, different answer.',
  ].join('\n');
  const { cards, errors } = parseFlashcardMarkdown(src);
  assert.equal(errors.length, 0);
  assert.equal(cards.length, 2);
  assert.equal(normalizeCardFace(cards[0]!.front), normalizeCardFace(cards[1]!.front));
  assert.notEqual(cards[0]!.back, cards[1]!.back);
});

test('empty file parses to no cards and no errors', () => {
  const { cards, errors } = parseFlashcardMarkdown('');
  assert.equal(cards.length, 0);
  assert.equal(errors.length, 0);
});

test('whitespace-only file parses to no cards and no errors', () => {
  const { cards, errors } = parseFlashcardMarkdown('\n\n   \n\t\n');
  assert.equal(cards.length, 0);
  assert.equal(errors.length, 0);
});

test('a bare "#deck" line with no name does not open a section — subsequent Q/A stay orphaned', () => {
  const src = ['#deck', 'Q: q1', 'A: a1', '#deck 固收', 'Q: q2', 'A: a2'].join('\n');
  const { cards, errors } = parseFlashcardMarkdown(src);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.deck, '固收');
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /orphan/i);
});

test('normalizeCardFace trims and collapses internal whitespace', () => {
  assert.equal(normalizeCardFace('  What does   duration\nmeasure?  '), 'What does duration measure?');
});
