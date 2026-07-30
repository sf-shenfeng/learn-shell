// Drizzle: LearnerFeedback — 现场反馈笔 (迁移 0038)。
//
// 前身是 ritual 时代的周反馈表 (week_of + 四个 1-5 评分)。后改造成
// 事件式反馈账本: 反馈没有专用入口——学习者的日常消息就是入口, agent 在
// 正常对话里识别 issue/idea 并经 record_learner_feedback 落账。
//
// - free_text 存她的原话 (逐字纪律: 存学习者的话, 不是老师的转述)。
// - 挂锚列 (lesson_id / live_session_id / exercise_id / source_message_ref)
//   不建 FK —— 照 0035 reflection_anchor 先例, 存在性 + 同 pair 校验在
//   mcp/server.ts 代码层做; source_message_ref 是自由文本引用 (live 消息
//   可能活在 bridge 事件流里, 没有稳定单表 id), 只存不校验。
// - kind/status 的 CHECK 收口同 lesson_revisions.kind 先例——DB 层硬闸兜底。
// - status 生命周期: open → acknowledged → addressed/declined (addressed/
//   declined 终态)。declined 必须带 status_note (拒绝欠判词——拒绝的理由
//   保护接受的价值), 由 update_feedback_status 在代码层强制。
// - 软牙齿 (裁决 b): open 反馈只在 get_teacher_inbox 发光, 永不阻塞
//   close_lesson_loop。
// - contract_id 自 0038 起可空 (ritual 遗留列, 存量周反馈行保留原值);
//   week_of 仍 NOT NULL (ritual 遗留), 新的现场反馈按落账时刻写入。
import { sql } from 'drizzle-orm';
import { pgTable, text, integer, timestamp, check } from 'drizzle-orm/pg-core';
import { learner_agent_pairs, teaching_contracts } from './pair';

export const learner_feedback = pgTable(
  'learner_feedback',
  {
    id: text('id').primaryKey(),
    pair_id: text('pair_id')
      .notNull()
      .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
    // ritual 遗留 — 0038 起可空, 现场反馈不挂合同。
    contract_id: text('contract_id').references(() => teaching_contracts.id, {
      onDelete: 'cascade',
    }),
    week_of: timestamp('week_of', { withTimezone: true }).notNull(),
    pace: integer('pace'),
    difficulty: integer('difficulty'),
    helpfulness: integer('helpfulness'),
    tone_fit: integer('tone_fit'),
    free_text: text('free_text'),
    suggested_changes: text('suggested_changes'),
    // ---- 现场反馈笔 (迁移 0038) ----
    kind: text('kind').notNull().default('issue'),
    status: text('status').notNull().default('open'),
    status_note: text('status_note'),
    status_changed_at: timestamp('status_changed_at', { withTimezone: true }),
    lesson_id: text('lesson_id'),
    live_session_id: text('live_session_id'),
    exercise_id: text('exercise_id'),
    source_message_ref: text('source_message_ref'),
    submitted_at: timestamp('submitted_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    kindCheck: check('learner_feedback_kind_check', sql`${table.kind} IN ('issue', 'idea')`),
    statusCheck: check(
      'learner_feedback_status_check',
      sql`${table.status} IN ('open', 'acknowledged', 'addressed', 'declined')`
    ),
  })
);

export type LearnerFeedbackRow = typeof learner_feedback.$inferSelect;
