// apps/server/src/lib/live-session-transitions.ts — Live 终态单向化状态机
//
// 单一真相源: REST (routes/teaching.ts POST /sessions/:id/complete|cancel) 与
// MCP (mcp/server.ts live_session_complete / live_session_cancel) 的终态写入
// 全部先过这一个 guard, 不再各自就地 update。规则 (以 schema 真实枚举为准,
// LiveSessionStatus = 'active' | 'completed' | 'cancelled' | 'expired', 其中
// 终态三种即 contracts 的 LIVE_RUNTIME_TERMINAL_STATES):
//
//   active → completed / cancelled / expired   合法 (proceed)
//   终态 → 同一终态                             幂等 no-op (不重写 ended_at,
//                                              不追加事件/副作用)
//   终态 → 其它任何态                           非法 (reject)
//
// target 在类型上就限定为三终态 —— "终态→active 复活"连表达都表达不出来,
// 编译期即封死。纯判定零 IO, DB 读写留在两个调用面 (同 close-loop-guard 的
// 抽取纪律); assertLiveTransition 是 MCP 侧的抛错便捷层 (REST 侧自己把
// reject 映成 409 JSON, 不吃 McpToolError)。

import type { LiveSessionStatus } from '@learn-shell/contracts';
import { isTerminalLiveSessionStatus } from './live-contract';
import { McpToolError } from './mcp-errors';

/** 三终态 — target 只许是这三个, 不含 active (终态→active 在类型层即非法)。 */
export type LiveTerminalStatus = 'completed' | 'cancelled' | 'expired';

export type LiveTransitionDecision =
  | { kind: 'proceed' }
  | { kind: 'noop' }
  | { kind: 'reject'; message: string };

/** 状态机判定核心 — REST 与 MCP 共用的唯一真相源。 */
export function evaluateLiveTransition(
  current: LiveSessionStatus,
  target: LiveTerminalStatus
): LiveTransitionDecision {
  if (current === target) {
    // 同终态重复请求 = 幂等 no-op: 不重写 ended_at (那是"这节课到底哪一刻
    // 结束的"的历史事实), 不追加任何副作用。
    return { kind: 'noop' };
  }
  if (isTerminalLiveSessionStatus(current)) {
    return {
      kind: 'reject',
      message:
        `Session is already terminal (${current}); it cannot transition to ${target} — terminal states are one-way and mutually exclusive ` +
        `(active → completed/cancelled/expired, locked in once, and terminal states never convert between each other). ` +
        `Call live_session_start to open a new session if you need to start over.`,
    };
  }
  // 唯一的非终态是 active (schema 枚举如此) —— 进行中 → 任一终态, 合法。
  return { kind: 'proceed' };
}

/** MCP 侧便捷包装: reject → 抛 CONFLICT (不可重试 — 终态不可逆, 原样重试
 *  永远不会成功); noop/proceed 返回给调用方自己分流。 */
export function assertLiveTransition(
  current: LiveSessionStatus,
  target: LiveTerminalStatus
): 'proceed' | 'noop' {
  const decision = evaluateLiveTransition(current, target);
  if (decision.kind === 'reject') {
    throw new McpToolError('CONFLICT', decision.message, {
      retryable: false,
      recovery_hint:
        "Call live_session_get to check this session's current state; terminal states are irreversible, don't just retry as-is — call live_session_start to open a new session if you need one.",
    });
  }
  return decision.kind;
}
