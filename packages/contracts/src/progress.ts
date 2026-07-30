// 异步师生关系状态机 — 完成状态机 (§6) + 改课三律数据形态 (§4) + 回执制 (§5) +
// 知情跳过档案记录 (§2)。2026-07-11 施工批。
//
// 本文件只承载这一批新增的类型；状态机语义/三律边界/回执枚举全集以设计文档为
// 权威 — 这里的注释只留"为什么这样建模", 不重复整段设计原文。

import type { PairId } from './pair';
import type { LessonId } from './content';

// ============================================================================
// 完成状态机 (§6): 未开始 → 学习中 → 已学完(学习者宣布) → 已回课(老师批改+回执送达)
// ============================================================================

export type LessonProgressState = 'not_started' | 'in_progress' | 'completed_declared' | 'closed';

/**
 * 核对单快照 — 宣布"已学完"那一刻现算，不代按 (§6: "系统提供核对单佐证但不代
 * 按")。pages_total 依赖前端分页信息，本批后端不掌握页面切分逻辑，缺省 null
 * 表示"未追踪"，而不是伪造一个 0/0；exercises_* 是服务端真值 (直接数库)。
 * pages_read (迁移 0037 起) 也是服务端真值——不再是客户端在宣布那一刻附带的
 * 瞬时"当前页"数字，而是 lesson_progress.pages_visited 足迹集合(∪ 本次声明
 * 附带的当前页)的并集大小，见 routes/write.ts computeChecklistSnapshot。
 */
export interface LessonChecklistSnapshot {
  pages_total: number | null;
  pages_read: number | null;
  exercises_total: number;
  exercises_submitted: number;
  /** 如实记录的缺口 (§6: "允许带缺口宣布,核对单如实记录缺口") — 空数组=无缺口。 */
  gaps: string[];
}

/**
 * 设计 §2 知情跳过 — 进入一课时其前置存在未批改提交, 放行但记档, 供未来
 * `difficulty_timing` 归因取证 ("带着未批改的前置进的这课")。
 */
export interface PrerequisiteSkipEvent {
  prerequisite_lesson_id: LessonId;
  /** 该前置课上尚未批改的提交 id 列表 — 跳过当时的证据快照。 */
  ungraded_submission_ids: string[];
  skipped_at: string;
}

export interface LessonProgress {
  id: string;
  pair_id: PairId;
  lesson_id: LessonId;
  state: LessonProgressState;
  declared_at: string | null;
  closed_at: string | null;
  checklist_snapshot: LessonChecklistSnapshot | null;
  prerequisite_skips: PrerequisiteSkipEvent[];
  /** 迁移 0037 (学习者裁决第三针) — 到过哪些页的足迹集合(0-based page_index,
   *  去重, 只增不减)。POST /lessons/:id/progress/touch 每次带 page_index 调用
   *  就并入一个新页码; declare-completed 的 checklist 页数从这个集合的并集
   *  大小算, 不再相信调用那一刻的"当前页"瞬时值——回看是美德不是倒退, 进度
   *  记足迹, 不记立足点。 */
  pages_visited: number[];
  updated_at: string;
}

// ============================================================================
// 改课三律 (§4) 的落点二档 — 未开始的课不走这里, 直接 update_lesson 整改。
// ============================================================================

export type LessonPatchKind = 'teacher_note' | 'erratum';

export const LESSON_PATCH_KINDS: LessonPatchKind[] = ['teacher_note', 'erratum'];

export interface LessonPatch {
  id: string;
  lesson_id: LessonId;
  pair_id: PairId;
  kind: LessonPatchKind;
  body: string;
  /** 可选 — 锚定页码或引用原文片段, 自由文本, 不强制结构。 */
  anchor?: string | null;
  /** 可选 — 引用归因/批改依据, 例如 "基于你第X课的作业"。 */
  source_attribution?: string | null;
  created_at: string;
}

// ============================================================================
// 回执制 (§5) — 落点全集是封闭枚举, close_lesson_loop 只许引用这七种
// ("不许发明新黑箱"的机器化)。
// ============================================================================

export type LessonLoopReceiptKind =
  | 'exercise_feedback'
  | 'forward_revision'
  | 'teacher_note'
  | 'erratum'
  | 'flashcard_change'
  | 'hypothesis_update'
  | 'journal_entry';

export const LESSON_LOOP_RECEIPT_KINDS: LessonLoopReceiptKind[] = [
  'exercise_feedback',
  'forward_revision',
  'teacher_note',
  'erratum',
  'flashcard_change',
  'hypothesis_update',
  'journal_entry',
];

export interface LessonLoopReceipt {
  id: string;
  pair_id: PairId;
  lesson_id: LessonId;
  kind: LessonLoopReceiptKind;
  description: string;
  ref_id?: string | null;
  created_at: string;
}

// ============================================================================
// 修订已读回执 (迁移 0030) — 服务端真相, 替换 web localStorage。
// "这个学习者把这节课读到第几版了" —— upsert 更新 revision + seen_at,
// (pair_id, lesson_id) 唯一, 一课一行。
// ============================================================================

export interface LessonRevisionSeen {
  id: string;
  pair_id: PairId;
  lesson_id: LessonId;
  /** 已读到的 revision 号 (对应 lessons.revision)。 */
  revision: number;
  seen_at: string;
}

// ============================================================================
// 关课前只读状态机 (get_lesson_closure_state, Live 2.0 二期 W2 件二)
// ============================================================================
//
// close_lesson_loop 的四道硬检 (lib/close-loop-guard.ts evaluateCloseLoop)
// 逐项映射成一个只读 checklist，好让 agent 关课前一次问清"缺什么、下一步调
// 哪个工具、id 是什么"，不必自己脑内串 live_pending + submissions + eval +
// reflection 好几刀。
//
// 八项固定顺序 (live_completed/live_evidence/live_evaluation 三项仅在
// "本课挂过 Live" 时出现，"有 live 时"判定见 lib/lesson-closure-facts.ts)：
//   graded → live_completed → live_evidence → live_evaluation →
//   post_lesson_evaluation → reflection → receipts → closed
export type LessonClosureItemName =
  | 'graded'
  | 'live_completed'
  | 'live_evidence'
  | 'live_evaluation'
  | 'post_lesson_evaluation'
  | 'reflection'
  | 'receipts'
  | 'closed';

/**
 * `state` 是"首个缺口的语义名"，但有两处收口：
 *   - 一旦 lesson_progress.state === 'closed' → 'closed'，其余项一律不再看。
 *   - 首个缺口若恰好是 'receipts' 或 'closed' 本身 → 化名 'ready_to_close'
 *     (lib/close-loop-guard.ts computeLessonClosureState 头注：receipts 缺口
 *     就是"万事俱备只差调 close_lesson_loop"的同义词，不该自报一个只有关课
 *     那一刻才会被同时满足的项名)。
 */
export type LessonClosureState = LessonClosureItemName | 'ready_to_close';

export interface LessonClosureNextRequiredAction {
  tool: string;
  pre_filled_refs: Record<string, string>;
}

/**
 * 共享形状 (红队第六轮针二, 2026-07-20) — get_lesson_closure_state 的完整
 * 返回体 (LessonClosureStateReport) 与 record_live_evaluation /
 * record_post_lesson_evaluation / reflect_on_teaching(带锚) /
 * close_lesson_loop 四工具成功回执随行附带的 `closure_progress` 共用这三个
 * 字段。后者裁掉 lesson_id (调用方自己就是那次调用的参数, 不必回声)
 * 与 state (由 missing 是否为空隐含 — missing 恒以 receipts/closed 收尾,
 * 见 lib/close-loop-guard.ts computeLessonClosureState)。
 */
export interface ClosureProgress {
  completed: LessonClosureItemName[];
  missing: LessonClosureItemName[];
  /** null only when the lesson is fully closed (nothing left to do). */
  next_required_action: LessonClosureNextRequiredAction | null;
}

export interface LessonClosureStateReport extends ClosureProgress {
  lesson_id: LessonId;
  state: LessonClosureState;
  /** 错题卡事实行 — 只读陈述, NOT in missing[], 不带
   *  severity/建议。本课已批改且判错 (lib/lesson-closure-facts.ts
   *  isIncorrectVerdict) 的提交数, 以及这些判错习题涉及的概念里已经挂了至少
   *  一张闪卡的比例 (concepts_with_flashcard / concepts_total)。只在
   *  get_lesson_closure_state 的完整报告里出现——ClosureProgress 是四工具
   *  随行回执共用的裁剪形状 (lib/lesson-closure-facts.ts toClosureProgress
   *  只挑 completed/missing/next_required_action 三字段), 不带这条, 那四份
   *  回执的既有体积不因这条新事实膨胀。 */
  incorrect_review_signal: {
    incorrect_submission_count: number;
    concepts_with_flashcard: number;
    concepts_total: number;
  };
}

// ============================================================================
// 四轴单点 (State 2.0, 迁移 0030 同批) — apps/server/src/lib/lesson-state.ts
// 是这个类型唯一的读取实现 (getLessonAxes/getLessonAxesForLessons)；定义放
// 这个包(而不是那个模块本身)是因为 apps/web 的课程/课清单页也要按这份形状
// 渲染 (routes/read.ts 把它拼进每课的 payload 里) —— contracts 包是 server 和
// web 都能导入的公共层, lesson-state.ts 反过来从这里 re-export, 避免两处各
// 定义一份定义漂移。四轴各自独立的事实源, 语义详见 lesson-state.ts 头注。
// ============================================================================

export interface LessonAxes {
  /** lessons.published_at 是否非空 (Publish Gate)。 */
  content: 'draft' | 'published';
  /** lessons.revision — update_lesson 每次落笔递增的版本号, 全轨(teaching+
   *  technical 都计入), 事实层不动。展示层"已修订"判定不要直接用这个 —
   *  改用 teaching_revision (见下)。 */
  revision: number;
  /** lesson_revision_seen.revision — 无行 (从未读过任何一版) = null。仍是对
   *  全轨 revision 的记录 (写入时机见 apps/web/src/pages/Lesson.tsx 的已读
   *  打点), 但因 teaching_revision ≤ revision 恒成立, 拿它与 teaching_
   *  revision 比较同样成立, 不需要另开一条 "teaching_revision_seen"。 */
  revision_seen: number | null;
  /** 迁移 0033 — 只计 teaching 轨的"版本号": 该课 lesson_revisions 里最新一条
   *  kind='teaching' 的行所对应的"替换后版本号"(row.revision + 1); 从无
   *  teaching 修订则等于 1 (初版, 未被学习者可见的方式改过)。展示层
   *  ("已修订 vN" / "修订未读"判定) 一律读这个字段, 不读 revision ——
   *  技术修订不推高它, 对学习者隐身。见 lib/lesson-state.ts。 */
  teaching_revision: number;
  /** lesson_progress.state — 无行 = 合成 'not_started'。 */
  learning: LessonProgressState;
  /** post_lesson_evaluations 是否已有该 (pair, lesson) 的行。 */
  evaluated: boolean;
  /** learning === 'closed' 的布尔投影 — 与 learning 同源, 非独立事实源。 */
  loop_closed: boolean;
}
