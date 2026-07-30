// apps/server/src/lib/learner-close-declaration.ts — 下课铃门禁 (二期)
//
// Live 收课同意此前只活在对话里 (传闻证据) —— 收课握手此前是 recipe 法,
// 无机器锚。迁移 0042 给了它数据库正身: live_sessions.learner_close_declared_at
// (learner 侧 POST /sessions/:id/declare-close 落笔)。这里是读那一列的门:
// complete (MCP live_session_complete / REST POST /complete) 在既有状态机
// guard (lib/live-session-transitions.ts, 终态锁——那是它的职责, 本体不动)
// 之上多一道: 本场没有学习者收课宣告 ⇒ CONFLICT。
//
// 语义边界:
//   - 决定下课的是学习者, 合上帷幕的是老师 —— 按铃=落宣告, 不是杀进程;
//     agent 收到宣告事件后走完 summary/反思/complete。
//   - cancel 不受此门 (取消≠收官)。
//   - 幂等 complete 重放 (session 已 completed) 也不受此门 —— 门只拦
//     "第一次收官", 不追溯拦历史上铃诞生之前就完成的场。
//
// 纯判定零 IO (同 live-session-transitions 的抽取纪律); DB 读写留在两个
// 调用面。assert 包装是 MCP 侧的抛错便捷层, REST 侧自己把 reject 映成
// 409 JSON。

import { McpToolError } from './mcp-errors';

/** 门禁判词 — REST 409 body 与 MCP CONFLICT message 共用同一句人话。 */
export const LEARNER_CLOSE_NOT_DECLARED_MESSAGE =
  "The learner hasn't rung the end-of-class bell yet. If the learner has said out loud that they're done, guide them to press the end-of-class bell in the Live room before completing.";

export type CloseDeclarationDecision =
  | { kind: 'proceed' }
  | { kind: 'reject'; message: string };

/** 判定核心 — declared_at 为空 (null/undefined) 即拒。 */
export function evaluateCloseDeclarationGate(
  learnerCloseDeclaredAt: Date | string | null | undefined
): CloseDeclarationDecision {
  if (learnerCloseDeclaredAt == null) {
    return { kind: 'reject', message: LEARNER_CLOSE_NOT_DECLARED_MESSAGE };
  }
  return { kind: 'proceed' };
}

/** MCP 侧便捷包装: 未宣告 ⇒ 抛 CONFLICT (不可原样重试 —— 铃没响, 重试
 *  永远不会成功; 等学习者按铃后再来才会变)。 */
export function assertLearnerCloseDeclared(
  learnerCloseDeclaredAt: Date | string | null | undefined,
  sessionId: string
): void {
  const decision = evaluateCloseDeclarationGate(learnerCloseDeclaredAt);
  if (decision.kind === 'reject') {
    throw new McpToolError('CONFLICT', decision.message, {
      retryable: false,
      details: { session_id: sessionId, learner_close_declared_at: null },
      recovery_hint:
        "Don't just retry as-is. First guide the learner to press the end-of-class bell themselves in the Live room " +
        '(once she presses it, this session gets a live.learner_close_declared event appended, visible via ' +
        'live_wait/live_pending), then call live_session_complete to wrap up. If the learner actually wants to keep going, ' +
        'continue the lesson; if you need to abort rather than wrap up, use live_session_cancel (cancel is not gated by this).',
    });
  }
}
