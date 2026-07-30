// Drizzle: 异步师生关系状态机数据层 — 完成状态机 (§6) / 改课三律落点 (§4) /
// 回执制 (§5) / 知情跳过档案 (§2)。2026-07-11 施工批,
// 本单只做后端数据层,前端(课页地图/状态徽章/宣布按钮 UI)另单。
//
// lesson_progress 是唯一携带状态机的表 — one row per (pair_id, lesson_id)。
// state 语义 (§6):
//   not_started → in_progress → completed_declared → closed
// completed_declared 只能由学习者"宣布已学完"这一动作写 (declared_at +
// checklist_snapshot，核对单现算，允许带缺口宣布)；closed 只能由
// close_lesson_loop (批改完成 + 回执送达) 写，是教学闭环的终态，不可逆。
//
// 知情跳过 (§2)：设计文档允许"若现有事件管线不便，可并入 lesson_progress 的
// jsonb 记录"。现有 SessionEventType (schema/session.ts) 是 apps/web 也在消费
// 的封闭判别式联合，往里加新分支是要牵前端穷尽 switch 的破坏性变更 — 这批不碰
// apps/web，所以选这条设计文档明说允许的退路：跳过事件记在
// lesson_progress.prerequisite_skips 这个 jsonb 数组里 (一课可能被带着不同缺口
// 跳着进入多次，故用数组不是单值)。
//
// lesson_patches 是改课三律(§4)"学习中"(teacher_note)/"已学完"(erratum) 两档
// 的落点 — 未开始的课不走这里，直接 update_lesson 整改。三律边界的运行时校验
// 交给应用层 (add_lesson_patch 的 description + 未来 UI 判定)，这里的 CHECK
// 只兜 kind 枚举本身。
//
// lesson_loop_receipts 是 §5 回执制的落点全集 — 七种封闭枚举，"不许发明新
// 黑箱"由 close_lesson_loop 的运行时校验 + 这里的 DB CHECK 双重把关 (同 lesson_
// patches 的双保险风格)。

import { sql } from 'drizzle-orm';
import { pgTable, text, integer, jsonb, timestamp, check, uniqueIndex } from 'drizzle-orm/pg-core';
import { learner_agent_pairs } from './pair';
import { lessons } from './content';
import type {
  LessonProgressState,
  LessonChecklistSnapshot,
  PrerequisiteSkipEvent,
  LessonPatchKind,
  LessonLoopReceiptKind,
} from '@learn-shell/contracts';

export const lesson_progress = pgTable(
  'lesson_progress',
  {
    id: text('id').primaryKey(),
    pair_id: text('pair_id')
      .notNull()
      .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
    lesson_id: text('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    state: text('state').$type<LessonProgressState>().notNull().default('not_started'),
    declared_at: timestamp('declared_at', { withTimezone: true }),
    closed_at: timestamp('closed_at', { withTimezone: true }),
    checklist_snapshot: jsonb('checklist_snapshot').$type<LessonChecklistSnapshot>(),
    prerequisite_skips: jsonb('prerequisite_skips')
      .$type<PrerequisiteSkipEvent[]>()
      .notNull()
      .default([]),
    // 空转防护 check ② (迁移 0023): 关课认知更新逃生舱。close_lesson_
    // loop 时若本课既无 post_lesson_evaluation 也无 hypothesis_update 回执, 老师
    // 须显式传 no_cognitive_update_reason 声明"本课无认知更新及原因", 写入这里
    // 作为关课记录(回执枚举是封闭七种、加不了第八种, 故落在 progress 这条关课行上)。
    no_cognitive_update_reason: text('no_cognitive_update_reason'),
    // 迁移 0037 (2026-07-20, 学习者裁决第三针) — declare-completed 的 checklist
    // 页数此前按"当前停留页"算 (学完全部翻回第 4 页复习再声明, 快照记成
    // 4/12), 病根是只信一个瞬时的当前页号。这列把"到过哪些页"记成一个集合
    // (页码去重, 只增不减——见 routes/write.ts POST /lessons/:id/progress/touch
    // 的合并写法与头注), declare-completed 现在用这个集合的并集大小算页数,
    // 不再相信调用那一刻恰好停在哪页。回看是美德不是倒退——进度记足迹, 不记
    // 立足点。
    pages_visited: jsonb('pages_visited').$type<number[]>().notNull().default([]),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    pairLessonUnique: uniqueIndex('lesson_progress_pair_lesson_uniq').on(
      table.pair_id,
      table.lesson_id
    ),
  })
);

export const lesson_patches = pgTable(
  'lesson_patches',
  {
    id: text('id').primaryKey(),
    lesson_id: text('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    pair_id: text('pair_id')
      .notNull()
      .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<LessonPatchKind>().notNull(),
    body: text('body').notNull(),
    anchor: text('anchor'),
    source_attribution: text('source_attribution'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    kindCheck: check('lesson_patches_kind_check', sql`${table.kind} IN ('teacher_note', 'erratum')`),
  })
);

export const lesson_loop_receipts = pgTable(
  'lesson_loop_receipts',
  {
    id: text('id').primaryKey(),
    pair_id: text('pair_id')
      .notNull()
      .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
    lesson_id: text('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<LessonLoopReceiptKind>().notNull(),
    description: text('description').notNull(),
    ref_id: text('ref_id'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    kindCheck: check(
      'lesson_loop_receipts_kind_check',
      sql`${table.kind} IN ('exercise_feedback', 'forward_revision', 'teacher_note', 'erratum', 'flashcard_change', 'hypothesis_update', 'journal_entry')`
    ),
  })
);

// 迁移 0030: 修订已读回执 (服务端真相, 替换 web localStorage) — "这个学习者
// 把这节课读到第几版了"。此前这个状态活在 web 端 localStorage 里, 换设备/
// 清缓存就丢, 也没法在 get_context/教师端读到"学习者是不是还没看过我刚改的
// 这版"。upsert 更新 revision + seen_at, 唯一索引 (pair_id, lesson_id) 是
// 这行"已读到第几版"的落点。pair_id 不建 FK(同 live_session_evaluations 风格,
// 只锚定资源本身 lesson_id)。
export const lesson_revision_seen = pgTable(
  'lesson_revision_seen',
  {
    id: text('id').primaryKey(),
    pair_id: text('pair_id').notNull(),
    lesson_id: text('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    seen_at: timestamp('seen_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    pairLessonUnique: uniqueIndex('lesson_revision_seen_pair_lesson_uniq').on(
      table.pair_id,
      table.lesson_id
    ),
  })
);

export type LessonProgressRow = typeof lesson_progress.$inferSelect;
export type LessonPatchRow = typeof lesson_patches.$inferSelect;
export type LessonLoopReceiptRow = typeof lesson_loop_receipts.$inferSelect;
export type LessonRevisionSeenRow = typeof lesson_revision_seen.$inferSelect;
