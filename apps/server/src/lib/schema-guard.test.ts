// Schema-by-need suite (W3, red team P1) — schema-guard.ts pure-function
// tests. No DB (same constraint as tool-args.test.ts / currentContract.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levenshtein, nearestFieldNames, findUnknownField } from './schema-guard';

// ---------------------------------------------------------------------------
// levenshtein / nearestFieldNames
// ---------------------------------------------------------------------------

test('levenshtein: identical strings are distance 0', () => {
  assert.equal(levenshtein('lesson_id', 'lesson_id'), 0);
});

test('levenshtein: empty-string edge cases', () => {
  assert.equal(levenshtein('', ''), 0);
  assert.equal(levenshtein('abc', ''), 3);
  assert.equal(levenshtein('', 'abc'), 3);
});

test('levenshtein: one substitution/typo', () => {
  assert.equal(levenshtein('lesso_id', 'lesson_id'), 1);
});

test('nearestFieldNames: ranks closest first, breaks ties alphabetically', () => {
  const known = ['lesson_id', 'live_session_id', 'contract_id', 'course_id'];
  const top = nearestFieldNames('lesson_i', known, 2);
  assert.equal(top[0], 'lesson_id');
  assert.equal(top.length, 2);
});

test('nearestFieldNames: respects the limit', () => {
  const known = ['a', 'b', 'c', 'd', 'e'];
  assert.equal(nearestFieldNames('z', known, 3).length, 3);
});

// ---------------------------------------------------------------------------
// findUnknownField
// ---------------------------------------------------------------------------

const SIMPLE_SCHEMA = {
  type: 'object',
  properties: {
    lesson_id: { type: 'string' },
    order: { type: 'number' },
  },
} as const;

test('findUnknownField: all-known keys -> null', () => {
  assert.equal(findUnknownField(SIMPLE_SCHEMA, { lesson_id: 'l1', order: 1 }, 'add_exercise'), null);
});

test('findUnknownField: unknown top-level key -> structured violation with candidates', () => {
  const v = findUnknownField(SIMPLE_SCHEMA, { lesson_id: 'l1', ordr: 1 }, 'add_exercise');
  assert.ok(v);
  assert.equal(v!.field_path, 'ordr');
  assert.equal(v!.received, 1);
  assert.equal(v!.expected, 'not a recognized field');
  assert.ok(v!.candidates.includes('order'));
  assert.match(v!.next_required_action, /schema add_exercise/);
});

test('findUnknownField: schema without `properties` is left unchecked (free-form blob)', () => {
  assert.equal(findUnknownField({ type: 'object' }, { anything: 1, goes: 2 }, 'live_message_send'), null);
});

test('findUnknownField: undefined schema is left unchecked', () => {
  assert.equal(findUnknownField(undefined, { anything: 1 }, 'unknown_tool'), null);
});

test('findUnknownField: non-object value is left unchecked (required-ness is a separate concern)', () => {
  assert.equal(findUnknownField(SIMPLE_SCHEMA, 'not-an-object', 'add_exercise'), null);
  assert.equal(findUnknownField(SIMPLE_SCHEMA, null, 'add_exercise'), null);
  assert.equal(findUnknownField(SIMPLE_SCHEMA, ['array'], 'add_exercise'), null);
});

test('findUnknownField: recurses into a nested object sub-schema that declares properties', () => {
  const schema = {
    type: 'object',
    properties: {
      contract_id: { type: 'string' },
      cadence: {
        type: 'object',
        properties: {
          mode: { type: 'string' },
          reminders: { type: 'string' },
        },
      },
    },
  } as const;
  const v = findUnknownField(
    schema,
    { contract_id: 'tc_1', cadence: { mode: 'scheduled', reminder: 'native' } },
    'update_contract_cadence'
  );
  assert.ok(v);
  assert.equal(v!.field_path, 'cadence.reminder');
  assert.ok(v!.candidates.includes('reminders'));
});

test('findUnknownField: does NOT recurse into a nested object sub-schema with no declared properties', () => {
  const schema = {
    type: 'object',
    properties: {
      payload: { type: 'object' },
    },
  } as const;
  assert.equal(findUnknownField(schema, { payload: { anything: 1 } }, 'live_message_send'), null);
});

test('findUnknownField: recurses into array-of-object items that declare properties', () => {
  const schema = {
    type: 'object',
    properties: {
      receipt: {
        type: 'array',
        items: {
          type: 'object',
          properties: { kind: { type: 'string' }, description: { type: 'string' } },
        },
      },
    },
  } as const;
  const v = findUnknownField(
    schema,
    { receipt: [{ kind: 'teacher_note', description: 'ok' }, { kind: 'erratum', desc: 'typo' }] },
    'close_lesson_loop'
  );
  assert.ok(v);
  assert.equal(v!.field_path, 'receipt[1].desc');
  assert.ok(v!.candidates.includes('description'));
});

test('findUnknownField: fails fast on the first violation found (top-level before nested)', () => {
  const schema = {
    type: 'object',
    properties: {
      cadence: { type: 'object', properties: { mode: { type: 'string' } } },
    },
  } as const;
  const v = findUnknownField(schema, { cadenc: { mode: 'scheduled' } }, 'update_contract_cadence');
  assert.ok(v);
  assert.equal(v!.field_path, 'cadenc');
});
