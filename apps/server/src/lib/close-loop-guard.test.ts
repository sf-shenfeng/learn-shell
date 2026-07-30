// Unit tests for close_lesson_loop 空转防护 — pure decision core.
//
// DB-free: evaluateCloseLoop takes pre-fetched facts, so all four hard checks
// are exercised without a database. Run via
// `pnpm --filter @learn-shell/server test` (node:test / node:assert, zero deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCloseLoop,
  pickCloseLoopNextActions,
  computeLessonClosureState,
  pickLessonClosureNextAction,
  resolveCloseAttempt,
  type CloseLoopFacts,
  type CloseLoopReceiptItem,
  type LessonClosureStateFacts,
} from './close-loop-guard';

const cleanFacts: CloseLoopFacts = {
  ungradedSubmissionIds: [],
  hasPostLessonEvaluation: true, // 认知更新已满足
  refPresence: {},
  liveRefSubstance: {},
  completedLiveSessionIds: [],
  snapshotIdsBySession: {},
  evaluationIdsBySession: {},
  hasCompletedDeclared: true, // 完成权已满足
};

const oneReceipt: CloseLoopReceiptItem[] = [
  { kind: 'journal_entry', description: 'wrote a journal note' },
];

test('happy path: eval present, no ungraded, no refs, no live session → no violations', () => {
  const v = evaluateCloseLoop(oneReceipt, cleanFacts);
  assert.deepEqual(v, []);
});

// ---- ① 未批改提交 ----
test('check ①: ungraded submissions block close, listing their ids', () => {
  const v = evaluateCloseLoop(oneReceipt, {
    ...cleanFacts,
    ungradedSubmissionIds: ['sub_a', 'sub_b'],
  });
  assert.equal(v.length, 1);
  assert.equal(v[0]!.code, 'UNGRADED_SUBMISSIONS');
  assert.deepEqual(v[0]!.details.ungraded_submission_ids, ['sub_a', 'sub_b']);
});

// ---- ② 认知更新 ----
test('check ②: no eval + no hypothesis receipt + no reason → NO_COGNITIVE_UPDATE', () => {
  const v = evaluateCloseLoop(oneReceipt, { ...cleanFacts, hasPostLessonEvaluation: false });
  assert.equal(v.length, 1);
  assert.equal(v[0]!.code, 'NO_COGNITIVE_UPDATE');
});

test('check ②: no_cognitive_update_reason is an escape hatch', () => {
  const v = evaluateCloseLoop(oneReceipt, {
    ...cleanFacts,
    hasPostLessonEvaluation: false,
    noCognitiveUpdateReason: '本课纯复述, 无新认知信号',
  });
  assert.deepEqual(v, []);
});

test('check ②: blank/whitespace reason does NOT satisfy', () => {
  const v = evaluateCloseLoop(oneReceipt, {
    ...cleanFacts,
    hasPostLessonEvaluation: false,
    noCognitiveUpdateReason: '   ',
  });
  assert.equal(v[0]!.code, 'NO_COGNITIVE_UPDATE');
});

test('check ②: a valid hypothesis_update receipt satisfies cognitive update', () => {
  const items: CloseLoopReceiptItem[] = [
    { kind: 'hypothesis_update', description: 'downweighted formula-preference', ref_id: 'hyp_1' },
  ];
  const v = evaluateCloseLoop(items, {
    ...cleanFacts,
    hasPostLessonEvaluation: false,
    refPresence: { hyp_1: ['learner_hypotheses'] },
  });
  assert.deepEqual(v, []);
});

test('check ②: hypothesis_update with a DANGLING ref does NOT satisfy (and is itself flagged)', () => {
  const items: CloseLoopReceiptItem[] = [
    { kind: 'hypothesis_update', description: 'claims a hypothesis update', ref_id: 'hyp_ghost' },
  ];
  const v = evaluateCloseLoop(items, {
    ...cleanFacts,
    hasPostLessonEvaluation: false,
    refPresence: {}, // hyp_ghost resolves to nothing
  });
  const codes = v.map((x) => x.code).sort();
  assert.deepEqual(codes, ['DANGLING_REF', 'NO_COGNITIVE_UPDATE']);
});

// ---- ③ 悬空 ref ----
test('check ③: ref_id present but resolving to nothing → DANGLING_REF with index', () => {
  const items: CloseLoopReceiptItem[] = [
    { kind: 'exercise_feedback', description: 'graded', ref_id: 'sub_ghost' },
  ];
  const v = evaluateCloseLoop(items, { ...cleanFacts, refPresence: {} });
  assert.equal(v.length, 1);
  assert.equal(v[0]!.code, 'DANGLING_REF');
  assert.equal((v[0]!.details.dangling_refs as any[])[0].index, 0);
});

test('check ③: ref resolves but to the WRONG table for the kind → DANGLING_REF', () => {
  // exercise_feedback expects exercise_submissions; here the id only exists as a flashcard.
  const items: CloseLoopReceiptItem[] = [
    { kind: 'exercise_feedback', description: 'mislabeled', ref_id: 'card_1' },
  ];
  const v = evaluateCloseLoop(items, {
    ...cleanFacts,
    refPresence: { card_1: ['flashcards'] },
  });
  assert.equal(v[0]!.code, 'DANGLING_REF');
});

test('check ③: real ref in the right table passes', () => {
  const items: CloseLoopReceiptItem[] = [
    { kind: 'teacher_note', description: 'added a note', ref_id: 'lpatch_1' },
  ];
  const v = evaluateCloseLoop(items, {
    ...cleanFacts,
    refPresence: { lpatch_1: ['lesson_patches'] },
  });
  assert.deepEqual(v, []);
});

test('check ③: ref_id omitted is not "dangling" (only provided refs are checked)', () => {
  const items: CloseLoopReceiptItem[] = [{ kind: 'journal_entry', description: 'no ref' }];
  const v = evaluateCloseLoop(items, cleanFacts);
  assert.deepEqual(v, []);
});

// ---- ④ Live snapshot ----
test('check ④: completed live session but no receipt references its snapshot → block', () => {
  const v = evaluateCloseLoop(oneReceipt, {
    ...cleanFacts,
    completedLiveSessionIds: ['live_1'],
    snapshotIdsBySession: { live_1: ['snap_1'] },
  });
  assert.equal(v.length, 1);
  assert.equal(v[0]!.code, 'LIVE_SNAPSHOT_UNREFERENCED');
  assert.deepEqual(v[0]!.details.acceptable_refs, ['snap_1']);
});

test('check ④: referencing the snapshot (journal_entry ref) satisfies it', () => {
  const items: CloseLoopReceiptItem[] = [
    { kind: 'journal_entry', description: 'referenced the live snapshot', ref_id: 'snap_1' },
  ];
  const v = evaluateCloseLoop(items, {
    ...cleanFacts,
    completedLiveSessionIds: ['live_1'],
    snapshotIdsBySession: { live_1: ['snap_1'] },
    refPresence: { snap_1: ['mid_lesson_snapshots'] },
  });
  assert.deepEqual(v, []);
});

test('check ④: session with no snapshots falls back to accepting the session id', () => {
  const items: CloseLoopReceiptItem[] = [
    { kind: 'journal_entry', description: 'acknowledged the live session', ref_id: 'live_1' },
  ];
  const v = evaluateCloseLoop(items, {
    ...cleanFacts,
    completedLiveSessionIds: ['live_1'],
    snapshotIdsBySession: {}, // no snapshots exist for this session
    refPresence: { live_1: ['live_sessions'] },
  });
  assert.deepEqual(v, []);
});

test('check ④: 场评(live_session_evaluation) 存在, 无快照 → 引用 evaluation id 也满足 (红队第四轮)', () => {
  const items: CloseLoopReceiptItem[] = [
    { kind: 'journal_entry', description: 'referenced the live evaluation', ref_id: 'lse_1' },
  ];
  const v = evaluateCloseLoop(items, {
    ...cleanFacts,
    completedLiveSessionIds: ['live_1'],
    snapshotIdsBySession: {}, // 课中从未写过快照 (真实情况: 快照写入现已 enforce 只能在 active 时发生)
    evaluationIdsBySession: { live_1: ['lse_1'] },
    refPresence: { lse_1: ['live_session_evaluations'] },
  });
  assert.deepEqual(v, []);
});

test('check ④: 快照和场评都没有 → 仍回落到 session id 本身', () => {
  const items: CloseLoopReceiptItem[] = [
    { kind: 'journal_entry', description: 'acknowledged the live session', ref_id: 'live_1' },
  ];
  const v = evaluateCloseLoop(items, {
    ...cleanFacts,
    completedLiveSessionIds: ['live_1'],
    snapshotIdsBySession: {},
    evaluationIdsBySession: {},
    refPresence: { live_1: ['live_sessions'] },
  });
  assert.deepEqual(v, []);
});

test('check ④: no completed live session → check does not block', () => {
  const v = evaluateCloseLoop(oneReceipt, { ...cleanFacts, completedLiveSessionIds: [] });
  assert.deepEqual(v, []);
});

// ---- ⑦ live 引用须有实质 ----
test('check ⑦: 空壳场引用 (未 completed 且无快照/场评) → LIVE_REF_NO_SUBSTANCE', () => {
  const items: CloseLoopReceiptItem[] = [
    { kind: 'journal_entry', description: 'live 场次引用', ref_id: 'live_hollow' },
  ];
  const v = evaluateCloseLoop(items, {
    ...cleanFacts,
    refPresence: { live_hollow: ['live_sessions'] },
    liveRefSubstance: { live_hollow: { completed: false, hasEvidence: false } },
  });
  assert.equal(v.length, 1);
  assert.equal(v[0]!.code, 'LIVE_REF_NO_SUBSTANCE');
  assert.match(v[0]!.message, /live_hollow/);
});

test('check ⑦: completed 空场引用作数 (④ 既有回落语义: completed 即有实质)', () => {
  const items: CloseLoopReceiptItem[] = [
    { kind: 'journal_entry', description: 'live 场次引用', ref_id: 'live_done' },
  ];
  const v = evaluateCloseLoop(items, {
    ...cleanFacts,
    refPresence: { live_done: ['live_sessions'] },
    liveRefSubstance: { live_done: { completed: true, hasEvidence: false } },
  });
  assert.deepEqual(v, []);
});

test('check ⑦: 未 completed 但有快照/场评的场引用作数', () => {
  const items: CloseLoopReceiptItem[] = [
    { kind: 'journal_entry', description: 'live 场次引用', ref_id: 'live_active_snap' },
  ];
  const v = evaluateCloseLoop(items, {
    ...cleanFacts,
    refPresence: { live_active_snap: ['live_sessions'] },
    liveRefSubstance: { live_active_snap: { completed: false, hasEvidence: true } },
  });
  assert.deepEqual(v, []);
});

test('check ⑦: 与 ③ 分工——幽灵 live id 走 DANGLING_REF, 不重复报 ⑦', () => {
  const items: CloseLoopReceiptItem[] = [
    { kind: 'journal_entry', description: 'live 场次引用', ref_id: 'live_ghost' },
  ];
  const v = evaluateCloseLoop(items, {
    ...cleanFacts,
    hasPostLessonEvaluation: true,
    refPresence: {}, // 查无此 id
    liveRefSubstance: {},
  });
  const codes = v.map((x) => x.code);
  assert.deepEqual(codes, ['DANGLING_REF']);
});

// ---- 组合: 三路对抗一次性全亮 (空头回执 + 悬空 ref + 跳过批改) ----
test('adversarial: hollow + dangling + skipped grading all surface together', () => {
  const items: CloseLoopReceiptItem[] = [
    { kind: 'exercise_feedback', description: 'pretend graded', ref_id: 'sub_ghost' },
  ];
  const v = evaluateCloseLoop(items, {
    ungradedSubmissionIds: ['sub_real'],
    hasPostLessonEvaluation: false,
    refPresence: {},
    liveRefSubstance: {},
    completedLiveSessionIds: [],
    snapshotIdsBySession: {},
    evaluationIdsBySession: {},
    hasCompletedDeclared: true,
  });
  const codes = v.map((x) => x.code).sort();
  assert.deepEqual(codes, ['DANGLING_REF', 'NO_COGNITIVE_UPDATE', 'UNGRADED_SUBMISSIONS']);
});

// ---- ⓪ 完成权 gate ----
test('check ⓪: 未宣告 close 被拒 — hasCompletedDeclared=false → NOT_DECLARED', () => {
  const v = evaluateCloseLoop(oneReceipt, { ...cleanFacts, hasCompletedDeclared: false });
  assert.equal(v.length, 1);
  assert.equal(v[0]!.code, 'NOT_DECLARED');
  assert.match(v[0]!.message, /declared/);
});

test('check ⓪: 已宣告 close 成功 — hasCompletedDeclared=true 时其余满足即零违规', () => {
  const v = evaluateCloseLoop(oneReceipt, { ...cleanFacts, hasCompletedDeclared: true });
  assert.deepEqual(v, []);
});

test('check ⓪: 未宣告与其它缺口同时成立时一并全亮 (不互相吞)', () => {
  const v = evaluateCloseLoop(oneReceipt, {
    ...cleanFacts,
    hasCompletedDeclared: false,
    ungradedSubmissionIds: ['sub_x'],
  });
  const codes = v.map((x) => x.code).sort();
  assert.deepEqual(codes, ['NOT_DECLARED', 'UNGRADED_SUBMISSIONS']);
});

// ---- resolveCloseAttempt: closed 不可逆 + 完成权事实推导 ----
test('state=closed → already_closed (幂等短路, 不进硬检、不重写 closed_at)', () => {
  assert.deepEqual(resolveCloseAttempt({ state: 'closed', declared_at: new Date() }), {
    kind: 'already_closed',
  });
  // 历史合法关课: closed 行哪怕 declared_at 为 null (不该发生, 但档案里若有)
  // 也一样是终态短路 — 不可逆压倒一切。
  assert.deepEqual(resolveCloseAttempt({ state: 'closed', declared_at: null }), {
    kind: 'already_closed',
  });
});

test('state=completed_declared → proceed 且 hasCompletedDeclared=true', () => {
  assert.deepEqual(resolveCloseAttempt({ state: 'completed_declared', declared_at: new Date() }), {
    kind: 'proceed',
    hasCompletedDeclared: true,
  });
  // declared_at 缺失但 state 已是 completed_declared — state 本身就算数。
  assert.deepEqual(resolveCloseAttempt({ state: 'completed_declared', declared_at: null }), {
    kind: 'proceed',
    hasCompletedDeclared: true,
  });
});

test('非 completed_declared 但 declared_at 非空 → 也算已宣告', () => {
  assert.deepEqual(resolveCloseAttempt({ state: 'in_progress', declared_at: new Date() }), {
    kind: 'proceed',
    hasCompletedDeclared: true,
  });
});

test('无 progress 行 / 未宣告的行 → proceed 且 hasCompletedDeclared=false (随后被 NOT_DECLARED 拦)', () => {
  assert.deepEqual(resolveCloseAttempt(null), { kind: 'proceed', hasCompletedDeclared: false });
  assert.deepEqual(resolveCloseAttempt({ state: 'not_started', declared_at: null }), {
    kind: 'proceed',
    hasCompletedDeclared: false,
  });
  assert.deepEqual(resolveCloseAttempt({ state: 'in_progress', declared_at: null }), {
    kind: 'proceed',
    hasCompletedDeclared: false,
  });
});

// ---- 回执推荐状态化 ----
test('first closed lesson (count=1) recommends add_lesson, not reflect_on_teaching', () => {
  assert.deepEqual(pickCloseLoopNextActions(1, false), ['add_lesson']);
});

test('count=0 (edge case, should not occur in practice) still recommends add_lesson', () => {
  assert.deepEqual(pickCloseLoopNextActions(0, false), ['add_lesson']);
});

test('third closed lesson (count=3, >= 2) recommends reflect_on_teaching', () => {
  assert.deepEqual(pickCloseLoopNextActions(3, false), ['reflect_on_teaching']);
});

test('exactly 2 closed lessons is the >= 2 boundary — recommends reflect_on_teaching', () => {
  assert.deepEqual(pickCloseLoopNextActions(2, false), ['reflect_on_teaching']);
});

// ---- 红队第四轮: 推荐状态感知 ----
test('count>=2 but already reflected since last close → recommends add_lesson, not a repeat reflect_on_teaching', () => {
  assert.deepEqual(pickCloseLoopNextActions(3, true), ['add_lesson']);
});

test('count<2 ignores hasReflectedSinceLastClose either way (still building toward the floor)', () => {
  assert.deepEqual(pickCloseLoopNextActions(1, true), ['add_lesson']);
  assert.deepEqual(pickCloseLoopNextActions(1, false), ['add_lesson']);
});

// ---------------------------------------------------------------------------
// get_lesson_closure_state 只读状态机 (Live 2.0 二期 W2 件二)
// ---------------------------------------------------------------------------

const allDoneNoLive: LessonClosureStateFacts = {
  ungradedSubmissionIds: [],
  hasLive: false,
  hasCompletedLive: false,
  hasLiveEvidence: false,
  hasLiveEvaluation: false,
  hasPostLessonEvaluation: true,
  hasReflectedForClose: true,
  hasReceipts: false,
  isClosed: false,
};

test('closure state: everything satisfied but never closed → ready_to_close (receipts/closed still miss, as expected pre-close)', () => {
  const r = computeLessonClosureState(allDoneNoLive);
  assert.equal(r.state, 'ready_to_close');
  assert.deepEqual(r.missing, ['receipts', 'closed']);
  assert.deepEqual(r.completed, ['graded', 'post_lesson_evaluation', 'reflection']);
});

test('closure state: closed lesson → state=closed regardless of anything else, no live items (hasLive=false)', () => {
  const r = computeLessonClosureState({ ...allDoneNoLive, hasReceipts: true, isClosed: true });
  assert.equal(r.state, 'closed');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.completed, ['graded', 'post_lesson_evaluation', 'reflection', 'receipts', 'closed']);
});

test('closure state: ungraded submissions is the first gap → state=graded', () => {
  const r = computeLessonClosureState({ ...allDoneNoLive, ungradedSubmissionIds: ['sub_1'] });
  assert.equal(r.state, 'graded');
  assert.deepEqual(r.missing, ['graded', 'receipts', 'closed']);
});

test('语义护栏: 非 closed/ready_to_close 时 state 点名的是首个缺口 — 恒在 missing[] 里、恒不在 completed[] 里 (state 是待办名, 不是成就名)', () => {
  // 真实误读案例: state=graded 且 missing 含 graded, 被读成自相矛盾。
  // 判定本身如此设计 (state = 首个缺口的语义名), 这里把该不变式钉死: 凡 state
  // 是项名 (非 closed / ready_to_close), 它必须同时出现在 missing[] —— 两个
  // 字段说的是同一件事, 永不真矛盾; 措辞歧义由工具描述/human_note 消化。
  const variants: LessonClosureStateFacts[] = [
    { ...allDoneNoLive, ungradedSubmissionIds: ['sub_1'] },
    { ...allDoneNoLive, hasPostLessonEvaluation: false },
    { ...allDoneNoLive, hasReflectedForClose: false },
    { ...allDoneNoLive, hasLive: true, hasCompletedLive: false },
    { ...allDoneNoLive, hasLive: true, hasCompletedLive: true, hasLiveEvidence: false },
  ];
  for (const facts of variants) {
    const r = computeLessonClosureState(facts);
    if (r.state === 'closed' || r.state === 'ready_to_close') continue;
    assert.ok(r.missing.includes(r.state), `state=${r.state} 必须出现在 missing[] (它就是首个缺口)`);
    assert.ok(!r.completed.includes(r.state), `state=${r.state} 不得出现在 completed[]`);
    assert.equal(r.missing[0], r.state, 'state 必须恰是按序第一个缺口');
  }
});

test('closure state: no post_lesson_evaluation (graded ok) → state=post_lesson_evaluation', () => {
  const r = computeLessonClosureState({ ...allDoneNoLive, hasPostLessonEvaluation: false });
  assert.equal(r.state, 'post_lesson_evaluation');
});

test('closure state: no reflection (eval ok) → state=reflection', () => {
  const r = computeLessonClosureState({ ...allDoneNoLive, hasReflectedForClose: false });
  assert.equal(r.state, 'reflection');
});

test('closure state: hasLive=false omits live_completed/live_evidence/live_evaluation from both lists', () => {
  const r = computeLessonClosureState(allDoneNoLive);
  for (const item of ['live_completed', 'live_evidence', 'live_evaluation']) {
    assert.ok(!r.completed.includes(item as never));
    assert.ok(!r.missing.includes(item as never));
  }
});

const withLiveFacts: LessonClosureStateFacts = {
  ...allDoneNoLive,
  hasLive: true,
  hasCompletedLive: true,
  hasLiveEvidence: true,
  hasLiveEvaluation: true,
};

test('closure state: hasLive=true and all three live items satisfied → they show as completed, order preserved', () => {
  const r = computeLessonClosureState(withLiveFacts);
  assert.deepEqual(r.completed, [
    'graded',
    'live_completed',
    'live_evidence',
    'live_evaluation',
    'post_lesson_evaluation',
    'reflection',
  ]);
  assert.equal(r.state, 'ready_to_close');
});

test('closure state: live session exists but none completed → state=live_completed (before live_evidence/evaluation)', () => {
  const r = computeLessonClosureState({
    ...withLiveFacts,
    hasCompletedLive: false,
    hasLiveEvidence: false,
    hasLiveEvaluation: false,
  });
  assert.equal(r.state, 'live_completed');
});

test('closure state: completed live session, snapshot-only evidence (no explicit evaluation) → state=live_evaluation', () => {
  const r = computeLessonClosureState({ ...withLiveFacts, hasLiveEvaluation: false });
  assert.equal(r.state, 'live_evaluation');
  assert.ok(r.completed.includes('live_evidence'));
  assert.ok(r.missing.includes('live_evaluation'));
});

test('closure state: completed live session, no evidence at all → state=live_evidence (before live_evaluation)', () => {
  const r = computeLessonClosureState({ ...withLiveFacts, hasLiveEvidence: false, hasLiveEvaluation: false });
  assert.equal(r.state, 'live_evidence');
});

// ---- pickLessonClosureNextAction ----

test('next action: closed → null', () => {
  assert.equal(pickLessonClosureNextAction('closed', { lessonId: 'lsn_1' }), null);
});

test('next action: graded gap with a known submission id → grade_exercise pre-filled', () => {
  const a = pickLessonClosureNextAction('graded', { lessonId: 'lsn_1', firstUngradedSubmissionId: 'sub_1' });
  assert.deepEqual(a, { tool: 'grade_exercise', pre_filled_refs: { submission_id: 'sub_1' } });
});

test('next action: live_completed gap with a live (not dead) session → live_session_complete', () => {
  const a = pickLessonClosureNextAction('live_completed', {
    lessonId: 'lsn_1',
    latestUnfinishedLiveSessionId: 'ls_1',
    latestUnfinishedLiveSessionIsDead: false,
  });
  assert.deepEqual(a, { tool: 'live_session_complete', pre_filled_refs: { session_id: 'ls_1' } });
});

test('next action: live_completed gap with only a dead (cancelled/expired) session → live_session_start', () => {
  const a = pickLessonClosureNextAction('live_completed', {
    lessonId: 'lsn_1',
    latestUnfinishedLiveSessionId: 'ls_dead',
    latestUnfinishedLiveSessionIsDead: true,
  });
  assert.deepEqual(a, {
    tool: 'live_session_start',
    pre_filled_refs: { context_type: 'lesson', context_id: 'lsn_1' },
  });
});

test('next action: live_evidence / live_evaluation gaps both point at record_live_evaluation', () => {
  const refs = { lessonId: 'lsn_1', firstCompletedLiveSessionId: 'ls_done' };
  assert.deepEqual(pickLessonClosureNextAction('live_evidence', refs), {
    tool: 'record_live_evaluation',
    pre_filled_refs: { live_session_id: 'ls_done' },
  });
  assert.deepEqual(pickLessonClosureNextAction('live_evaluation', refs), {
    tool: 'record_live_evaluation',
    pre_filled_refs: { live_session_id: 'ls_done' },
  });
});

test('next action: post_lesson_evaluation / reflection / ready_to_close each point at their own tool', () => {
  assert.deepEqual(pickLessonClosureNextAction('post_lesson_evaluation', { lessonId: 'lsn_1' }), {
    tool: 'record_post_lesson_evaluation',
    pre_filled_refs: { lesson_id: 'lsn_1' },
  });
  assert.deepEqual(pickLessonClosureNextAction('reflection', { lessonId: 'lsn_1' }), {
    tool: 'reflect_on_teaching',
    pre_filled_refs: { lesson_id: 'lsn_1' },
  });
  assert.deepEqual(pickLessonClosureNextAction('ready_to_close', { lessonId: 'lsn_1' }), {
    tool: 'close_lesson_loop',
    pre_filled_refs: { lesson_id: 'lsn_1' },
  });
});
