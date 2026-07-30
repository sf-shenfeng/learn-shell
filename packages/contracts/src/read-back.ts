// Read-back payload shapes for the MCP content read-back tools:
// get_lesson / get_exercise / get_submission — the "eyes" that close the
// write-strong/read-weak gap (an agent could add_lesson/add_exercise but had
// no first-class way to read back what it taught; resume-teaching cold-start
// was content-blind, and 军规 "批改前先审教材" had no legal channel).
//
// Additive only — nothing existing depends on these types; the MCP server
// (apps/server/src/lib/read-back.ts) builds them, calling agents consume them
// out of the success envelope's `data` field.
//
// Token economy (三公理: 默认紧凑, 按需 verbose, 无损红线):
// LessonReadback is compact by default — structure + metadata + an excerpt,
// with `content_markdown` present only when the caller explicitly asked for
// the full text (include_content: true).

import type { SourceRef } from './envelope';
import type { ExerciseSubmissionStatus } from './exercise';

/** One concept row hanging off a lesson — id + name only (pull the full
 *  concept via existing channels once you know which one you need). */
export interface LessonReadbackConceptRef {
  concept_id: string;
  name: string;
}

/** One exercise row hanging off a lesson — enough to decide whether to
 *  get_exercise it, not the exercise itself. */
export interface LessonReadbackExerciseRef {
  exercise_id: string;
  order: number;
  tags: string[];
}

export interface LessonReadback {
  lesson_id: string;
  course_id: string;
  course_topic: string;
  title: string;
  order: number;
  summary: string | null;
  revision: number;
  /** published_at IS NOT NULL — draft lessons are teacher-side only. */
  published: boolean;
  published_at: string | null;
  estimated_minutes: number;
  /** 脑图裁量条款等 modality 声明 (lessons.modality_declarations)。 */
  modality_declarations: Record<string, string> | null;
  source_refs: SourceRef[];
  concepts: LessonReadbackConceptRef[];
  exercises: LessonReadbackExerciseRef[];
  /** Full length of content_markdown in characters (0 when the lesson has no
   *  content yet) — always present so a compact read still sizes the text. */
  content_chars: number;
  /** Leading slice of the content for orientation (compact mode's "紧凑正文");
   *  null when the lesson has no content. */
  content_excerpt: string | null;
  /** Full lesson text — present only when include_content: true was passed. */
  content_markdown?: string | null;
}

export interface ExerciseReadback {
  exercise_id: string;
  lesson_id: string;
  lesson_title: string;
  course_id: string;
  order: number;
  prompt: string;
  /** 评分钥匙 — teacher-side secret: do not relay verbatim to the
   *  learner. */
  reference_answer: string;
  expected_concepts: string[];
  tags: string[];
}

export interface SubmissionReadback {
  submission_id: string;
  exercise_id: string;
  lesson_id: string;
  course_id: string;
  /** Leading slice of the exercise prompt so the answer reads in context
   *  without a second get_exercise round-trip. */
  exercise_prompt_excerpt: string;
  learner_answer: string;
  status: ExerciseSubmissionStatus;
  submitted_at: string | null;
  graded_at: string | null;
  agent_score: number | null;
  agent_feedback: string | null;
  /** 元认知把握度 (可空 — 学习者可跳过, 历史行不追溯)。 */
  confidence: string | null;
  previous_submission_id: string | null;
  /** 断链修复 (迁移 0044): 提交引用的 Live 回答 (teaching_responses.id),
   *  没引用时 null——批改前想看 Live 原话, 拿它去 live_session_get 对应场次。 */
  live_response_id: string | null;
}
