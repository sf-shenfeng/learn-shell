// 增量游标 · Live 场次 (2026-09-02) — sliceLiveSessionIncrement 的用例。
// 纯函数, 无 DB (live-wait 里 db/client 的连接池是惰性的, import 不落地连接)。
// Run via `pnpm --filter @learn-shell/server test`.
//
// 这组用例钉住 live_session_get 的 after_event_id 与 GET
// /teaching/sessions/:id?after_event_id= 共用的那一刀: 两个入口都只是把本函
// 数的结果铺进各自的返回体, 游标语义全在这里。契约四条:
//   1) 不传游标 = 全量 (与本参数存在之前逐字节相同)
//   2) 传了游标 = 只给之后的, moves 与 responses 共用同一个游标
//   3) 游标已是最新 = 空集, 且 next_after_event_id 原地不动
//   4) 非法/串场游标 = 退化成全量 + cursor_recognized=false (不报错、不丢内容)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceLiveSessionIncrement } from './live-wait';

// genId() 的形状: `${prefix}_${Date.now().toString(36)}_${rand6}`。
// 这里按毫秒手铸, 让 move/response 严格交替成一条时间线。
const id = (prefix: string, ms: number, rand = 'aaaaaa') =>
  `${prefix}_${ms.toString(36)}_${rand}`;

const M1 = { id: id('tm', 1_000), seq: 1 }; // FRAME
const M2 = { id: id('tm', 2_000), seq: 2 }; // ASK
const R1 = { id: id('tr', 3_000) }; // 学习者回答
const M3 = { id: id('tm', 4_000), seq: 3 }; // PROBE
const R2 = { id: id('tr', 5_000) }; // 学习者回答

const MOVES = [M1, M2, M3];
const RESPONSES = [R1, R2];

// ---- 1) 缺省 = 全量 (向后兼容的那条命) ----

test('无游标 ⇒ 全量: moves/responses 一条不少, has_earlier=false', () => {
  const s = sliceLiveSessionIncrement(MOVES, RESPONSES);
  assert.deepEqual(s.moves, MOVES);
  assert.deepEqual(s.responses, RESPONSES);
  assert.equal(s.returned_moves, 3);
  assert.equal(s.returned_responses, 2);
  assert.equal(s.total_moves, 3);
  assert.equal(s.total_responses, 2);
  assert.equal(s.has_earlier, false);
  assert.equal(s.cursor_recognized, true);
  // 第一刀全量就带回下一刀的游标 —— 调用方不必自己拼。
  assert.equal(s.next_after_event_id, R2.id);
});

test('空字符串游标与不传等价 (查询串里的 ?after_event_id= 空值不算游标)', () => {
  const s = sliceLiveSessionIncrement(MOVES, RESPONSES, '');
  assert.equal(s.returned_moves, 3);
  assert.equal(s.returned_responses, 2);
  assert.equal(s.has_earlier, false);
  assert.equal(s.cursor_recognized, true);
});

test('空场次 + 无游标 ⇒ 空集, next_after_event_id=null', () => {
  const s = sliceLiveSessionIncrement([], [], undefined);
  assert.deepEqual(s.moves, []);
  assert.deepEqual(s.responses, []);
  assert.equal(s.next_after_event_id, null);
  assert.equal(s.has_earlier, false);
});

// ---- 2) 有游标 = 只给之后的 ----

test('游标落在中段 ⇒ 只返回严格新于它的 move 与 response (一个游标管两类)', () => {
  const s = sliceLiveSessionIncrement(MOVES, RESPONSES, R1.id);
  assert.deepEqual(s.moves, [M3]);
  assert.deepEqual(s.responses, [R2]);
  assert.equal(s.returned_moves, 1);
  assert.equal(s.returned_responses, 1);
  assert.equal(s.total_moves, 3);
  assert.equal(s.total_responses, 2);
  assert.equal(s.has_earlier, true);
  assert.equal(s.cursor_recognized, true);
  assert.equal(s.next_after_event_id, R2.id);
});

test('游标是一条 move ⇒ 同毫秒线上更晚的 response 照样返回 (不按前缀分家)', () => {
  const s = sliceLiveSessionIncrement(MOVES, RESPONSES, M2.id);
  assert.deepEqual(
    s.moves.map((m) => m.id),
    [M3.id]
  );
  assert.deepEqual(
    s.responses.map((r) => r.id),
    [R1.id, R2.id]
  );
  assert.equal(s.has_earlier, true);
});

test('游标是最早那条 ⇒ 只省掉它自己, 其余全给', () => {
  const s = sliceLiveSessionIncrement(MOVES, RESPONSES, M1.id);
  assert.equal(s.returned_moves, 2);
  assert.equal(s.returned_responses, 2);
  assert.equal(s.has_earlier, true);
});

// ---- 3) 游标已是最新 ⇒ 空集 + 游标不动 ----

test('游标=最新一条 ⇒ 空集, next_after_event_id 原地不动 (可直接再挂一刀)', () => {
  const s = sliceLiveSessionIncrement(MOVES, RESPONSES, R2.id);
  assert.deepEqual(s.moves, []);
  assert.deepEqual(s.responses, []);
  assert.equal(s.returned_moves, 0);
  assert.equal(s.returned_responses, 0);
  assert.equal(s.has_earlier, true);
  assert.equal(s.cursor_recognized, true);
  assert.equal(s.next_after_event_id, R2.id);
});

test('最新一条是 move 时同理 (没有 response 的场次也不塌成 null)', () => {
  const s = sliceLiveSessionIncrement(MOVES, [], M3.id);
  assert.equal(s.returned_moves, 0);
  assert.equal(s.next_after_event_id, M3.id);
  assert.equal(s.total_responses, 0);
});

test('空转两刀: 拿 next_after_event_id 再读一次仍是空集且游标不变 (循环收敛)', () => {
  const first = sliceLiveSessionIncrement(MOVES, RESPONSES, R2.id);
  const second = sliceLiveSessionIncrement(
    MOVES,
    RESPONSES,
    first.next_after_event_id ?? undefined
  );
  assert.equal(second.returned_moves, 0);
  assert.equal(second.returned_responses, 0);
  assert.equal(second.next_after_event_id, first.next_after_event_id);
});

// ---- 4) 非法游标 ⇒ 退化成全量, 不报错不丢内容 ----

test('游标不是本场次任何一条 ⇒ cursor_recognized=false + 全量返回 (宁多勿少)', () => {
  const s = sliceLiveSessionIncrement(MOVES, RESPONSES, id('tr', 9_999, 'zzzzzz'));
  assert.equal(s.cursor_recognized, false);
  assert.equal(s.returned_moves, 3);
  assert.equal(s.returned_responses, 2);
  assert.equal(s.has_earlier, false);
  assert.equal(s.next_after_event_id, R2.id);
});

test('形状根本不对的游标 (非 genId 串) 同样退化成全量, 不抛异常', () => {
  const s = sliceLiveSessionIncrement(MOVES, RESPONSES, 'not-an-id');
  assert.equal(s.cursor_recognized, false);
  assert.equal(s.returned_moves, 3);
  assert.equal(s.returned_responses, 2);
});

test('串场游标 (别的 session 的合法 id) 也算非法 ⇒ 全量 + 旗子落地', () => {
  const otherSessionMove = id('tm', 2_500, 'bbbbbb');
  const s = sliceLiveSessionIncrement(MOVES, RESPONSES, otherSessionMove);
  assert.equal(s.cursor_recognized, false);
  // 没有静默按时间戳切一刀把 M1/M2 吞掉 —— 全量。
  assert.equal(s.returned_moves, 3);
  assert.equal(s.returned_responses, 2);
});

// ---- 排序语义: 与 isNewerEventId 同一套时钟, 不按裸字符串比 ----

test('跨前缀比较走内嵌时间戳, 不是裸字符串序 (tm_ < tr_ 的陷阱)', () => {
  // 裸字符串序下 'tm_…' < 'tr_…' 恒成立, 会把更早的 tr_ 误判为"更新"。
  const earlyResponse = { id: id('tr', 1_500) };
  const laterMove = { id: id('tm', 6_000) };
  const s = sliceLiveSessionIncrement([M1, laterMove], [earlyResponse], earlyResponse.id);
  assert.deepEqual(
    s.moves.map((m) => m.id),
    [laterMove.id]
  );
  assert.deepEqual(s.responses, []);
  assert.equal(s.next_after_event_id, laterMove.id);
});
