// Unit tests for live-contract additions — 教义版本号 +
// known_contract_version 协议 (buildContractStamp) + session stub 瘦身。
// 纯函数, 无 DB (db/client 的连接池是惰性的, import 不落地连接)。
// Run via `pnpm --filter @learn-shell/server test`.
//
// 这组用例钉住 live_wait / GET /bridge/wait 的版本协议判定层: MCP 与 REST
// 两个入口都只是把 buildContractStamp 的结果铺进各自的返回体, 协议语义
// (命中⇒省合约体留 may_end_turn, 缺省/过期⇒完整合约) 全在这里。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLiveRuntimeContract,
  buildContractStamp,
  buildLiveWaitData,
  liveRuntimeContractVersion,
  toLiveSessionStub,
} from './live-contract';

// ---- liveRuntimeContractVersion ----

test('contract version: stable 12-hex, cached across calls', () => {
  const v1 = liveRuntimeContractVersion();
  const v2 = liveRuntimeContractVersion();
  assert.match(v1, /^[0-9a-f]{12}$/);
  assert.equal(v1, v2);
});

test('contract version hashes doctrine only — may_end_turn (per-call state) is excluded', () => {
  // 教义 = buildLiveRuntimeContract 除 may_end_turn 外的全部字段。两种
  // may_end_turn 取值下教义相同 ⇒ 版本必须唯一 (否则超时/事件响应会在两个
  // 版本号之间来回翻, known_contract_version 永远命不中)。
  const { may_end_turn: _a, ...doctrineFalse } = buildLiveRuntimeContract(false);
  const { may_end_turn: _b, ...doctrineTrue } = buildLiveRuntimeContract(true);
  assert.deepEqual(doctrineFalse, doctrineTrue);
});

// ---- buildContractStamp — the live_wait version protocol pin ----

test('protocol: no known version → full contract body + version stamped (首次完整)', () => {
  const stamp = buildContractStamp(undefined, false);
  assert.equal(stamp.matched, false);
  assert.equal(stamp.contract_version, liveRuntimeContractVersion());
  assert.ok(!stamp.matched);
  assert.deepEqual(stamp.live_runtime_contract, buildLiveRuntimeContract(false));
});

test('protocol: stale version → full contract body, same as omitted', () => {
  const stamp = buildContractStamp('deadbeef0000', true);
  assert.equal(stamp.matched, false);
  assert.ok(!stamp.matched && stamp.live_runtime_contract.may_end_turn === true);
});

test('protocol: current version → contract body omitted, may_end_turn survives on its own (无损红线③)', () => {
  const stamp = buildContractStamp(liveRuntimeContractVersion(), false);
  assert.equal(stamp.matched, true);
  assert.equal(stamp.contract_version, liveRuntimeContractVersion());
  // 瘦响应里没有合约体…
  assert.ok(!('live_runtime_contract' in stamp));
  // …但逐次现算的 may_end_turn 必须原样保留 — 它是状态不是教义。
  assert.ok(stamp.matched && stamp.may_end_turn === false);
  const stampMayEnd = buildContractStamp(liveRuntimeContractVersion(), true);
  assert.ok(stampMayEnd.matched && stampMayEnd.may_end_turn === true);
});

// ---- toLiveSessionStub (件三, live 事件瘦身) ----

test('session stub keeps orientation fields, drops the heavy near-constant rest', () => {
  const row = {
    id: 'ls_x1',
    pair_id: 'pair_1',
    context_type: 'lesson',
    context_id: 'lsn_1',
    context_preview: '一节课的标题预览',
    goal: '本场目标',
    status: 'active',
    awaiting_role: 'agent',
    summary: '很长的收课总结……',
    teacher_reflection: '很长的教学反思……',
    next_action: '下一步……',
    started_at: new Date(),
    ended_at: null,
    last_activity_at: new Date(),
  } as never;
  const stub = toLiveSessionStub(row);
  assert.deepEqual(stub, {
    id: 'ls_x1',
    context_type: 'lesson',
    context_id: 'lsn_1',
    goal: '本场目标',
    status: 'active',
    awaiting_role: 'agent',
  });
  // scripts/live-watch.py 的摘要行读的四个字段一个不少。
  for (const key of ['id', 'context_type', 'context_id', 'goal']) {
    assert.ok(key in stub, `live-watch.py summary field '${key}' must survive the slimming`);
  }
});

test('session stub: null goal → dropped from JSON entirely (goal ?? undefined)', () => {
  const stub = toLiveSessionStub({
    id: 'ls_x2',
    context_type: 'flashcard',
    context_id: 'fc_1',
    goal: null,
    status: 'active',
    awaiting_role: 'learner',
  } as never);
  assert.equal(JSON.parse(JSON.stringify(stub)).goal, undefined);
});

// ---- buildLiveWaitData — live_wait data 六件套 ----

test('live_wait timeout data: full six-field machine contract even on empty timeout (matched stamp)', () => {
  const stamp = buildContractStamp(liveRuntimeContractVersion(), false);
  const data = buildLiveWaitData(stamp, { events: [], timeout: true }, 'tr_since_1', '2026-07-22T12:00:00.000Z');
  assert.deepEqual(data, {
    events: [],
    timeout: true,
    since: 'tr_since_1',
    heartbeat_until: '2026-07-22T12:00:00.000Z',
    contract_version: liveRuntimeContractVersion(),
    may_end_turn: false,
  });
});

test('live_wait timeout data: unmatched stamp (fresh/compacted agent, 首次完整) carries the same six fields', () => {
  // 缺省 known_contract_version 正是陌生 agent / compact 后重挂的第一跳——
  // 曾发生的事故形态: 这个分支的 data 曾只剩 {events, timeout, since}。
  const stamp = buildContractStamp(undefined, true);
  const data = buildLiveWaitData(stamp, { events: [], timeout: true }, '', '2026-07-22T12:00:50.000Z');
  assert.deepEqual(data, {
    events: [],
    timeout: true,
    since: '',
    heartbeat_until: '2026-07-22T12:00:50.000Z',
    contract_version: liveRuntimeContractVersion(),
    may_end_turn: true,
  });
});

test('live_wait event data: events pass through untouched, timeout false, six fields still present', () => {
  const stamp = buildContractStamp('stale_version_', false);
  const events = [{ channel: 'adhoc', reason: 'adhoc_message', event_id: 'ahm_1' }];
  const data = buildLiveWaitData(stamp, { events, timeout: false }, 'ahm_0', '2026-07-22T12:01:00.000Z');
  assert.equal(data.timeout, false);
  assert.deepEqual(data.events, events);
  for (const key of ['events', 'timeout', 'since', 'heartbeat_until', 'contract_version', 'may_end_turn']) {
    assert.ok(key in data, `live_wait data contract field '${key}' must be present`);
  }
});
