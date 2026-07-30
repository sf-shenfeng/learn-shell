// Tests for 假设生命周期纯判定核心 (lib/hypothesis-lifecycle.ts)。
//
// 覆盖三根柱子: ① reinforce 续期证据/主权层级拒绝表 ② 陈旧读取时现算
// (阈值边界) ③ 简报限载选择 (cap 截取 + 判决排除 + 排序 + 计数行)。
// 纯函数, 无 DB。node:test / node:assert, zero new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIEF_HYPOTHESES_CAP,
  HYPOTHESIS_STALE_AFTER_DAYS,
  isHypothesisAction,
  isHypothesisStale,
  planHypothesisAction,
  selectBriefHypotheses,
} from './hypothesis-lifecycle';
import type { LearnerHypothesisRow } from '../db/schema/teacher_growth';

const NOW = new Date('2026-07-23T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

let seq = 0;
function makeRow(overrides: Partial<LearnerHypothesisRow> = {}): LearnerHypothesisRow {
  seq += 1;
  return {
    id: `hyp_test_${seq}`,
    pair_id: 'pair_test',
    domain: 'test-domain',
    observation: '例题先行比定义先行有效',
    evidence_event_ids: ['evt_1'],
    counterevidence_event_ids: [],
    confidence: 0.7,
    status: 'active',
    written_by_agent_id: 'mcp',
    from_session_id: null,
    user_approved: null,
    user_note: null,
    last_verified_at: null,
    last_evidence_at: daysAgo(1),
    allowed_for_teaching: true,
    created_at: daysAgo(30),
    updated_at: daysAgo(1),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ② 陈旧现算
// ---------------------------------------------------------------------------

test('stale: 超过阈值天数读作陈旧, 阈值内不陈旧 (边界不含等号)', () => {
  const justInside = new Date(NOW.getTime() - HYPOTHESIS_STALE_AFTER_DAYS * DAY_MS);
  const justOutside = new Date(NOW.getTime() - HYPOTHESIS_STALE_AFTER_DAYS * DAY_MS - 1);
  assert.equal(isHypothesisStale(justInside, daysAgo(100), NOW), false);
  assert.equal(isHypothesisStale(justOutside, daysAgo(100), NOW), true);
});

test('stale: last_evidence_at 缺席时回落 created_at (迁移回填同一口径)', () => {
  assert.equal(isHypothesisStale(null, daysAgo(2), NOW), false);
  assert.equal(isHypothesisStale(null, daysAgo(HYPOTHESIS_STALE_AFTER_DAYS + 1), NOW), true);
});

// ---------------------------------------------------------------------------
// ① 动作判定
// ---------------------------------------------------------------------------

test('reinforce: last_evidence_at 推到当下, 新证据去重追加进行内证据账', () => {
  const row = makeRow({ evidence_event_ids: ['evt_1', 'evt_2'], last_evidence_at: daysAgo(40) });
  const plan = planHypothesisAction(row, 'reinforce', { evidence_event_ids: ['evt_2', 'evt_3'] }, NOW);
  assert.equal(plan.kind, 'patch');
  if (plan.kind !== 'patch') return;
  assert.equal(plan.patch.last_evidence_at, NOW);
  assert.deepEqual(plan.patch.evidence_event_ids, ['evt_1', 'evt_2', 'evt_3']);
  assert.equal(plan.patch.status, undefined, 'reinforce 不改状态');
});

test('retire: 状态转 expired, last_evidence_at 不动 (退役不是证据)', () => {
  const plan = planHypothesisAction(makeRow(), 'retire', {}, NOW);
  assert.equal(plan.kind, 'patch');
  if (plan.kind !== 'patch') return;
  assert.equal(plan.patch.status, 'expired');
  assert.equal(plan.patch.last_evidence_at, undefined);
  assert.equal(plan.fed, false, '退役永不算喂养');
});

// ---- 空证据不刷时间戳 ----

test('空证据 reinforce 不刷 last_evidence_at, fed=false, 只留 updated_at 痕迹', () => {
  const row = makeRow({ evidence_event_ids: ['evt_1'], last_evidence_at: daysAgo(40) });
  for (const args of [{}, { evidence_event_ids: [] as string[] }]) {
    const plan = planHypothesisAction(row, 'reinforce', args, NOW);
    assert.equal(plan.kind, 'patch');
    if (plan.kind !== 'patch') return;
    assert.equal(plan.fed, false);
    assert.equal(plan.patch.last_evidence_at, undefined, '空证据不续期');
    assert.equal(plan.patch.evidence_event_ids, undefined, '证据账不动');
    assert.equal(plan.patch.updated_at, NOW);
  }
});

test('带证据 reinforce fed=true (真粮食才续期)', () => {
  const plan = planHypothesisAction(makeRow(), 'reinforce', { evidence_event_ids: ['evt_9'] }, NOW);
  assert.equal(plan.kind, 'patch');
  if (plan.kind !== 'patch') return;
  assert.equal(plan.fed, true);
  assert.equal(plan.patch.last_evidence_at, NOW);
});

test('空证据 revise 新行沿用旧行 last_evidence_at (改写文本不是喂养), fed=false', () => {
  const row = makeRow({ status: 'active', last_evidence_at: daysAgo(15) });
  const plan = planHypothesisAction(row, 'revise', { observation: '新文本超越' }, NOW);
  assert.equal(plan.kind, 'supersede');
  if (plan.kind !== 'supersede') return;
  assert.equal(plan.fed, false);
  assert.equal(plan.newRow.last_evidence_at, row.last_evidence_at);
});

test('空证据 revise 且旧行 last_evidence_at 缺席 → 回落 created_at (0041 回填口径)', () => {
  const row = makeRow({ last_evidence_at: null as unknown as Date, created_at: daysAgo(30) });
  const plan = planHypothesisAction(row, 'revise', { observation: '新文本超越' }, NOW);
  assert.equal(plan.kind, 'supersede');
  if (plan.kind !== 'supersede') return;
  assert.equal(plan.newRow.last_evidence_at, row.created_at);
});

test('revise: 旧行 expired 留痕, 新行承接在场状态/domain/证据账, 文本必填', () => {
  const row = makeRow({ status: 'tentative', confidence: 0.6, evidence_event_ids: ['evt_1'] });
  const plan = planHypothesisAction(
    row,
    'revise',
    { observation: '定义先行在这个域反而更稳', evidence_event_ids: ['evt_9'] },
    NOW
  );
  assert.equal(plan.kind, 'supersede');
  if (plan.kind !== 'supersede') return;
  assert.equal(plan.oldPatch.status, 'expired');
  assert.equal(plan.newRow.status, 'tentative', '修订不降级也不越级');
  assert.equal(plan.newRow.domain, row.domain);
  assert.equal(plan.newRow.confidence, 0.6, '缺省沿用旧行置信度');
  assert.deepEqual(plan.newRow.evidence_event_ids, ['evt_1', 'evt_9']);
  assert.equal(plan.newRow.last_evidence_at, NOW);

  const empty = planHypothesisAction(row, 'revise', { observation: '   ' }, NOW);
  assert.equal(empty.kind, 'refused');
});

test('主权层级: rejected/frozen 三动作全拒; confirmed 只许 reinforce; expired 死行不复活', () => {
  for (const status of ['rejected', 'frozen'] as const) {
    for (const action of ['reinforce', 'revise', 'retire'] as const) {
      const plan = planHypothesisAction(makeRow({ status }), action, { observation: 'x' }, NOW);
      assert.equal(plan.kind, 'refused', `${status} 行必须拒绝 ${action}`);
    }
  }
  const confirmed = makeRow({ status: 'confirmed' });
  assert.equal(planHypothesisAction(confirmed, 'reinforce', {}, NOW).kind, 'patch');
  assert.equal(planHypothesisAction(confirmed, 'revise', { observation: 'x' }, NOW).kind, 'refused');
  assert.equal(planHypothesisAction(confirmed, 'retire', {}, NOW).kind, 'refused');
  for (const action of ['reinforce', 'revise', 'retire'] as const) {
    assert.equal(
      planHypothesisAction(makeRow({ status: 'expired' }), action, { observation: 'x' }, NOW).kind,
      'refused'
    );
  }
});

test('isHypothesisAction: 枚举守门', () => {
  assert.equal(isHypothesisAction('reinforce'), true);
  assert.equal(isHypothesisAction('confirm'), false, '学习者判决动词不是老师动作');
});

// ---------------------------------------------------------------------------
// ③ 简报限载选择
// ---------------------------------------------------------------------------

test('简报限载: cap=5 截取, active+confirmed 优先, 组内按 last_evidence_at 降序', () => {
  const rows = [
    makeRow({ id: 'h_tent_fresh', status: 'tentative', last_evidence_at: daysAgo(0) }),
    makeRow({ id: 'h_act_old', status: 'active', last_evidence_at: daysAgo(10) }),
    makeRow({ id: 'h_conf', status: 'confirmed', last_evidence_at: daysAgo(5) }),
    makeRow({ id: 'h_act_fresh', status: 'active', last_evidence_at: daysAgo(1) }),
    makeRow({ id: 'h_tent_old', status: 'tentative', last_evidence_at: daysAgo(50) }),
    makeRow({ id: 'h_act_stale', status: 'active', last_evidence_at: daysAgo(40) }),
  ];
  const sel = selectBriefHypotheses(rows, BRIEF_HYPOTHESES_CAP, NOW);
  assert.equal(sel.inBookCount, 6);
  assert.deepEqual(
    sel.selected.map((s) => s.row.id),
    ['h_act_fresh', 'h_conf', 'h_act_old', 'h_act_stale', 'h_tent_fresh'],
    '在场组 (active/confirmed) 按证据新鲜度降序占满前排, tentative 殿后, 第 6 条被 cap 截掉'
  );
  assert.equal(sel.countLine, '6 on record, brief carries only the 5 most recent with evidence');
  // 陈旧标注随行: 40 天没证据的那条亮 stale, 其余不亮。
  const staleIds = sel.selected.filter((s) => s.stale).map((s) => s.row.id);
  assert.deepEqual(staleIds, ['h_act_stale']);
});

test('简报限载: 学习者判决排除到底 — rejected/frozen 连 redacted 存根都不留, expired 同排', () => {
  const rows = [
    makeRow({ id: 'h_ok', status: 'active' }),
    makeRow({ id: 'h_rej', status: 'rejected' }),
    makeRow({ id: 'h_frz', status: 'frozen', allowed_for_teaching: false }),
    makeRow({ id: 'h_exp', status: 'expired' }),
  ];
  const sel = selectBriefHypotheses(rows, 5, NOW);
  assert.equal(sel.inBookCount, 1);
  assert.deepEqual(
    sel.selected.map((s) => s.row.id),
    ['h_ok']
  );
});

test('简报限载: 在册 0 条时计数行为 null', () => {
  const sel = selectBriefHypotheses([makeRow({ status: 'rejected' })], 5, NOW);
  assert.equal(sel.inBookCount, 0);
  assert.equal(sel.countLine, null);
  assert.deepEqual(sel.selected, []);
});

test('简报限载: last_evidence_at 缺席的行按 created_at 排序 (fixture/迁移前行不崩)', () => {
  const rows = [
    makeRow({ id: 'h_null', status: 'active', last_evidence_at: null as unknown as Date, created_at: daysAgo(3) }),
    makeRow({ id: 'h_dated', status: 'active', last_evidence_at: daysAgo(8) }),
  ];
  const sel = selectBriefHypotheses(rows, 5, NOW);
  assert.deepEqual(
    sel.selected.map((s) => s.row.id),
    ['h_null', 'h_dated']
  );
});
