// Drizzle tables for Pair / Contract / Learner / Agent.
//
// Maps onto packages/contracts/src/pair.ts (round 2 lock).
// Branded ids on the TS side become plain text PKs on the SQL side.

import { sql } from 'drizzle-orm';
import { pgTable, text, integer, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';
import type {
  ContractIntensity,
  ContractInteractionMode,
  ContractContentModality,
  ContractCadence,
  ContractPace,
  ContractReminderChannel,
  ContractReminderType,
  ContractSetupStatus,
  ContractSetupStep,
  FeedbackTone,
  PreferredTimeOfDay,
  SkillRef,
} from '@learn-shell/contracts';
import type { ConfidenceAnchorConfig } from '../../lib/confidence';
import type { ContractSourceMaterial } from '../../lib/source-material';

export const learners = pgTable('learners', {
  id: text('id').primaryKey(),
  display_name: text('display_name').notNull(),
  preferences: jsonb('preferences')
    .$type<{ timezone: string; locale: string; learning_style_notes?: string }>()
    .notNull(),
  // 语言合同 (迁移 0044): 学习者可见文本用哪种语言, 归学习者所有。
  // 此前只藏在 preferences.locale (jsonb) 里, 读写归一到这一列: 迁移回填自
  // preferences->>'locale', 新写入 (registerLearner / create_pair 的 locale
  // 参数) 双写保持 preferences 形状兼容, 读方 (buildIdentity → brief) 只读
  // 这一列。可空——学习者从未表达过语言偏好时是 null, 不是猜一个。
  locale: text('locale'),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  display_name: text('display_name').notNull(),
  provider: text('provider').notNull(),
  model_family: text('model_family'),
  capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
  identity_note: text('identity_note'),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const learner_agent_pairs = pgTable('learner_agent_pairs', {
  id: text('id').primaryKey(),
  learner_id: text('learner_id')
    .notNull()
    .references(() => learners.id, { onDelete: 'cascade' }),
  agent_id: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'restrict' }),
  established_at: timestamp('established_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  active: boolean('active').notNull().default(true),

  // 首跑入学 (迁移 0042) — 样板间户口。demo pair = 给开源陌生人装机
  // 头十分钟的展厅, 显式可选, 永不作为真实关系的前置。参与默认 pair 选择:
  // 一切"当前 pair"隐式解析按 (is_demo ASC, established_at ASC) 排序 ——
  // 真 pair 永远优先于样板间当选"当前关系" (资历优先之上叠身份优先)。
  // 写入方: db:seed(:demo) 写 true; MCP create_pair(唯一真入学正门)写 false。
  is_demo: boolean('is_demo').notNull().default(false),

  // Learner Model 批0 — 观察禁区
  // 登记簿. Deliberately pair-scoped, NOT reusing teaching_contracts'
  // pre-existing `forbidden_observations` column: a pair can carry several
  // simultaneously-active contracts (see Settings.tsx CertificateSection's
  // comment), so a per-contract list can't answer "is this category
  // forbidden for this learner" without picking one contract arbitrarily.
  // This registry is the one list that governs every profile-writing code
  // path via lib/observation-gate.ts, independent of any single contract's
  // negotiated terms. Empty by default — no observation restrictions unless negotiated.
  forbidden_observations: jsonb('forbidden_observations').$type<string[]>().notNull().default([]),

  // Learner Model 批1 — 把握度模式总开关 (可选功能, 默认开).
  // Off = 采集层整体不写入 (与禁区同源语义, 非采后隐藏) — see observation-gate.ts.
  // changed_at 留痕, 让校准曲线的样本区间对得上"这段时间为什么没有新样本".
  confidence_mode_enabled: boolean('confidence_mode_enabled').notNull().default(true),
  confidence_mode_changed_at: timestamp('confidence_mode_changed_at', { withTimezone: true }),

  // Confidence 主权立法 (迁移 0031, 学习者裁决版) — 三档按钮的词义映射锚值,
  // 归学习者所有. 默认词义诚实映射: guess/没把握=40, likely/偏有把握=70,
  // certain/很稳=100 (取代旧默认 35/65/90 —— 那组值把"很稳"打
  // 折读成 90%, 是系统替学习者改口, 已被裁决推翻). 学习者可在 Settings 里
  // 调整这三个数(0-100, 严格递增), 走 PATCH /pairs/:id/confidence-anchors
  // (routes/write.ts) —— 教师侧 MCP 工具/resource/brief 一律不读这一列,
  // 见 lib/confidence-anchors.ts 顶部注释. 按下按钮那一刻用*当刻*这份配置把
  // 序数折算成 exercise_submissions.confidence_pct / 模拟卷 answer.confidence_pct
  // 写死——事后改锚值不重写历史行(历史是历史), 只影响之后的新提交。
  confidence_anchor_pct: jsonb('confidence_anchor_pct')
    .$type<ConfidenceAnchorConfig>()
    .notNull()
    .default({ guess: 40, likely: 70, certain: 100 }),
});

export const teaching_contracts = pgTable('teaching_contracts', {
  id: text('id').primaryKey(),
  pair_id: text('pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  goal: text('goal').notNull(),
  time_range: jsonb('time_range')
    .$type<{ start: string; end_target?: string }>()
    .notNull(),
  success_criteria: jsonb('success_criteria').$type<string[]>().notNull().default([]),
  agent_read_scopes: jsonb('agent_read_scopes').$type<string[]>().notNull().default([]),
  agent_write_scopes: jsonb('agent_write_scopes').$type<string[]>().notNull().default([]),
  feedback_tone: jsonb('feedback_tone').$type<FeedbackTone>().notNull(),
  human_approval_required: jsonb('human_approval_required')
    .$type<string[]>()
    .notNull()
    .default([]),
  forbidden_observations: jsonb('forbidden_observations')
    .$type<string[]>()
    .notNull()
    .default([]),
  // 迁移 0030: active 列拆除 (退休列) — 唯一写点是 propose_contract
  // 写死 false, 从未被任何真实读路径消费; "当前合约"选择早已改用 setup_status
  // (见 apps/server/src/lib/currentContract.ts)。
  // 迁移 0027 (Void, not delete — 审计留痕): voided = voided_at IS NOT NULL.
  // void_reason 记录作废理由原文. 作废权双方都有——学习者点(证书区/档案区),
  // agent 走 MCP void_contract 工具(调用前必须取得学习者逐字同意). 驱动
  // "当前合约"选择排除作废行的信号是 voided_at(见 lib/currentContract.ts 的
  // isCurrentEligible)。两列均可空 — null 表示从未作废。
  voided_at: timestamp('voided_at', { withTimezone: true }),
  void_reason: text('void_reason'),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),

  // round 2 preferences
  intensity: text('intensity').$type<ContractIntensity>().notNull(),
  interaction_mode: text('interaction_mode').$type<ContractInteractionMode>().notNull(),
  content_modality: text('content_modality').$type<ContractContentModality>().notNull(),
  weekly_capacity_hours: integer('weekly_capacity_hours'),
  preferred_time_of_day: jsonb('preferred_time_of_day').$type<PreferredTimeOfDay[]>(),
  // Stage 3 (2026-06-29): nullable; old rows leave it null.
  pace: text('pace').$type<ContractPace>(),
  // Contract 2.0 cadence 条款 (迁移 0025): 定时/碎片化节奏 +
  // 固定时段 + 提醒偏好 + auto_duty。可空——未谈节奏条款的合同留 null。
  // 与上面的 pace(粗粒度频次分类)并存, 不是替换。见
  // packages/contracts/src/pair.ts ContractCadence 的完整语义注释。
  cadence: jsonb('cadence').$type<ContractCadence>(),

  // 自带教材条款 (迁移 0040): 学习者自带教科书 (EPUB/PDF) 时,
  // 立约对话谈定的教材条款 {title, author?, year?, reliance:'strict'|
  // 'anchored'|'inspired'}。可空——未谈教材的合约恒 null。合同是文书不是
  // 引擎: 这里只记条款; 行为语义住 recipes (first-contract-and-lesson /
  // lesson-prep 教材模式), brief 亮灯在 lib/context-brief.ts。内层形状不设
  // CHECK, 校验在写入口 (lib/source-material.ts validateSourceMaterialArg,
  // 同 cadence 的路数)。LS 不解析文件——书由 agent 宿主读, agent 拆解。
  source_material: jsonb('source_material').$type<ContractSourceMaterial>(),

  // round 2 reminders
  accepts_reminders: boolean('accepts_reminders').notNull().default(true),
  reminder_channels: jsonb('reminder_channels').$type<ContractReminderChannel[]>(),
  reminder_types: jsonb('reminder_types').$type<ContractReminderType[]>(),
  do_not_disturb: jsonb('do_not_disturb').$type<{ start: string; end: string }>(),
  ical_subscription_url: text('ical_subscription_url'),

  // round 2 setup tracking
  setup_status: text('setup_status').$type<ContractSetupStatus>().notNull().default('draft'),
  setup_started_at: timestamp('setup_started_at', { withTimezone: true }),
  setup_completed_at: timestamp('setup_completed_at', { withTimezone: true }),
  setup_steps: jsonb('setup_steps').$type<ContractSetupStep[]>(),
  // Stage 6a (2026-06-29): frozen skill workflow snapshot at Establish time.
  skill_stack: jsonb('skill_stack').$type<SkillRef[]>(),
  // Stage 6b (2026-06-29): Course id generated at outline time. Nullable
  // until the user clicks "Generate outline".
  course_id: text('course_id'),

  // 迁移 0030 (State 2.0, 文书三幕剧: 立约 → 履约 → 结业) — 合约完成态.
  /** 这份合约名下实际教过的课程清单 (course_id 数组) — 结业时回望"这份合约
   *  到底教了什么"的证据, 不是许可范围声明。 */
  covered_course_ids: jsonb('covered_course_ids').$type<string[]>().notNull().default([]),
  /** null = 未结业。establish(签约)/void(作废, 迁移 0027) 之外的第三种终态,
   *  与作废并列而非互斥的"善终"通道。 */
  completed_at: timestamp('completed_at', { withTimezone: true }),
  /** 结业词 — 结业那一刻留的一句话, 可空(只有真正结业的合约才写)。 */
  completion_note: text('completion_note'),
});

export type LearnerRow = typeof learners.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type PairRow = typeof learner_agent_pairs.$inferSelect;
export type ContractRow = typeof teaching_contracts.$inferSelect;
