// Unit tests for source-material.ts (迁移 0040) — 纯函数, 无 DB。
// Run via `pnpm --filter @learn-shell/server test`
// (tsx --test / node:assert, zero deps, same harness as content-hash.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSourceMaterialLine,
  validateSourceMaterialArg,
  type ContractSourceMaterial,
} from './source-material';

// ---- validateSourceMaterialArg ----

test('validate: absent → undefined (可选参数, 未谈教材就不写)', () => {
  assert.equal(validateSourceMaterialArg({}, 'source_material'), undefined);
  assert.equal(validateSourceMaterialArg({ source_material: null }, 'source_material'), undefined);
});

test('validate: minimal valid shape (title + reliance) round-trips', () => {
  const out = validateSourceMaterialArg(
    { source_material: { title: 'Options, Futures, and Other Derivatives', reliance: 'anchored' } },
    'source_material'
  );
  assert.deepEqual(out, {
    title: 'Options, Futures, and Other Derivatives',
    reliance: 'anchored',
  });
});

test('validate: full shape keeps author/year, trims strings', () => {
  const out = validateSourceMaterialArg(
    {
      source_material: {
        title: '  证券分析  ',
        author: ' Benjamin Graham ',
        year: 1934,
        reliance: 'strict',
      },
    },
    'source_material'
  );
  assert.deepEqual(out, {
    title: '证券分析',
    author: 'Benjamin Graham',
    year: 1934,
    reliance: 'strict',
  });
});

test('validate: rejects non-object / array', () => {
  assert.throws(() => validateSourceMaterialArg({ source_material: 'book' }, 'source_material'), /must be an object/);
  assert.throws(() => validateSourceMaterialArg({ source_material: [] }, 'source_material'), /must be an object/);
});

test('validate: rejects missing/empty title', () => {
  assert.throws(
    () => validateSourceMaterialArg({ source_material: { reliance: 'strict' } }, 'source_material'),
    /title is required/
  );
  assert.throws(
    () => validateSourceMaterialArg({ source_material: { title: '  ', reliance: 'strict' } }, 'source_material'),
    /title is required/
  );
});

test('validate: rejects unknown reliance tier, error names all three tiers', () => {
  assert.throws(
    () =>
      validateSourceMaterialArg(
        { source_material: { title: 'X', reliance: 'loose' } },
        'source_material'
      ),
    /strict\/anchored\/inspired/
  );
});

test('validate: rejects bad year (non-integer / out of range)', () => {
  for (const year of ['2024', 2024.5, 42, 9999]) {
    assert.throws(
      () =>
        validateSourceMaterialArg(
          { source_material: { title: 'X', reliance: 'inspired', year } },
          'source_material'
        ),
      /year must be an integer year/
    );
  }
});

test('validate: rejects empty author if present', () => {
  assert.throws(
    () =>
      validateSourceMaterialArg(
        { source_material: { title: 'X', reliance: 'inspired', author: ' ' } },
        'source_material'
      ),
    /author must be a non-empty string/
  );
});

// ---- formatSourceMaterialLine ----

test('format: title + tier, year included when present', () => {
  const sm: ContractSourceMaterial = { title: '固定收益证券', year: 2021, reliance: 'anchored' };
  assert.equal(formatSourceMaterialLine(sm), 'Material: 《固定收益证券》(2021) · anchored(skeleton follows the book)');
});

test('format: year omitted cleanly when absent; author never appears', () => {
  const sm: ContractSourceMaterial = { title: 'Deep Learning', author: 'Goodfellow', reliance: 'inspired' };
  assert.equal(formatSourceMaterialLine(sm), 'Material: 《Deep Learning》 · inspired(book as a starting point)');
});

test('format: strict tier label', () => {
  const sm: ContractSourceMaterial = { title: 'X', reliance: 'strict' };
  assert.equal(formatSourceMaterialLine(sm), 'Material: 《X》 · strict(follow the book)');
});
