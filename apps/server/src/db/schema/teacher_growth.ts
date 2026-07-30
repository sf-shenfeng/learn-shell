// Drizzle: LearnerHypothesis / TeacherReflection — the teacher growth half.
//
// 0018: teacher_reflections grows the
// attribution skeleton — primary/secondary attribution, evidence,
// counterfactual, action_link, weather_expires_at. Columns are nullable at
// the DB layer for backward compat with pre-0018 rows; enforcement that
// these are required for *new* writes lives in code (mcp/server.ts's
// reflect_on_teaching handler), not a NOT NULL constraint — §2
// preamble ("存量行兼容...代码层只对新写入强制").

import { sql } from 'drizzle-orm';
import { pgTable, text, jsonb, timestamp, boolean, doublePrecision, integer } from 'drizzle-orm/pg-core';
import { learner_agent_pairs } from './pair';
import type { HypothesisChange, PrimaryAttribution, ActionLink } from '@learn-shell/contracts';

export const learner_hypotheses = pgTable('learner_hypotheses', {
  id: text('id').primaryKey(),
  pair_id: text('pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  domain: text('domain').notNull(),
  observation: text('observation').notNull(),
  evidence_event_ids: jsonb('evidence_event_ids').$type<string[]>().notNull().default([]),
  counterevidence_event_ids: jsonb('counterevidence_event_ids')
    .$type<string[]>()
    .notNull()
    .default([]),
  confidence: doublePrecision('confidence').notNull(),
  status: text('status').notNull().default('active'),
  written_by_agent_id: text('written_by_agent_id').notNull(),
  from_session_id: text('from_session_id'),
  user_approved: boolean('user_approved'),
  user_note: text('user_note'),
  last_verified_at: timestamp('last_verified_at', { withTimezone: true }),
  // 0041 (假设生命周期): 最近一次证据喂养的时刻。创建/ revise 写当下,
  // reinforce 续期; 存量行回填 = created_at (0041_hypothesis_lifecycle.sql)。
  // 陈旧与否只在读取时按此列现算 (lib/hypothesis-lifecycle.ts), 永不落库。
  // 证据计数不另立列——evidence_event_ids 数组长度即计数。
  last_evidence_at: timestamp('last_evidence_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  allowed_for_teaching: boolean('allowed_for_teaching').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const teacher_reflections = pgTable('teacher_reflections', {
  id: text('id').primaryKey(),
  pair_id: text('pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  from_session_id: text('from_session_id'),
  linked_intervention_event_id: text('linked_intervention_event_id'),
  // 0035 (反思挂锚, W1C): 课粒度锚点。均可空, 不加 FK —— 照
  // bridge_delivery_cursors / acked_message_id 的既定风格(跨前缀 id 只按
  // genId() 字符串存)。存在性 + 同 pair 校验在 mcp/server.ts 的
  // reflect_on_teaching 里做(代码层, 非 DB 约束)。锚自本迁移起生效——存量行
  // (from_session_id 恒 null, 无从回填)保持 null, 历史反思仍是 pair 级记录,
  // 见 0035_reflection_anchor.sql 头注。下游双轨判定见 lib/close-loop-guard.ts。
  lesson_id: text('lesson_id'),
  live_session_id: text('live_session_id'),
  method: text('method').notNull(),
  rationale: text('rationale').notNull(),
  expected_outcome: text('expected_outcome').notNull(),
  actual_evidence: text('actual_evidence').notNull(),
  what_worked: jsonb('what_worked').$type<string[]>().notNull().default([]),
  what_failed: jsonb('what_failed').$type<string[]>().notNull().default([]),
  hypothesis_changes: jsonb('hypothesis_changes')
    .$type<HypothesisChange[]>()
    .notNull()
    .default([]),
  next_action: text('next_action').notNull(),
  // 0018 attribution skeleton (§1-§2). Nullable —
  // pre-0018 rows have none of these; new writes are forced through
  // mcp/server.ts's reflect_on_teaching validation, not a DB constraint.
  primary_attribution: text('primary_attribution').$type<PrimaryAttribution>(),
  secondary_attribution: text('secondary_attribution').$type<PrimaryAttribution>(),
  evidence: text('evidence'),
  counterfactual: text('counterfactual'),
  action_link: jsonb('action_link').$type<ActionLink>(),
  // Only ⑥ (weather) reflections ever set this — brief §1/§5: past-expiry,
  // the row is excluded from every read path (get_context/get_learner_brief/
  // pair://teacher/reflections/HTTP /reflections) and never feeds a hypothesis.
  weather_expires_at: timestamp('weather_expires_at', { withTimezone: true }),
  written_at: timestamp('written_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type LearnerHypothesisRow = typeof learner_hypotheses.$inferSelect;
export type TeacherReflectionRow = typeof teacher_reflections.$inferSelect;

void integer;
