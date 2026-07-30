// 课程"是否算完成"的单点判定 (planned_lesson_count 施工批, 迁移 0032,
// 2026-07-19; ready_to_complete 拆分, α批四针, 2026-07-20) — 同时供
// lib/context-brief.ts 的 buildContractProgressLines (聚合真假值, get_context
// 的 contract_progress 信号用) 与 mcp/server.ts 的 complete_contract 前置
// 校验③ (逐课差额明细) 复用。
//
// 施工前这两处是各自独立的手写实现——都过滤"已发布课" + 检查 learning 轴
// ∈ {completed_declared, closed}, 但只是巧合地长得像, 没有共享代码。加
// planned_lesson_count 新口径时若只改一处, 两处判断会分叉(get_context 说
// "该结业了", complete_contract 却拒绝, 反之亦然)。这个文件把"一门课算不
// 算完成"的核心判据收进一个函数, 两个调用点各自决定怎么聚合(全课程 all() /
// 逐课差额明细), 但判据本身同源。
//
// 2026-07-20 红队: "结业应是有证据的判断, 不是'数据库里暂时没有下一课'的
// 副作用"——旧的单一 ready_to_complete 布尔值把"读完已发布的课"和"教够了
// 计划的节数"焊在一起, 调用方分不清到底是哪一层不满足。拆成两层判据:
//   ① caughtUp (operationally_caught_up 的逐课判据) — 该课程至少有一节已
//      发布课, 且全部已发布课 learning 轴 ∈ DONE_STATES (未发布的草稿课不
//      计入)。零已发布课(还没开始教)不算 caughtUp——空真值会把"从没开课"
//      误判成"已完成"。这是旧口径(0032 之前的 ready_to_complete), 不管
//      plannedLessonCount 是否定过都可以为 true。
//   ② goalReady (goal_completion_ready 的逐课判据) — 在 caughtUp 基础上,
//      还须 plannedLessonCount 非空("一共几节"这一问有答案)且已发布节数
//      ≥ plannedLessonCount。plannedLessonCount 为 null(旧课兼容口径——
//      0032 之前建的课, 或建课时没回答这一问的新课)时 goalReady 恒 false
//      ——"暂时没有下一课"不能顶替"教够了计划节数"这个有证据的判断。

import type { LessonProgressState } from '@learn-shell/contracts';

export const COURSE_COMPLETION_DONE_STATES = new Set<LessonProgressState>(['completed_declared', 'closed']);

export interface PublishedLessonLearningState {
  id: string;
  learning: LessonProgressState;
}

export interface CourseCompletionJudgment {
  /** 传入的已发布课数量 (未发布课已被调用方过滤掉, 不出现在这里)。 */
  publishedCount: number;
  /** 已发布但 learning 未进入终态的课 id 列表——判据①的差额。 */
  incompleteLessonIds: string[];
  /** plannedLessonCount 为 null (未定计划节数)——判据②的前提缺失, 与
   *  belowPlannedCount 互斥地区分"没定计划"和"定了但没教够"两种差额。 */
  missingPlannedCount: boolean;
  /** plannedLessonCount 非空且已发布节数不足时为 true——判据②的差额。 */
  belowPlannedCount: boolean;
  /** 判据① — 至少一节已发布课, 且全部已发布课 learning 轴已到终态。
   *  即 operationally_caught_up 的逐课判据 (旧 ready_to_complete 口径)。 */
  caughtUp: boolean;
  /** 判据①+② — caughtUp 基础上, plannedLessonCount 非空且已发布节数够数。
   *  即 goal_completion_ready 的逐课判据; plannedLessonCount 为 null 时恒
   *  false。 */
  goalReady: boolean;
}

/** 核心判据, 只吃"已发布课"投影(调用方负责按 content==='published' 先过滤)
 *  + 该课程的 planned_lesson_count。产出 caughtUp/goalReady 两层聚合真值
 *  (见头注①②), 调用方各自决定怎么进一步聚合(全课程 all() / 逐课差额
 *  明细), 但判据本身同源。 */
export function evaluateCourseCompletion(
  publishedLessons: PublishedLessonLearningState[],
  plannedLessonCount: number | null
): CourseCompletionJudgment {
  const publishedCount = publishedLessons.length;
  const incompleteLessonIds = publishedLessons
    .filter((l) => !COURSE_COMPLETION_DONE_STATES.has(l.learning))
    .map((l) => l.id);
  const missingPlannedCount = plannedLessonCount == null;
  const belowPlannedCount = plannedLessonCount != null && publishedCount < plannedLessonCount;
  const caughtUp = publishedCount > 0 && incompleteLessonIds.length === 0;
  const goalReady = caughtUp && !missingPlannedCount && !belowPlannedCount;
  return {
    publishedCount,
    incompleteLessonIds,
    missingPlannedCount,
    belowPlannedCount,
    caughtUp,
    goalReady,
  };
}
