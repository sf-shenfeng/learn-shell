// LearningSession + typed SessionEvent stream.
//
// VISION-v4: LearningSession 是学习的最小记忆单位.
// ROADMAP-v2.1: ReviewEvent / StudentAnswer / TeachingIntervention / LearningEvidence
// 优先作为 typed SessionEvent 落库，dogfood 证明需要独立生命周期再拆专表.

import type { PairId } from './pair';
import type { EventEnvelope } from './envelope';
import type { ConceptId, FlashcardId, CourseId } from './content';

export type SessionId = string & { readonly __brand: 'SessionId' };

// =========================================================================
// Event types — every event MUST set `event_type` to one of these literals.
// =========================================================================

export type SessionEventType =
  | 'session.start'
  | 'session.end'
  | 'lesson.viewed'
  | 'review.rated'
  | 'concept.touched'
  | 'question.asked'
  | 'answer.given'
  | 'teaching.intervention'
  | 'learning.evidence'
  | 'mastery.estimate.changed'
  | 'hypothesis.proposed'
  | 'reflection.written'
  // ----- round 2 新增 -----
  | 'live.agent_message'
  | 'live.learner_message'
  | 'live.session_summary'
  // ----- 二期 下课铃 (迁移 0042) -----
  | 'live.learner_close_declared'
  | 'exercise.submitted'
  | 'exercise.withdrawn'
  | 'exercise.resubmitted'
  | 'exercise.graded'
  // ----- trial upgrade (2026-07-04) -----
  | 'trial.attempted'
  // ----- Recents 最近接触 (2026-07-30) — 阅读/看图这两个动作此前不留任何
  // 信号, Recents 只能按 updated_at(被创建/编辑) 排, 于是"最近"指的是最近被
  // 写过的东西, 不是最近被看过的。这两个类型跑既有 sessions/events 轨道, 无
  // 新表新列。 -----
  | 'document.viewed'
  | 'mindmap.viewed'
  | 'review.viewed';

// =========================================================================
// Typed payloads — one per event_type.
// =========================================================================

export type FSRSRating = 'Again' | 'Hard' | 'Good' | 'Easy';

export interface SessionStartPayload {
  course_id: CourseId | null;
  intent: string; // e.g. 'review_due_cards' / 'continue_lesson_2'
}

export interface SessionEndPayload {
  duration_ms: number;
  graceful: boolean;
}

export interface LessonViewedPayload {
  lesson_id: string;
  position_at_close: number; // 0..1 scroll progress
  /** 这节课所属的课程 (Recents 最近接触二期, 2026-07-30) — Recents 的 Lesson
   *  行靠它认"她最近在读哪门课"; 没有它就只能认活跃契约的课, 于是读了 B 课
   *  回头左栏还指着 A 课。
   *
   *  可选是为了向后兼容: 2026-07-30 之前写下的 lesson.viewed 事件没有这个
   *  字段, 既不迁移也不回填 (session_events.payload 是 text 列, 老行原样躺
   *  着)。读取侧必须容忍缺失——跳过没有 course_id 的事件, 回落到既有兜底。 */
  course_id?: CourseId;
}

export interface ReviewRatedPayload {
  card_id: FlashcardId;
  rating: FSRSRating;
  answer_text: string | null;
  time_to_answer_ms: number | null;
}

export interface ConceptTouchedPayload {
  concept_id: ConceptId;
  trigger: 'lesson' | 'flashcard' | 'mindmap' | 'qa';
}

export interface QuestionAskedPayload {
  question_text: string;
  asked_by: 'learner' | 'agent';
  related_concept_ids: ConceptId[];
}

export interface AnswerGivenPayload {
  answer_text: string;
  in_reply_to_event_id: string;
}

export interface TeachingInterventionPayload {
  method: string; // e.g. 'feynman' / 'socratic' / 'analogy-first' / 'formula-first'
  rationale: string;
  expected_outcome: string;
  prior_hypothesis_ids: string[];
}

export interface LearningEvidencePayload {
  observation: string;
  related_concept_ids: ConceptId[];
  signal_strength: 'weak' | 'moderate' | 'strong';
}

export interface MasteryEstimateChangedPayload {
  concept_id: ConceptId;
  prev_estimate: number | null;
  next_estimate: number;
  uncertainty: number;
  derivation: string; // why it changed
}

export interface HypothesisProposedPayload {
  hypothesis_id: string;
}

export interface ReflectionWrittenPayload {
  reflection_id: string;
}

// ----- round 2 payloads -----

export interface LiveAgentMessagePayload {
  text: string;
  in_reply_to_event_id?: string;
}

export interface LiveLearnerMessagePayload {
  text: string;
  intent: 'ask' | 'answer';
}

export interface LiveSessionSummaryPayload {
  summary: string;
  concepts_touched: ConceptId[];
}

/** 二期 下课铃 — 学习者在 Live 房内按下下课铃 (收课宣告落库那一刻,
 *  routes/teaching.ts POST /sessions/:id/declare-close 追加)。决定下课的是
 *  学习者, 合上帷幕的是老师: agent 收到后照约定流程走 summary/反思/complete。 */
export interface LiveLearnerCloseDeclaredPayload {
  live_session_id: string;
  declared_at: string; // ISO
}

export interface ExerciseSubmittedPayload {
  exercise_id: string;
  submission_id: string;
  answer_excerpt: string;
}

export interface ExerciseWithdrawnPayload {
  submission_id: string;
}

export interface ExerciseResubmittedPayload {
  previous_submission_id: string;
  new_submission_id: string;
}

export interface ExerciseGradedPayload {
  submission_id: string;
  score?: number;
  feedback_excerpt: string;
}

// ----- trial upgrade payload (docs/LESSON-BLOCKS-v1.md §2.3) -----

/** `self_check` = no `Expected` field on the trial block (reveal-only,
 *  ungraded); `correct` / `incorrect` = machine-judged against `Expected`. */
export type TrialVerdict = 'correct' | 'incorrect' | 'self_check';

export interface TrialAttemptedPayload {
  lesson_id: string;
  trial_index: number;
  verdict: TrialVerdict;
  attempts: number;
  /** Learner's raw draft text at the moment of this Check — the teacher
   *  needs to see how she actually answered, not just the verdict. */
  draft: string;
}

// ----- Recents 最近接触 payloads (2026-07-30) -----

/** 打开某份文档阅读。documents 仍不是评估表面 (无进度%/无停留时长) — 这个
 *  事件只回答"最近读的是哪一份", 不带任何阅读深度字段。 */
export interface DocumentViewedPayload {
  document_id: string;
}

/** 打开某张导图查看 (含 ?map= 深链直达)。同上, 只记"哪一张", 不记看了多久。 */
export interface MindmapViewedPayload {
  mindmap_id: string;
}

/** 打开复习页 / 在左边 DeckRail 里切到某一组卡 (最近接触二期, 2026-07-30)。
 *
 *  注意与 `review.rated` 的分工: `review.rated` 是评卡这个学习动作本身 (带
 *  rating/答案/用时, 喂 FSRS 与画像); 这枚只回答"她最近在复习哪一组", 一个
 *  字段的评分深度都不带 —— 与 document.viewed / mindmap.viewed 同性质, 只服
 *  务 Recents 的最近性。
 *
 *  `deck_id` 可以是 null: 她停在"全部到期"这一档时并没有选中任何一组具体的
 *  卡, 那就没有可显示的名字, 也没有可深链的对象。deck 在本产品里没有独立的
 *  标题字段 —— deck_id 本身就是人读的名字 (见 review/DeckRail.tsx 直接把它
 *  当行标签渲染), 所以这里不需要再带一个 label。 */
export interface ReviewViewedPayload {
  deck_id: string | null;
  /** 该组卡归属的课程 (按卡片 concept_id 多数投票推出来的, 见 pages/Review.tsx
   *  的 deckCourseId)。推不出来时为 null。目前 Recents 不读它, 留着是因为写
   *  事件时它就在手边, 而事件写下去就补不回来了。 */
  course_id?: CourseId | null;
}

// =========================================================================
// Discriminated union — SessionEvent.
// =========================================================================

export type SessionEvent =
  | (EventEnvelope<SessionStartPayload> & { event_type: 'session.start' })
  | (EventEnvelope<SessionEndPayload> & { event_type: 'session.end' })
  | (EventEnvelope<LessonViewedPayload> & { event_type: 'lesson.viewed' })
  | (EventEnvelope<ReviewRatedPayload> & { event_type: 'review.rated' })
  | (EventEnvelope<ConceptTouchedPayload> & { event_type: 'concept.touched' })
  | (EventEnvelope<QuestionAskedPayload> & { event_type: 'question.asked' })
  | (EventEnvelope<AnswerGivenPayload> & { event_type: 'answer.given' })
  | (EventEnvelope<TeachingInterventionPayload> & { event_type: 'teaching.intervention' })
  | (EventEnvelope<LearningEvidencePayload> & { event_type: 'learning.evidence' })
  | (EventEnvelope<MasteryEstimateChangedPayload> & { event_type: 'mastery.estimate.changed' })
  | (EventEnvelope<HypothesisProposedPayload> & { event_type: 'hypothesis.proposed' })
  | (EventEnvelope<ReflectionWrittenPayload> & { event_type: 'reflection.written' })
  // ----- round 2 -----
  | (EventEnvelope<LiveAgentMessagePayload> & { event_type: 'live.agent_message' })
  | (EventEnvelope<LiveLearnerMessagePayload> & { event_type: 'live.learner_message' })
  | (EventEnvelope<LiveSessionSummaryPayload> & { event_type: 'live.session_summary' })
  | (EventEnvelope<LiveLearnerCloseDeclaredPayload> & { event_type: 'live.learner_close_declared' })
  | (EventEnvelope<ExerciseSubmittedPayload> & { event_type: 'exercise.submitted' })
  | (EventEnvelope<ExerciseWithdrawnPayload> & { event_type: 'exercise.withdrawn' })
  | (EventEnvelope<ExerciseResubmittedPayload> & { event_type: 'exercise.resubmitted' })
  | (EventEnvelope<ExerciseGradedPayload> & { event_type: 'exercise.graded' })
  | (EventEnvelope<TrialAttemptedPayload> & { event_type: 'trial.attempted' })
  | (EventEnvelope<DocumentViewedPayload> & { event_type: 'document.viewed' })
  | (EventEnvelope<MindmapViewedPayload> & { event_type: 'mindmap.viewed' })
  | (EventEnvelope<ReviewViewedPayload> & { event_type: 'review.viewed' });

// =========================================================================
// LearningSession — assembled by the SYSTEM from session events, NOT by agent.
// =========================================================================

export type LearningSessionMode =
  | 'self_study'
  | 'live_teaching'
  | 'review'
  | 'quiz'
  | 'exercise';

export interface LearningSession {
  id: SessionId;
  pair_id: PairId;
  started_at: string;
  ended_at: string | null;
  course_refs: CourseId[];
  concepts_touched: ConceptId[];
  cards_reviewed: FlashcardId[];
  event_count: number;
  agent_summary: string | null;
  teacher_reflection_id: string | null;
  next_actions: string[];
  // ----- round 2 -----
  mode?: LearningSessionMode; // optional 让旧 fixture 仍兼容; W2+ 强制
  skill_used?: string; // agent 派发的 skill 落档
}
