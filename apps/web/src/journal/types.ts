// Journal-α entry model — three timeline citizens, one union.
//
// 课 (重) / Live (中) / 复习日 (轻，一行).
// "我的笔记" (Annotation, β) 有意不在这里出现 — 批C/D 之后另接.

import type { CourseId, LessonId } from '@learn-shell/contracts';

export interface LessonJournalEntry {
  kind: 'lesson';
  /** PostLessonEvaluation.id — one evaluation ≈ one 课条目. */
  id: string;
  /** ISO — evaluation.created_at. */
  date: string;
  lessonId: LessonId;
  lessonTitle: string;
  courseId: CourseId | null;
  courseTopic: string | null;
  /** null = 没交作业, 不占位 (brief §数据拼装约束). */
  exerciseCount: number | null;
  /** 已批改的分数, 按 exercise.order 排序; 未批改的不进这个数组. */
  exerciseScores: number[];
  /** 该课概念下挂的闪卡数 (lesson-prep 阶段产出); null = 0, 不占位. */
  newCardsCount: number | null;
  /** null = 未打点 (真实数据里目前恒为 0, 视为缺失). */
  durationMinutes: number | null;
  // 三通道呈现分层 (迁移 0044, JOURNAL-DESIGN-BRIEF 尾) ——
  // API 三字段各自照搬进这里, 分层规则由渲染层 (LessonEntryCard) 执行:
  //   learnerNote 有值 → 卡片主文案 (人话优先);
  //   agentObservation → learnerNote 存在时降级进折叠次要区 ("教学观察"),
  //                       learnerNote 缺席 (旧数据) 时原样回落当主文案 (兼容);
  //   evidenceRefs      → 不进正文, 展示为安静的引用小行, 非空才占位。
  /** post_lesson_evaluation.learner_note — 学习者可见人话, trim 后为空则视
   *  为缺席 (null), 触发下面的兼容回落。 */
  learnerNote: string | null;
  /** post_lesson_evaluation.agent_observation — 教师内账, 语义见上。 */
  agentObservation: string | null;
  /** post_lesson_evaluation.evidence_refs — 机器引用 id 数组, 空数组视为
   *  缺席 (null), 不留空位。 */
  evidenceRefs: string[] | null;
}

export interface LiveJournalEntry {
  kind: 'live';
  /** LiveSession.id. */
  id: string;
  date: string;
  lessonId: LessonId | null;
  lessonTitle: string | null;
  courseId: CourseId | null;
  // 换源 (2026-07-25): 这里原本是 live_sessions 的 REFLECT 三段
  // (summary / teacher_reflection / next_action)，直接摊给学习者看。那三列是
  // 收课时老师写给自己的内账——`live_session_complete` 的工具说明白纸黑字要求
  // summary "锚到具体对话条目 message id"，teacher_reflection 是"薄弱环节,
  // 直白不吹捧"，整条 live_sessions 表也没有 learner_note 列(apps/server/src/
  // db/schema/teaching.ts)。结果就是 `tr_ms0dx77a_sie4wo 显示学习者独立守住
  // Fact 的时态边界` 这种机器码上了学习者的屏。三段整体退役，不做正则剥离
  // (剥完句子就没主语了，那是遮掩不是修复)。
  //
  // 换上的是这场 Live 真正的学习者通道：live_session_evaluations 的三通道制
  // (迁移 0044)，与课条目 (LessonEntryCard) 同一套分层规则，也与
  // 课文页 Live 面板里的 LiveSessionEvaluationBlock 读同一份数据。
  /** live_session_evaluation.learner_note — 学习者可见人话, trim 后为空视为
   *  缺席 (null), 触发下面的兼容回落。 */
  learnerNote: string | null;
  /** live_session_evaluation.agent_observation — 教师内账 (内部 id 就该写在
   *  这里)。learnerNote 在时降级进折叠次要区, 不在时原样回落当正文。 */
  agentObservation: string | null;
  /** live_session_evaluation.evidence_refs — 机器引用 id 数组, 空数组视为
   *  缺席 (null)。 */
  evidenceRefs: string[] | null;
  /** moves.length — null 表示 full view 还没取回来. */
  turnCount: number | null;
}

export interface ReviewDayJournalEntry {
  kind: 'review-day';
  /** 合成 id, 按天聚合, 不对应单一表行. */
  id: string;
  /** 当天最晚一次 session 的 started_at — 用于跟其它条目一起倒序排. */
  date: string;
  dayKey: string; // YYYY-MM-DD, 本地时区
  cardCount: number;
  /** null = 命中数据取不到 (events 还没拉回来/拉不到), 不许硬凑. */
  hitCount: number | null;
}

// 考纲登记簿 — 第四类条目, 一周至多一条,
// 无新点亮的周不出条目 (由 useJournalTimeline.ts 按周聚合 syllabus mappings
// 派生, 数据来源见该文件顶部注释). 语言规范 (brief §4): 只报点亮, 不数黑洞 —
// 这个类型本身没有任何"落后/欠账"形态的字段, 渲染文案同规范 (见
// entries/SyllabusWeekEntryCard.tsx).
export interface SyllabusWeekJournalEntry {
  kind: 'syllabus-week';
  /** 合成 id, 按周聚合, 不对应单一表行 (同 ReviewDayJournalEntry 的 id 惯例). */
  id: string;
  /** 该周最晚一次 mapping 的 created_at — 决定这条排进哪个日组 (dayKey 同源). */
  date: string;
  /** 该周最晚一次 mapping 所在的本地日历天 — 复用 ReviewDayJournalEntry 的
   *  "非 date 派生 dayKey" 惯例, 让日分组直接读这个字段而不必对 date 再跑
   *  dayKeyOf. */
  dayKey: string;
  /** 本周内出现至少一次新 mapping 的考点 code, 去重, created_at 升序. 截断
   *  显示是渲染层的事 (brief §4 "code 列表截断") — 这里给全量, 不预截断. */
  litNodeCodes: string[];
  /** 累计覆盖 %（0..100），以该周结束时点已出现过的全部 mapping 为准计算 ——
   *  简化口径：有过至少一次 mapping 的节点数 / 节点总数，不做 exam_weight
   *  加权（真正的加权 rollup 是 GET /pairs/:id/syllabus 的 coverage_pct；这里
   *  为了不必对每个历史周重放一次加权算法而特意简化，取舍说明见
   *  useJournalTimeline.ts 顶部注释）。null = 没有可用的节点总数（树为空时
   *  理论上不会发生，因为空树根本不会产出这类条目）。 */
  cumulativeCoveragePct: number | null;
}

export type JournalEntry =
  | LessonJournalEntry
  | LiveJournalEntry
  | ReviewDayJournalEntry
  | SyllabusWeekJournalEntry;
