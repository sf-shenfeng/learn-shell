// Reminder — TEACHING-SPEC §3.8 + §5.
//
// 4 通道: in_app / push / ical / email
// DND 窗口在 TeachingContract.do_not_disturb 上, scheduler 在窗口内不发.
// 备课完成 (setup_complete) 是 reminder 系统的首次实际使用场景.

import type { PairId } from './pair';

export type ReminderId = string & { readonly __brand: 'ReminderId' };

export type ReminderType =
  | 'lesson_due'
  | 'review_due'
  | 'feedback_invitation'
  | 'setup_complete';

export type ReminderChannel = 'in_app' | 'push' | 'ical' | 'email';

export interface Reminder {
  id: ReminderId;
  pair_id: PairId;
  type: ReminderType;
  scheduled_for: string; // ISO ts (setup_complete 为 server 即时触发)
  channel: ReminderChannel;
  payload?: Record<string, unknown>; // 例: { lesson_id, due_count } / { contract_id }
  fired_at?: string;
  dismissed_at?: string;
  created_at: string;
}
