// LearnerFeedback — 学生对老师教学的周一次反馈 (TEACHING-SPEC §3.7).
//
// 反馈影响:
//   - 累积喂入 TeacherReflection.what_failed / next_action
//   - 极端反馈 (连续 2 周 tone_fit < 2) 触发 contract.feedback_tone 重谈

import type { PairId, ContractId } from './pair';

export type LearnerFeedbackId = string & { readonly __brand: 'LearnerFeedbackId' };

export interface LearnerFeedback {
  id: LearnerFeedbackId;
  pair_id: PairId;
  contract_id: ContractId;
  week_of: string; // ISO date, 这一周的开始日

  // 评分 1-5 (null = 跳过这一项)
  pace: number | null;
  difficulty: number | null;
  helpfulness: number | null;
  tone_fit: number | null;

  free_text?: string;
  suggested_changes?: string;

  submitted_at: string;
}
