// Unit tests for validateSimulatedQuestions (add_simulated_quiz
// 校验器的 multi_choice reference_answer 分隔约定，从逗号改回 ' || '，与判分侧
// (apps/web/src/repository/MockRepository.ts 的 gradeSimulatedAnswer) 同制).
// Pure function, no DB. Run via `pnpm --filter @learn-shell/server test`
// (tsx --test / node:assert, zero deps, same harness as validate-prep-core.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSimulatedQuestions } from './validate-simulated-quiz';

function baseQuestion(overrides: Record<string, unknown>) {
  return {
    stem: 'stub stem',
    question_type: 'multi_choice',
    ...overrides,
  };
}

// ---- regression: comma-containing choice text must not be shredded ----
test('multi_choice: choice text containing a comma survives validation when reference_answer uses \' || \'', () => {
  const questions = validateSimulatedQuestions([
    baseQuestion({
      stem: 'Which are included in GDP?',
      choices: [
        'income included in GDP, as domestic production',
        'foreign income excluded from GDP',
        'transfer payments',
      ],
      reference_answer: 'income included in GDP, as domestic production || foreign income excluded from GDP',
    }),
  ]);
  assert.equal(questions.length, 1);
  assert.equal(
    questions[0]!.reference_answer,
    'income included in GDP, as domestic production || foreign income excluded from GDP'
  );
});

test('multi_choice: single correct choice (no separator needed) still validates', () => {
  const questions = validateSimulatedQuestions([
    baseQuestion({
      choices: ['A', 'B', 'C'],
      reference_answer: 'A',
    }),
  ]);
  assert.equal(questions.length, 1);
});

test('multi_choice: old comma-joined convention is no longer accepted as a set — rejected as not among choices', () => {
  assert.throws(
    () =>
      validateSimulatedQuestions([
        baseQuestion({
          choices: ['A', 'B', 'C'],
          reference_answer: 'A,B', // old comma convention (from before the current format) — not a literal choice
        }),
      ]),
    /not among choices/
  );
});

test('multi_choice: a genuinely wrong choice text is still rejected', () => {
  assert.throws(
    () =>
      validateSimulatedQuestions([
        baseQuestion({
          choices: ['A', 'B', 'C'],
          reference_answer: 'A || Z',
        }),
      ]),
    /not among choices/
  );
});

// ---- single_choice: shares the same split path, must behave as exact match ----
test('single_choice: choice text containing a comma still validates (no split on comma)', () => {
  const questions = validateSimulatedQuestions([
    baseQuestion({
      question_type: 'single_choice',
      stem: 'CFO under indirect method?',
      choices: ['$170,000', '$180,000', '$200,000', '$220,000'],
      reference_answer: '$200,000',
    }),
  ]);
  assert.equal(questions.length, 1);
  assert.equal(questions[0]!.reference_answer, '$200,000');
});

// ---- error message names the ' || ' convention, not comma ----
test('missing reference_answer error text points at the \' || \' convention, not comma', () => {
  assert.throws(
    () =>
      validateSimulatedQuestions([
        baseQuestion({
          choices: ['A', 'B'],
          reference_answer: '',
        }),
      ]),
    /' \|\| '-separated for/
  );
});

// ---- regression (Bench 案二): naive {prompt,options,correct_index} shape still rejected ----
test('naive {prompt,options,correct_index} shape is rejected with a field-swap hint', () => {
  assert.throws(
    () =>
      validateSimulatedQuestions([
        { prompt: 'stub', options: ['A', 'B'], correct_index: 0 },
      ]),
    /missing 'stem'/
  );
});
