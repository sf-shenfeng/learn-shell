// apps/server/src/lib/live-contract.ts — 值更契约全路径暴露 (红队 P0,
// Live 2.0 二期 W2 件一)。
//
// 纯装配 + 一条极小的 DB 判定, 挂进 mcp/server.ts 与 routes/teaching.ts 的
// 六个落点(MCP 四 + HTTP 两)返回体 (live_session_start / live_session_get / live_wait+GET
// /bridge/wait / live_pending+GET /bridge/pending)。类型定义
// (LiveRuntimeContract) 在 packages/contracts/src/teaching.ts —— 那边的
// 头注写了完整的动机与语义, 这里只管"怎么造出这个对象"与"pair 级 may_end_turn
// 怎么查"两件事。

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { live_sessions, type LiveSessionRow } from '../db/schema';
import {
  LIVE_RUNTIME_TERMINAL_STATES,
  type LiveContextType,
  type LiveRuntimeContract,
  type LiveSessionStatus,
  type LiveSessionStub,
} from '@learn-shell/contracts';
import { contentHash12 } from './content-hash';

/** session 级判定: 这个状态是不是三种终态之一。 */
export function isTerminalLiveSessionStatus(status: LiveSessionStatus): boolean {
  return (LIVE_RUNTIME_TERMINAL_STATES as readonly LiveSessionStatus[]).includes(status);
}

/** pair 级判定: 这个 pair 名下还有没有 status='active' 的 live session ——
 *  live_wait / GET /bridge/wait / live_pending / GET /bridge/pending 四处
 *  用这个, 不看 awaiting_role (哪怕 awaiting='learner', 会话仍在场, 值更
 *  义务不因为"这一拍不该我说话"就解除)。 */
export async function pairHasActiveLiveSession(pairId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: live_sessions.id })
    .from(live_sessions)
    .where(and(eq(live_sessions.pair_id, pairId), eq(live_sessions.status, 'active')))
    .limit(1);
  return !!row;
}

/** 开课原子去重 (红队第六轮针一, 2026-07-20) — 同 (pair, context_type,
 *  context_id) 下现有的 active 会话, 有则整行返回, 无则 null。
 *  mcp/server.ts 的 live_session_start 与 routes/teaching.ts 的 POST
 *  /sessions 两个入口共用: 插入前先查一遍(常规路径, 免大多数情况下的一次
 *  写冲突), 插入撞上 迁移 0036 的部分唯一索引(23505) 时再查一遍(兜底
 *  路径, 处理两个入口真正并发抢开同一间教室的那一拍)——两处调用都指这一个
 *  函数, 不各写一份查询, 保证"什么算撞了"的判定口径同源。 */
export async function findActiveLiveSessionForContext(
  pairId: string,
  contextType: LiveContextType,
  contextId: string
): Promise<LiveSessionRow | null> {
  const [row] = await db
    .select()
    .from(live_sessions)
    .where(
      and(
        eq(live_sessions.pair_id, pairId),
        eq(live_sessions.context_type, contextType),
        eq(live_sessions.context_id, contextId),
        eq(live_sessions.status, 'active')
      )
    )
    .limit(1);
  return row ?? null;
}

/** 唯一装配点 —— duty_requirement/allowed_wait_modes/wake_owner/
 *  terminal_states 六个落点(MCP 四 + HTTP 两)调用方逐字一致, 只有 may_end_turn 因调用方各自的
 *  session 级/pair 级判定而不同, 由调用方算好再传进来。 */
export function buildLiveRuntimeContract(mayEndTurn: boolean): LiveRuntimeContract {
  return {
    duty_requirement: 'block_current_turn_or_verified_wake_owner',
    may_end_turn: mayEndTurn,
    allowed_wait_modes: ['live_wait', 'persistent_watch'],
    wake_owner: null,
    terminal_states: [...LIVE_RUNTIME_TERMINAL_STATES],
  };
}

// ============================================================================
// 教义版本号 + known_contract_version 协议 (契约版本协议注释见
// packages/contracts/src/teaching.ts LiveRuntimeContract 上方)。
// ============================================================================

let contractVersionCache: string | null = null;

/** 值更契约"教义部分"(may_end_turn 剔除 — 那是逐次现算的状态, 不是教义)的
 *  content hash, 进程内算一次后缓存。教义全是代码内常量, 版本只随部署变。 */
export function liveRuntimeContractVersion(): string {
  if (contractVersionCache === null) {
    const { may_end_turn: _perCall, ...doctrine } = buildLiveRuntimeContract(false);
    contractVersionCache = contentHash12(doctrine);
  }
  return contractVersionCache;
}

export type ContractStamp =
  | {
      /** 缺省/过期版本 — 首次完整①: 合约体照发, 并随行现行版本号。 */
      matched: false;
      contract_version: string;
      live_runtime_contract: LiveRuntimeContract;
    }
  | {
      /** 命中现行版 — 合约体省略; may_end_turn 是逐次状态非教义, 单独保留
       *  (无损红线③)。 */
      matched: true;
      contract_version: string;
      may_end_turn: boolean;
    };

/** live_wait / GET /bridge/wait 共用的一处判定: 调用方自报的
 *  known_contract_version 命中现行版 ⇒ 瘦响应, 否则完整合约体。 */
export function buildContractStamp(
  knownContractVersion: string | undefined,
  mayEndTurn: boolean
): ContractStamp {
  const version = liveRuntimeContractVersion();
  if (knownContractVersion === version) {
    return { matched: true, contract_version: version, may_end_turn: mayEndTurn };
  }
  return {
    matched: false,
    contract_version: version,
    live_runtime_contract: buildLiveRuntimeContract(mayEndTurn),
  };
}

/** MCP live_wait 的 data 装配唯一点。文档承诺的
 *  机器可消费合同是 data 恒为 {events, timeout, since, heartbeat_until,
 *  contract_version, may_end_turn} —— 超时空手 ({events:[], timeout:true})
 *  也必须整套齐全。合约体瘦身落地时只有 known_contract_version 命中
 *  (matched) 的分支装齐了这六件, 缺省/过期分支的 data 只剩 {events, timeout,
 *  since} —— 而"缺省"恰是陌生 agent / compact 后重挂的第一跳, 最需要机器
 *  可读超时合同的一跳。收口到这一个函数, 两个分支同吃, 不再各装各的。
 *  (matched 时 may_end_turn 直接取 stamp 的逐次状态; 未命中时从随行的完整
 *  合约体里取同一个值 —— 两条路是同一次 pairHasActiveLiveSession 判定。) */
export function buildLiveWaitData<E>(
  stamp: ContractStamp,
  result: { events: E[]; timeout: boolean },
  since: string,
  heartbeatUntilIso: string
): {
  events: E[];
  timeout: boolean;
  since: string;
  heartbeat_until: string;
  contract_version: string;
  may_end_turn: boolean;
} {
  return {
    events: result.events,
    timeout: result.timeout,
    since,
    heartbeat_until: heartbeatUntilIso,
    contract_version: stamp.contract_version,
    may_end_turn: stamp.matched ? stamp.may_end_turn : stamp.live_runtime_contract.may_end_turn,
  };
}

/** (件三) — live_sessions 整行 → 逐事件随行的 stub (类型注释见
 *  contracts/teaching.ts LiveSessionStub)。goal 列可空 → undefined, JSON
 *  序列化时直接脱落。 */
export function toLiveSessionStub(
  row: Pick<
    LiveSessionRow,
    | 'id'
    | 'context_type'
    | 'context_id'
    | 'goal'
    | 'status'
    | 'awaiting_role'
    | 'learner_close_declared_at'
  >
): LiveSessionStub {
  return {
    id: row.id as LiveSessionStub['id'],
    context_type: row.context_type,
    context_id: row.context_id,
    goal: row.goal ?? undefined,
    status: row.status,
    awaiting_role: row.awaiting_role,
    // 下课铃 (二期) — 未宣告时连键都不出现 (条件展开而非 undefined 值:
    // 既让 JSON 干净, 也不惊动既有"stub 恰好这几个键"的深比较消费方)。
    ...(row.learner_close_declared_at
      ? { learner_close_declared_at: row.learner_close_declared_at.toISOString() }
      : {}),
  };
}
