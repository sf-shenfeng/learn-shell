// Unit tests for the syllabus coverage/decay calc (syllabus-coverage.ts).
// No DB / server needed — pure functions, node:test (see flashcard-import.test.ts
// for the same-repo precedent this follows).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSyllabusTree,
  computeOwnState,
  overallCoveragePct,
  flattenTree,
  type CoverageContext,
  type SyllabusMappingInput,
  type SyllabusNodeInput,
  type SyllabusTreeNode,
} from './syllabus-coverage';

/** `tree[0]` typed with noUncheckedIndexedAccess is `SyllabusTreeNode |
 *  undefined` — every test below wants the root and knows there is one;
 *  this narrows it in one place instead of a non-null assertion at each
 *  call site. */
function first(tree: SyllabusTreeNode[]): SyllabusTreeNode {
  const node = tree[0];
  assert.ok(node, 'expected buildSyllabusTree to return at least one root node');
  return node;
}

function ctx(overrides: Partial<CoverageContext> = {}): CoverageContext {
  return {
    testedQuizQuestionIds: new Set(),
    flashcardRetrievabilityById: new Map(),
    flashcardLastReviewById: new Map(),
    quizQuestionLastAnsweredById: new Map(),
    ...overrides,
  };
}

function node(partial: Partial<SyllabusNodeInput> & { id: string }): SyllabusNodeInput {
  return {
    parent_id: null,
    code: partial.id,
    title: partial.id,
    description: null,
    syllabus_version: 'v1',
    exam_weight: null,
    sort_order: 0,
    ...partial,
  };
}

function mapping(partial: Partial<SyllabusMappingInput> & { node_id: string }): SyllabusMappingInput {
  return {
    id: `${partial.node_id}-map-${Math.random()}`,
    asset_type: 'lesson',
    asset_id: 'asset-1',
    mapped_by: 'agent',
    created_at: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

// ---- computeOwnState: coverage ladder ----

test('coverage: zero mappings = untouched', () => {
  const state = computeOwnState([], ctx());
  assert.equal(state.coverage, 'untouched');
  assert.equal(state.decay, null);
  assert.equal(state.last_touched, null);
});

test('coverage: lesson mapping alone = taught', () => {
  const state = computeOwnState([mapping({ node_id: 'n1', asset_type: 'lesson' })], ctx());
  assert.equal(state.coverage, 'taught');
});

test('coverage: flashcard-only mapping resolves to taught (brief gap)', () => {
  const state = computeOwnState(
    [mapping({ node_id: 'n1', asset_type: 'flashcard', asset_id: 'fc-1' })],
    ctx()
  );
  assert.equal(state.coverage, 'taught');
});

test('coverage: quiz mapping without an answered attempt is taught, not tested', () => {
  const state = computeOwnState(
    [mapping({ node_id: 'n1', asset_type: 'quiz_question', asset_id: 'q-1' })],
    ctx({ testedQuizQuestionIds: new Set() })
  );
  assert.equal(state.coverage, 'taught');
});

test('coverage: quiz mapping WITH an answered attempt = tested', () => {
  const state = computeOwnState(
    [mapping({ node_id: 'n1', asset_type: 'quiz_question', asset_id: 'q-1' })],
    ctx({ testedQuizQuestionIds: new Set(['q-1']) })
  );
  assert.equal(state.coverage, 'tested');
});

// ---- decay bands ----

test('decay: no mapped flashcards = null (not cold)', () => {
  const state = computeOwnState([mapping({ node_id: 'n1', asset_type: 'lesson' })], ctx());
  assert.equal(state.decay, null);
  assert.equal(state.decay_value, null);
});

test('decay: averages retrievability across mapped flashcards and bands correctly', () => {
  const c = ctx({
    flashcardRetrievabilityById: new Map([
      ['fc-1', 0.95],
      ['fc-2', 0.85],
    ]),
  });
  const state = computeOwnState(
    [
      mapping({ node_id: 'n1', asset_type: 'flashcard', asset_id: 'fc-1' }),
      mapping({ node_id: 'n1', asset_type: 'flashcard', asset_id: 'fc-2' }),
    ],
    c
  );
  assert.ok(Math.abs((state.decay_value ?? 0) - 0.9) < 1e-9);
  assert.equal(state.decay, 'fresh');
});

test('decay bands: fading [0.5, 0.8) and cold < 0.5', () => {
  const fading = computeOwnState(
    [mapping({ node_id: 'n1', asset_type: 'flashcard', asset_id: 'fc-1' })],
    ctx({ flashcardRetrievabilityById: new Map([['fc-1', 0.6]]) })
  );
  assert.equal(fading.decay, 'fading');

  const cold = computeOwnState(
    [mapping({ node_id: 'n1', asset_type: 'flashcard', asset_id: 'fc-1' })],
    ctx({ flashcardRetrievabilityById: new Map([['fc-1', 0.2]]) })
  );
  assert.equal(cold.decay, 'cold');

  const boundaryFresh = computeOwnState(
    [mapping({ node_id: 'n1', asset_type: 'flashcard', asset_id: 'fc-1' })],
    ctx({ flashcardRetrievabilityById: new Map([['fc-1', 0.8]]) })
  );
  assert.equal(boundaryFresh.decay, 'fresh');
});

// ---- last_touched ----

test('last_touched: takes the max of mapping.created_at and flashcard last_review_at', () => {
  const c = ctx({
    flashcardLastReviewById: new Map([['fc-1', '2026-05-01T00:00:00.000Z']]),
  });
  const state = computeOwnState(
    [
      mapping({
        node_id: 'n1',
        asset_type: 'flashcard',
        asset_id: 'fc-1',
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    ],
    c
  );
  assert.equal(state.last_touched, '2026-05-01T00:00:00.000Z');
});

test('last_touched: quiz mapping picks up latest answered timestamp', () => {
  const c = ctx({
    quizQuestionLastAnsweredById: new Map([['q-1', '2026-06-01T00:00:00.000Z']]),
  });
  const state = computeOwnState(
    [
      mapping({
        node_id: 'n1',
        asset_type: 'quiz_question',
        asset_id: 'q-1',
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    ],
    c
  );
  assert.equal(state.last_touched, '2026-06-01T00:00:00.000Z');
});

// ---- tree aggregation ----

test('leaf node: coverage_pct mirrors own coverage score', () => {
  const nodes = [node({ id: 'root' })];
  const mappings = [mapping({ node_id: 'root', asset_type: 'lesson' })];
  const root = first(buildSyllabusTree(nodes, mappings, ctx()));
  assert.equal(root.coverage, 'taught');
  assert.equal(root.coverage_pct, 50);
  assert.equal(root.children.length, 0);
});

test('parent rollup: equal-weight average of children when parent has no own mappings', () => {
  const nodes = [
    node({ id: 'parent' }),
    node({ id: 'child-a', parent_id: 'parent' }),
    node({ id: 'child-b', parent_id: 'parent' }),
  ];
  const mappings = [
    mapping({ node_id: 'child-a', asset_type: 'quiz_question', asset_id: 'q-a' }),
    mapping({ node_id: 'child-b', asset_type: 'lesson' }), // taught only
  ];
  const parent = first(buildSyllabusTree(nodes, mappings, ctx({ testedQuizQuestionIds: new Set(['q-a']) })));
  // child-a tested (100%), child-b taught (50%) → equal weight average 75%.
  assert.equal(parent.coverage_pct, 75);
  assert.equal(parent.coverage, 'untouched'); // own state unaffected by rollup
});

test('parent rollup: exam_weight tilts the average', () => {
  const nodes = [
    node({ id: 'parent' }),
    node({ id: 'heavy', parent_id: 'parent', exam_weight: 3 }),
    node({ id: 'light', parent_id: 'parent', exam_weight: 1 }),
  ];
  const mappings = [
    mapping({ node_id: 'heavy', asset_type: 'quiz_question', asset_id: 'q-heavy' }),
    // 'light' stays untouched (0%).
  ];
  const parent = first(
    buildSyllabusTree(nodes, mappings, ctx({ testedQuizQuestionIds: new Set(['q-heavy']) }))
  );
  // (100*3 + 0*1) / 4 = 75%.
  assert.equal(parent.coverage_pct, 75);
});

test('parent rollup: parent with its own direct mapping blends with children (resolution)', () => {
  const nodes = [node({ id: 'parent' }), node({ id: 'child', parent_id: 'parent' })];
  const mappings = [
    mapping({ node_id: 'parent', asset_type: 'quiz_question', asset_id: 'q-p' }), // tested = 100
    // child untouched = 0
  ];
  const parent = first(buildSyllabusTree(nodes, mappings, ctx({ testedQuizQuestionIds: new Set(['q-p']) })));
  // (own 100 * weight 1 + child 0 * weight 1) / 2 = 50.
  assert.equal(parent.coverage_pct, 50);
  assert.equal(parent.coverage, 'tested'); // own ladder state still reported straight
});

test('decay rollup: null when no flashcards anywhere in subtree', () => {
  const nodes = [node({ id: 'parent' }), node({ id: 'child', parent_id: 'parent' })];
  const mappings = [mapping({ node_id: 'child', asset_type: 'lesson' })];
  const parent = first(buildSyllabusTree(nodes, mappings, ctx()));
  assert.equal(parent.decay_value_rollup, null);
  assert.equal(parent.decay_rollup, null);
});

test('decay rollup: weighted average across descendants with flashcards, ignoring null branches', () => {
  const nodes = [
    node({ id: 'parent' }),
    node({ id: 'a', parent_id: 'parent' }),
    node({ id: 'b', parent_id: 'parent' }), // no flashcards, contributes null (excluded, not 0)
  ];
  const mappings = [mapping({ node_id: 'a', asset_type: 'flashcard', asset_id: 'fc-1' })];
  const parent = first(
    buildSyllabusTree(nodes, mappings, ctx({ flashcardRetrievabilityById: new Map([['fc-1', 0.9]]) }))
  );
  assert.equal(parent.decay_value_rollup, 0.9);
  assert.equal(parent.decay_rollup, 'fresh');
});

test('last_touched_rollup: bubbles up the max across the whole subtree', () => {
  const nodes = [
    node({ id: 'parent' }),
    node({ id: 'a', parent_id: 'parent' }),
    node({ id: 'b', parent_id: 'parent' }),
  ];
  const mappings = [
    mapping({ node_id: 'a', asset_type: 'lesson', created_at: '2026-01-01T00:00:00.000Z' }),
    mapping({ node_id: 'b', asset_type: 'lesson', created_at: '2026-06-01T00:00:00.000Z' }),
  ];
  const parent = first(buildSyllabusTree(nodes, mappings, ctx()));
  assert.equal(parent.last_touched_rollup, '2026-06-01T00:00:00.000Z');
});

test('overallCoveragePct: weighted rollup across top-level roots', () => {
  const nodes = [node({ id: 'a', exam_weight: 1 }), node({ id: 'b', exam_weight: 1 })];
  const mappings = [mapping({ node_id: 'a', asset_type: 'quiz_question', asset_id: 'q-a' })];
  const tree = buildSyllabusTree(nodes, mappings, ctx({ testedQuizQuestionIds: new Set(['q-a']) }));
  assert.equal(overallCoveragePct(tree), 50); // (100 + 0) / 2
});

test('overallCoveragePct: empty tree = 0, not NaN/null', () => {
  assert.equal(overallCoveragePct([]), 0);
});

test('flattenTree: pre-order flat list includes every node exactly once', () => {
  const nodes = [
    node({ id: 'root' }),
    node({ id: 'child-a', parent_id: 'root' }),
    node({ id: 'child-b', parent_id: 'root' }),
    node({ id: 'grandchild', parent_id: 'child-a' }),
  ];
  const tree = buildSyllabusTree(nodes, [], ctx());
  const flat = flattenTree(tree);
  assert.deepEqual(
    flat.map((n) => n.id).sort(),
    ['child-a', 'child-b', 'grandchild', 'root'].sort()
  );
});
