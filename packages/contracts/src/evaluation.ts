// PostLessonEvaluation — 每节课结束的纯事实层记录 (TEACHING-SPEC §4.2).
// LiveSessionEvaluation — 单场 live session 的现场评估 (评估拆分, 迁移 0030,
// 设计稿 §9.1/9.2)。两层分开写、分开读: 一课可能横跨多场 live session, 每场
// 各自的现场观察不该被课级总评摊平掉。
//
// 3-课阈值规则 (§4.3):
//   第 1-2 课: 只写 PostLessonEvaluation, 不写 Hypothesis / Reflection
//   第 3 课结束: 跨 3 课提取 pattern, 首次写 1+ Hypothesis (status: tentative) + 1 Reflection
//   第 4 课起: 每课一份新 Reflection, 可能 update hypothesis 状态
//
// 设计哲学: agent 不在前 3 课贴标签, 攒够证据再判断.

import type { PairId } from './pair';
import type { LessonId, ConceptId } from './content';
import type { SessionId } from './session';
import type { LiveSessionId } from './teaching';

export type PostLessonEvaluationId = string & { readonly __brand: 'PostLessonEvaluationId' };

export interface PostLessonEvaluation {
  id: PostLessonEvaluationId;
  pair_id: PairId;
  lesson_id: LessonId;
  /** 迁移 0030: session_id → learning_session_id — 名实相符, 与新增的
   *  LiveSessionEvaluation.live_session_id 区分开(两个不同的引用轴)。 */
  learning_session_id?: SessionId;

  // 纯事实层 (不打标签)
  concepts_touched: ConceptId[];
  flashcards_reviewed_count: number;
  flashcards_rating_distribution: Record<'Again' | 'Hard' | 'Good' | 'Easy', number>;
  exercises_submitted_count: number;
  live_turns_count: number;
  duration_minutes: number;

  // agent 简短观察, 不打 confidence 标签
  agent_observation: string;

  // 三通道制 (迁移 0044) — 一次判决三种呈现, 不算复判:
  //   agent_observation = 教师内账 (内部 id 引用可入, 不直接示人);
  //   learner_note      = 学习者可见人话 (语言随 learners.locale);
  //   evidence_refs     = 机器引用数组 (服务端校验: id 必须真实且属本 pair)。
  // 可选+可空 — 存量行与未分层写入没有这两份。
  learner_note?: string | null;
  evidence_refs?: string[] | null;

  created_at: string;
}

export type LiveSessionEvaluationId = string & { readonly __brand: 'LiveSessionEvaluationId' };

/** 迁移 0030 (设计稿 §9.1/9.2): 一场 live session 一份现场评估 — 唯一约束
 *  (live_session_id) 由服务端 live_session_evaluations 表的唯一索引兜底,
 *  一场不许重复写。 */
export interface LiveSessionEvaluation {
  id: LiveSessionEvaluationId;
  pair_id: PairId;
  live_session_id: LiveSessionId;

  concepts_touched: ConceptId[];
  live_turns_count?: number;
  duration_minutes?: number;
  agent_observation: string;

  // 三通道制 (迁移 0044) — 语义同 PostLessonEvaluation 的同名字段。
  learner_note?: string | null;
  evidence_refs?: string[] | null;

  created_at: string;
}
