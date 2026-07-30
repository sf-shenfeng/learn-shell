// Drizzle: Live Teaching tables (Stage 7c, 2026-06-29).
// Stage 7d-fix (2026-06-30): rolled back layer/context_snapshot —
// AdHoc moved to its own ad_hoc_threads / ad_hoc_messages tables.
// bridge_states table for agent keep-alive remains.
//
// Port of the predecessor hub's backend/init_db.py teaching_sessions /
// teaching_moves / teaching_responses tables. Field names + enum string
// values kept identical to Hub so the protocol is shared across surfaces.

import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { learner_agent_pairs } from './pair';
import type {
  AwaitingRole,
  LiveContextType,
  LiveSessionStatus,
  MoveType,
  ResponseInputType,
  ResponseKind,
} from '@learn-shell/contracts';

// 迁移 0036 (红队第六轮针一, 2026-07-20): 部分唯一索引
// "live_sessions_active_context_uniq" on (pair_id, context_type, context_id)
// WHERE status='active' —— 开课原子去重, 同一课同一时刻只许一间 active 教室
// 存在。这条约束**不**在下面的 drizzle 表定义里表达 (schema 层不表达,
// 以迁移为准): 本仓 uniqueIndex 的既有先例(下方 teaching_moves /
// bridge_delivery_cursors 两处)都是全表唯一、无 WHERE 子句, 部分索引在这个
// 仓库里没有可抄的写法先例, 故不在这里发明一份没走过 drizzle-kit generate
// 检验的用法——约束的权威定义只在 drizzle/0036_live_session_active_unique.sql,
// 那份迁移文件头注有完整的动机 + 迁移前提检查结论。
export const live_sessions = pgTable('live_sessions', {
  id: text('id').primaryKey(),
  pair_id: text('pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  context_type: text('context_type').$type<LiveContextType>().notNull(),
  context_id: text('context_id').notNull(),
  context_preview: text('context_preview'),
  goal: text('goal'),
  status: text('status').$type<LiveSessionStatus>().notNull().default('active'),
  awaiting_role: text('awaiting_role').$type<AwaitingRole>().notNull().default('agent'),
  summary: text('summary'),
  teacher_reflection: text('teacher_reflection'),
  next_action: text('next_action'),
  started_at: timestamp('started_at', { withTimezone: true }).notNull().default(sql`now()`),
  ended_at: timestamp('ended_at', { withTimezone: true }),
  last_activity_at: timestamp('last_activity_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  // 下课铃 (二期, 迁移 0042) — 学习者收课宣告的机器正身。null = 本场
  // 还没人摇铃。唯一写点: POST /api/teaching/sessions/:id/declare-close
  // (learner 侧, 幂等 — 已宣告的重复请求返回首次时刻, 不重写)。complete
  // 门禁读这一列: 为空则 MCP live_session_complete / REST POST /complete
  // 一律 CONFLICT —— 决定下课的是学习者, 合上帷幕的是老师 (lib/
  // learner-close-declaration.ts)。cancel 不受此门 (取消≠收官)。
  learner_close_declared_at: timestamp('learner_close_declared_at', { withTimezone: true }),
});

export const teaching_moves = pgTable(
  'teaching_moves',
  {
    id: text('id').primaryKey(),
    session_id: text('session_id')
      .notNull()
      .references(() => live_sessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    move_type: text('move_type').$type<MoveType>().notNull(),
    content: text('content').notNull(),
    response_kind: text('response_kind').$type<ResponseKind>().notNull().default('none'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    source_type: text('source_type'),
    source_id: text('source_id'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    sessionSeqUnique: uniqueIndex('teaching_moves_session_seq_uniq').on(
      t.session_id,
      t.seq
    ),
  })
);

export const teaching_responses = pgTable('teaching_responses', {
  id: text('id').primaryKey(),
  session_id: text('session_id')
    .notNull()
    .references(() => live_sessions.id, { onDelete: 'cascade' }),
  move_id: text('move_id')
    .notNull()
    .references(() => teaching_moves.id, { onDelete: 'cascade' }),
  /** Client-supplied uuid for idempotency; unique index dedupes retries. */
  client_response_id: text('client_response_id').notNull().unique(),
  content: text('content').notNull(),
  input_type: text('input_type').$type<ResponseInputType>().notNull().default('text'),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// Stage 7d: agent bridge keep-alive. One row per pair_id.
// Stage 7d-fix: + agent-self-reported context_status fields. All optional.
// 指示灯全拆 (2026-07-24): context_* 五列已退役——heartbeat 不再收
// context_status, 服务端不再算 green/yellow/red/stale/unknown 等级, 读路径
// 不再输出 context 视图。列本身留着不删 (无害数据, 省一次纯删除迁移),
// 代码停止读写它们。
export const bridge_states = pgTable('bridge_states', {
  pair_id: text('pair_id')
    .primaryKey()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  last_heartbeat_at: timestamp('last_heartbeat_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  online_until: timestamp('online_until', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  /** Agent's naive-estimated cumulative input tokens this CC session. */
  context_used_tokens: integer('context_used_tokens'),
  /** Agent's context window upper bound (200k / 1M etc). */
  context_total_tokens: integer('context_total_tokens'),
  /** 0..100 percent used (server can derive but agent can override). */
  context_used_pct: integer('context_used_pct'),
  /** How many times compact has fired this CC session. */
  context_compact_count: integer('context_compact_count').notNull().default(0),
  /** Last time agent reported context status (separate from heartbeat). */
  last_context_report_at: timestamp('last_context_report_at', { withTimezone: true }),
});

// Stage 7e: rolling mid-lesson snapshot for compact-recovery.
export const mid_lesson_snapshots = pgTable('mid_lesson_snapshots', {
  id: text('id').primaryKey(),
  session_id: text('session_id')
    .notNull()
    .references(() => live_sessions.id, { onDelete: 'cascade' }),
  after_turn_n: integer('after_turn_n').notNull(),
  rolling_summary: text('rolling_summary').notNull(),
  current_direction: text('current_direction').notNull(),
  weak_signals: jsonb('weak_signals').$type<string[]>().notNull().default([]),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
});

// Live 2.0: server-side delivery cursor (0029_bridge_delivery_cursors).
//
// One row per (pair_id, consumer_id) — "how far this consumer has been
// acked to" for the bridge event stream computed by lib/live-wait.ts's
// computeBridgeWaitEvents(). Consumer-scoped (not a single per-pair cursor)
// because more than one watcher can legitimately trail the same pair's
// events at different paces (e.g. a live-watch.py instance and a second
// ad-hoc MCP session) — see lib/live-wait.ts header comment for the full
// persistence/ack semantics (implicit ack: the *next* wait call's `since`
// is what advances the stored cursor, not delivery itself).
//
// consumer_id is caller-minted and opaque to the server (no registry table,
// no FK) — same posture as ad_hoc_messages.client_message_id: whatever
// string the caller reliably reuses across its own restarts (scripts/
// live-watch.py mints one persisted alongside its seen-cache dir).
export const bridge_delivery_cursors = pgTable(
  'bridge_delivery_cursors',
  {
    id: text('id').primaryKey(),
    pair_id: text('pair_id')
      .notNull()
      .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
    consumer_id: text('consumer_id').notNull(),
    /** Last event_id this consumer has acked (empty string = never acked /
     *  "from the beginning"). Never auto-advanced on delivery — only a
     *  subsequent wait call's explicit `since` writes this (先送达后推进). */
    cursor_event_id: text('cursor_event_id').notNull().default(''),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pairConsumerUnique: uniqueIndex('bridge_delivery_cursors_pair_consumer_uniq').on(
      t.pair_id,
      t.consumer_id
    ),
  })
);

export type LiveSessionRow = typeof live_sessions.$inferSelect;
export type TeachingMoveRow = typeof teaching_moves.$inferSelect;
export type TeachingResponseRow = typeof teaching_responses.$inferSelect;
export type BridgeStateRow = typeof bridge_states.$inferSelect;
export type MidLessonSnapshotRow = typeof mid_lesson_snapshots.$inferSelect;
export type BridgeDeliveryCursorRow = typeof bridge_delivery_cursors.$inferSelect;
