// Learning content objects — Course / Lesson / Concept / Flashcard / SourceReference.
//
// Generated-by-agent content MUST carry `generated_by_agent_id` + `generated_from`
// so the learner can always ask: why should I trust this?

import type { PairId } from './pair';
import type { SourceRef } from './envelope';

export type CourseId = string & { readonly __brand: 'CourseId' };
export type LessonId = string & { readonly __brand: 'LessonId' };
export type ConceptId = string & { readonly __brand: 'ConceptId' };
export type FlashcardId = string & { readonly __brand: 'FlashcardId' };
export type DeckId = string & { readonly __brand: 'DeckId' };

export interface Course {
  id: CourseId;
  pair_id: PairId;
  topic: string;
  description: string;
  structure: {
    lesson_ids: LessonId[];
  };
  generated_by_agent_id: string | null;
  generated_from: SourceRef[];
  syllabus_version: string | null;
  /** 迁移 0032 (学习者钦定设计) — 建课时的第一问"一共几节"。null = 未定
   *  (旧课兼容口径; 也是尚未回答这一问的新课的默认态). 非空时参与
   *  goal_completion_ready 判定 (2026-07-20 由旧 ready_to_complete 拆分而来),
   *  见 apps/server/src/lib/course-completion.ts。 */
  planned_lesson_count: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * asset counts a course-delete would sweep up, for the
 * confirm-before-you-nuke-it UI. `flashcards` / `syllabus_mappings` /
 * `mindmap_associations` are the three cascade-blind counts (those tables
 * reference course/lesson ids via unconstrained text columns, not FKs — see
 * db/schema/content.ts, db/schema/syllabus.ts, db/schema/mindmap.ts); the
 * rest (lessons/concepts/exercises/quizzes) are FK-cascaded on delete but
 * still worth surfacing so the count isn't a surprise.
 */
export interface CourseFootprint {
  lessons: number;
  concepts: number;
  exercises: number;
  flashcards: number;
  quizzes: number;
  syllabus_mappings: number;
  mindmap_associations: number;
}

export interface Lesson {
  id: LessonId;
  course_id: CourseId;
  order: number;
  title: string;
  /** Stage 6b: one-sentence "what this lesson covers" — populated at outline
   * time, visible in nav even when status='proposed'. */
  summary?: string;
  /** Stage 6b: optional — proposed lessons have no content yet. */
  content_markdown?: string;
  // 迁移 0030: status(生成态) 与 needs_review(验尺信号) 两列拆除 — 侦察实证
  // status 从未被真实写路径写过(75 行全 null), 且与 lesson_progress.state
  // 撞名, 是病根本身; needs_review 未接线, 验尺红黄绿判定现算于
  // apps/server/src/lib/validate-prep-core.ts, 从不回写这一列。原
  // `LessonStatus` 类型随之一并移除(唯一用途就是这个字段)。
  concept_ids: ConceptId[];
  source_refs: SourceRef[];
  estimated_minutes: number;
  skill_used?: string; // round 2: agent 备课时派发的 skill 落档 (e.g. "teach-cfa-v2")
  /** update_lesson: revision pass 回写. Starts at 1; bumped on every
   * update_lesson call. Optional for legacy fixtures that predate the field. */
  revision?: number;
  /** Publish Gate: 上架时间戳。null/缺省 = 草稿(仅教师/MCP 侧可见);
   * 非空 ISO 串 = 已发布(publish_lesson 跑完验尺才写)。学习者读端点按此过滤。 */
  published_at?: string | null;
}

/**
 * 迁移 0033 — 双轨修订: 学习者只该看见"因她的学习而改"的修订(teaching),
 * 工程性修订(格式/门禁/重构/错别字)入库留痕但对学习者隐身(technical)。
 * 判据见 mcp/server.ts update_lesson 的 revision_kind 参数说明: "这次改动
 * 是她教出来的, 还是机器逼出来的?" 缺省 'teaching' —— 发布后的修订默认面向
 * 学习者, 宁可多呈现不可偷藏。
 */
export type LessonRevisionKind = 'teaching' | 'technical';

export const LESSON_REVISION_KINDS: LessonRevisionKind[] = ['teaching', 'technical'];

/**
 * update_lesson: one row per revision — the version that got
 * replaced. `agent_seed_snapshot` 之于脑图 = `lesson_revisions` 之于课文 —
 * evidence-visible, never silent.
 */
export interface LessonRevision {
  id: string;
  lesson_id: LessonId;
  revision: number; // the version number that was replaced
  prev_content_markdown: string | null;
  prev_title: string;
  reason: string;
  evidence: string | null;
  revised_by: string;
  revised_at: string;
  /** 迁移 0033 — 'teaching' | 'technical'. 缺省 'teaching' (老行/未传参一律
   *  面向学习者)。见 LessonRevisionKind 头注。 */
  kind: LessonRevisionKind;
}

export interface Concept {
  id: ConceptId;
  lesson_id: LessonId;
  course_id: CourseId;
  name: string;
  short_definition: string;
  source_refs: SourceRef[];
  flashcard_ids: FlashcardId[];
}

// FSRS state — system estimates, NOT facts. Agent must go through
// `request_schedule_override` to change these.
export interface FSRSState {
  due_at: string;
  stability: number;
  difficulty: number;
  last_review_at: string | null;
  review_count: number;
  retrievability: number; // 0..1 — mastery estimate = 1 - retrievability (ROADMAP-v2.1 W3)
  // ts-fsrs fidelity fields (2026-07-02, real scheduler wire-up). Optional so
  // legacy cards / fixtures stay valid; approximated on first real review.
  state?: number; // ts-fsrs State enum: 0 New / 1 Learning / 2 Review / 3 Relearning
  lapses?: number;
  scheduled_days?: number;
}

export interface Flashcard {
  id: FlashcardId;
  pair_id: PairId;
  concept_id: ConceptId | null;
  deck_id: DeckId;
  front: string;
  back: string;
  tags: string[];
  source_refs: SourceRef[];
  fsrs_state: FSRSState;
  /** Stage 7e-cards (2026-07-01): user can pause a card. Paused cards are
   * skipped by the review queue but stay in the deck for management. */
  paused?: boolean;
  /** 闪卡激活门 (2026-09-02, 迁移 0045): 课时闸。挂了 concept 的课程卡出生
   * 休眠 (false), 学完那一课才被唤醒; concept_id 为空的卡 (导入/手写) 出生
   * 即激活。未激活的卡不进复习队列, 但在 Cards 页等管理视图里照常全量可见。
   * 可选 —— 缺字段按 DDL 默认 (true) 解读, 与 `paused` 同姿态。 */
  activated?: boolean;
  created_at: string;
  updated_at: string;
}
