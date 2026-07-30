// apps/server/src/lib/regrade.ts — 重批持证 (⑤), 纯判定核心。
//
// 裁决原文的骨架: 改判自由, 痕迹免费。已 graded 的提交允许改判, 但必须
// 显式带 regrade: true 表明意图 (缺省 → CONFLICT, 防的是"没意识到自己在
// 覆盖一份既有判决"的无意识重批); 放行时旧判决摘要 (previous_score /
// previous_feedback) 自动进追加的 graded 事件 payload——改判不需要审批,
// 但历史不许蒸发。
//
// DB 读写留在 mcp/server.ts 的 grade_exercise case; 这里只做无副作用的
// "现状 + 意图 → 放行/拒绝" 判定, 好脱离数据库单测 (同 close-loop-guard /
// hypothesis-lifecycle 的抽取纪律)。

/** 事件 payload 里旧评语摘要的截断长度——痕迹是摘要不是全文转录 (全文永远
 *  在上一份判决自己的历史里, 这里只要够辨认"改判前说过什么")。 */
export const PREVIOUS_FEEDBACK_SUMMARY_CHARS = 200;

export function summarizePreviousFeedback(feedback: string | null): string | null {
  if (feedback == null) return null;
  return feedback.length > PREVIOUS_FEEDBACK_SUMMARY_CHARS
    ? `${feedback.slice(0, PREVIOUS_FEEDBACK_SUMMARY_CHARS)}…`
    : feedback;
}

export interface SubmissionGradeSnapshot {
  status: string;
  graded_at: Date | null;
  agent_score: number | null;
  agent_feedback: string | null;
}

export type RegradeResolution =
  /** 首判 — 无既有判决, regrade 标志无关紧要。 */
  | { kind: 'fresh' }
  /** 持证改判 — 事件 payload 应携带的旧判决摘要一并算好。 */
  | {
      kind: 'regrade';
      previous: { previous_score: number | null; previous_feedback: string | null };
    }
  /** 无证重批 — 已有判决且未带 regrade: true。 */
  | { kind: 'refused'; message: string };

export function resolveRegradeAttempt(
  submission: SubmissionGradeSnapshot,
  regradeFlag: boolean | undefined
): RegradeResolution {
  const alreadyGraded = submission.status === 'graded' || submission.graded_at !== null;
  if (!alreadyGraded) return { kind: 'fresh' };
  if (regradeFlag !== true) {
    return {
      kind: 'refused',
      message:
        'This submission already has a verdict (status=graded) — to regrade, pass regrade: true explicitly to state your intent. ' +
        'Regrading is unrestricted and the trail is free: once allowed, the old verdict summary (previous_score/previous_feedback) is ' +
        'automatically written into the appended exercise.graded event payload — you don\'t need to report it separately.',
    };
  }
  return {
    kind: 'regrade',
    previous: {
      previous_score: submission.agent_score,
      previous_feedback: summarizePreviousFeedback(submission.agent_feedback),
    },
  };
}
