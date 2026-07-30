// Exercise — per-lesson 课后习题 (随堂作业).
//
// TEACHING-SPEC-v1 §3.2: Agent 备课时跟 Lesson 一并出 2-3 道, 学生答完异步等
// agent 批改. ExerciseSubmission 是 4-档 state machine, 支持 withdraw + resubmit.
// 异步批改触发为 push, 不是 cron — "老师定时上班" 体验.

import type { LearnerId } from './pair';
import type { LessonId, ConceptId } from './content';

export type ExerciseId = string & { readonly __brand: 'ExerciseId' };
export type ExerciseSubmissionId = string & { readonly __brand: 'ExerciseSubmissionId' };

export interface Exercise {
  id: ExerciseId;
  lesson_id: LessonId;
  order: number; // 1, 2, 3 in this lesson
  prompt: string;
  reference_answer: string; // agent 备课时一并给参考答案
  expected_concepts: ConceptId[];
  agent_skill_used: string; // 派发的 skill 落档
  created_at: string;
  updated_at: string;
}

// 4-档 state machine — see TEACHING-SPEC §3.2 diagram:
//   draft → submitted → pending_grade → graded
//   draft ← submitted/pending_grade (withdraw 撤回, graded 后不可撤)
//   graded 后只能 resubmit (新建一版, previous_submission_id 链回历史)
export type ExerciseSubmissionStatus = 'draft' | 'submitted' | 'pending_grade' | 'graded';

export interface ExerciseSubmission {
  id: ExerciseSubmissionId;
  exercise_id: ExerciseId;
  learner_id: LearnerId;
  learner_answer: string;
  status: ExerciseSubmissionStatus;

  submitted_at?: string;
  withdrew_at?: string;
  previous_submission_id?: ExerciseSubmissionId;

  // 异步批改后填入
  agent_feedback?: string;
  agent_score?: number; // 0..1, 软评分, 不强制
  graded_at?: string;

  /** 断链修复 (迁移 0044): 本次提交引用的 Live 回答
   *  (teaching_responses.id)。可选+可空 — 服务端在写入口校验存在+同 pair
   *  归属; 历史提交没有这份引用。 */
  live_response_id?: string | null;
}
