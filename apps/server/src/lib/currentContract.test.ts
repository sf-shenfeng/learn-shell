// Unit tests for currentContract.ts (retire
// teaching_contracts.active, pick the current contract off setup_status
// instead).
//
// Criterion under test (corrected 2026-07-10 after real-DB verification —
// pair_demo_cfa carries THREE contracts at established / ready / ready, the
// latter two with legacy active=true dirty data, so an 'established'-only
// filter would have missed the fully-provisioned ones): "current" = signed
// and non-terminal, setup_status ∈ {established, outlining, outline_ready,
// in_progress, generating, ready}; excluded proposed / draft (pre-signature)
// and failed / cancelled (terminal); most-recently-`updated_at` wins among
// several eligible.
//
// No live Postgres is reachable in this sandbox (no docker/psql), so this
// exercises the pure `pickCurrentContract`/`pickCurrentContracts` selection
// logic directly against in-memory rows shaped like real teaching_contracts
// rows (field set mirrors apps/server/src/db/seed.ts's pair_demo_cfa contract
// — the real signed CFA contract referenced in the design brief). This is
// also the exact logic getCurrentContract()/listCurrentContracts() delegate
// to after fetching a pair's rows, so proving the selection here proves the
// DB-facing helpers correct without needing a database.
//
// Final section proves the "_stack semantics actually switched over" claim
// end-to-end at the pure-function level: feed the contract picked by
// pickCurrentContract into lib/skillStack.ts's pickSkillStack (the same
// facet-selection logic mcp/server.ts's `_stack` GetPrompt handler composes
// from) and check it returns a real, non-empty stack — i.e. the thing that
// used to always come back "No active contract" now resolves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickCurrentContract,
  pickCurrentContracts,
  CURRENT_CONTRACT_STATUSES,
} from './currentContract';
import { pickSkillStack } from './skillStack';
import type { PreferredTimeOfDay } from '@learn-shell/contracts';

// Minimal shape covering just what pickCurrentContract touches, plus the
// facet fields pickSkillStack needs downstream — real rows carry many more
// columns (see db/schema/pair.ts) but those are irrelevant to selection.
interface FakeContractRow {
  id: string;
  setup_status: string;
  updated_at: Date;
  goal: string;
  intensity: 'relaxed' | 'standard' | 'hardcore';
  content_modality: 'text' | 'visual' | 'mixed';
  preferred_time_of_day?: PreferredTimeOfDay[] | null;
}

// Modeled on seed.ts's tc_demo_cfa_v1 (the real signed pair_demo_cfa
// contract) — goal/intensity/content_modality/preferred_time_of_day copied
// verbatim.
const CFA_ESTABLISHED: FakeContractRow = {
  id: 'tc_demo_cfa_established',
  setup_status: 'established',
  updated_at: new Date('2026-06-25T08:32:34.000Z'),
  goal: 'Pass CFA Level 1 in February 2027',
  intensity: 'standard',
  content_modality: 'mixed',
  preferred_time_of_day: ['evening'],
};

test('criterion set: signed non-terminal statuses only', () => {
  assert.deepEqual(
    [...CURRENT_CONTRACT_STATUSES].sort(),
    ['established', 'generating', 'in_progress', 'outline_ready', 'outlining', 'ready'].sort()
  );
});

test('pickCurrentContract: picks the established contract over pre-signature siblings', () => {
  const proposedSibling: FakeContractRow = {
    ...CFA_ESTABLISHED,
    id: 'tc_other_proposed',
    setup_status: 'proposed',
    updated_at: new Date('2026-07-01T00:00:00.000Z'), // newer, but pre-signature
  };
  const draftSibling: FakeContractRow = {
    ...CFA_ESTABLISHED,
    id: 'tc_other_draft',
    setup_status: 'draft',
    updated_at: new Date('2026-07-02T00:00:00.000Z'), // even newer, still pre-signature
  };
  const picked = pickCurrentContract([proposedSibling, CFA_ESTABLISHED, draftSibling]);
  assert.equal(picked?.id, 'tc_demo_cfa_established');
});

test('pickCurrentContract: a ready contract IS current-eligible (real-DB correction)', () => {
  // The real dogfood DB's fully-provisioned contracts sit at 'ready' —
  // the original 'established'-only criterion would have missed them.
  const ready: FakeContractRow = {
    ...CFA_ESTABLISHED,
    id: 'tc_ready',
    setup_status: 'ready',
  };
  const picked = pickCurrentContract([ready]);
  assert.equal(picked?.id, 'tc_ready');
});

test('pickCurrentContract: established + ready coexisting -> most-recently-updated wins', () => {
  // Mirrors the actual pair_demo_cfa shape: established / ready / ready.
  const established: FakeContractRow = {
    ...CFA_ESTABLISHED,
    id: 'tc_established_newest',
    setup_status: 'established',
    updated_at: new Date('2026-07-09T00:00:00.000Z'),
  };
  const readyOld: FakeContractRow = {
    ...CFA_ESTABLISHED,
    id: 'tc_ready_old',
    setup_status: 'ready',
    updated_at: new Date('2026-06-25T08:32:34.000Z'),
  };
  const readyOlder: FakeContractRow = {
    ...CFA_ESTABLISHED,
    id: 'tc_ready_older',
    setup_status: 'ready',
    updated_at: new Date('2026-06-01T00:00:00.000Z'),
  };
  // Newest eligible is the established one here…
  assert.equal(
    pickCurrentContract([readyOld, established, readyOlder])?.id,
    'tc_established_newest'
  );

  // …and if a ready one is the freshest instead, it wins — status carries no
  // priority over recency within the eligible set.
  const readyNewest: FakeContractRow = {
    ...readyOld,
    id: 'tc_ready_newest',
    updated_at: new Date('2026-07-10T00:00:00.000Z'),
  };
  assert.equal(
    pickCurrentContract([readyOld, established, readyNewest])?.id,
    'tc_ready_newest'
  );
});

test('pickCurrentContract: returns null when nothing signed/non-terminal exists', () => {
  const rows: FakeContractRow[] = [
    { ...CFA_ESTABLISHED, id: 'tc_a', setup_status: 'draft' },
    { ...CFA_ESTABLISHED, id: 'tc_b', setup_status: 'proposed' },
    { ...CFA_ESTABLISHED, id: 'tc_c', setup_status: 'cancelled' },
    { ...CFA_ESTABLISHED, id: 'tc_d', setup_status: 'failed' },
  ];
  assert.equal(pickCurrentContract(rows), null);
});

test('pickCurrentContract: mid-pipeline statuses (outlining/outline_ready/in_progress/generating) are eligible', () => {
  for (const status of ['outlining', 'outline_ready', 'in_progress', 'generating']) {
    const picked = pickCurrentContract([
      { ...CFA_ESTABLISHED, id: `tc_${status}`, setup_status: status },
    ]);
    assert.equal(picked?.id, `tc_${status}`, `expected '${status}' to be eligible`);
  }
});

test('pickCurrentContracts: returns every eligible contract, newest first, excludes pre-signature/terminal', () => {
  const olderEstablished: FakeContractRow = {
    ...CFA_ESTABLISHED,
    id: 'tc_older_established',
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };
  const newerReady: FakeContractRow = {
    ...CFA_ESTABLISHED,
    id: 'tc_newer_ready',
    setup_status: 'ready',
    updated_at: new Date('2026-07-01T00:00:00.000Z'),
  };
  const cancelled: FakeContractRow = {
    ...CFA_ESTABLISHED,
    id: 'tc_cancelled',
    setup_status: 'cancelled',
    updated_at: new Date('2026-07-05T00:00:00.000Z'),
  };
  const proposed: FakeContractRow = {
    ...CFA_ESTABLISHED,
    id: 'tc_proposed',
    setup_status: 'proposed',
    updated_at: new Date('2026-07-06T00:00:00.000Z'),
  };
  const picked = pickCurrentContracts([olderEstablished, cancelled, newerReady, proposed]);
  assert.deepEqual(
    picked.map((r) => r.id),
    ['tc_newer_ready', 'tc_older_established']
  );
});

// -------------------------------------------------------------------------
// End-to-end (pure): current-contract selection feeding pickSkillStack —
// proves `_stack` actually resolves a real stack once a signed contract
// exists, instead of the pre-fix "No active contract" placeholder.
// -------------------------------------------------------------------------
test('_stack semantics: a signed CFA contract resolves to a non-empty skill stack', () => {
  const rows: FakeContractRow[] = [
    {
      ...CFA_ESTABLISHED,
      id: 'tc_stale_draft',
      setup_status: 'draft',
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    },
    CFA_ESTABLISHED,
  ];
  const current = pickCurrentContract(rows);
  assert.ok(current, 'expected a signed contract to be picked (this used to always be null)');

  const stack = pickSkillStack({
    goal: current!.goal,
    intensity: current!.intensity,
    content_modality: current!.content_modality,
    preferred_time_of_day: current!.preferred_time_of_day,
  });

  assert.ok(stack.length > 0, 'expected a non-empty skill stack, not the old "No active contract" fallback');
  assert.deepEqual(
    stack.map((s) => `${s.category}/${s.name}`),
    [
      'workflow/lesson-prep',
      'domain/teach-cfa', // goal contains "CFA"
      'intensity/standard',
      'pace/evening-deep', // preferred_time_of_day: ['evening']
      'verify/content-verify',
    ]
  );
});

test('_stack semantics: no signed contract -> caller sees null (unchanged fallback contract)', () => {
  const rows: FakeContractRow[] = [
    { ...CFA_ESTABLISHED, id: 'tc_proposed', setup_status: 'proposed' },
    { ...CFA_ESTABLISHED, id: 'tc_failed', setup_status: 'failed' },
  ];
  assert.equal(pickCurrentContract(rows), null);
});
