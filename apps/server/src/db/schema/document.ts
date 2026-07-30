// Drizzle: Document — 批G Document 阅读模块.
//
// "LS 阅读模块不是通用阅读器, 是带学习机器的自习室" — documents 只收要被划线/
// 拆闪卡/进复习队列的文本 (Markdown only this batch; PDF/EPUB/URL 候审, brief
// §0). content_md 是唯一真源, title 派生规则见 ../lib/document-title.ts
// (frontmatter title → 首个 H1 → 文件名/首行截断, brief §2)。
//
// source 三通道 (brief §3): 'paste' (Web 粘贴) | 'upload' (Web .md/.txt 拖放) |
// 'mcp' (add_document 直接上架, "晨报塞进门缝")。plain text union, not a
// pg enum — same "batch A ships a string, tightens later" precedent
// lesson_annotations.color's doc comment sets (../schema/annotation.ts).
//
// packages/contracts 只读 (发包军规) — no shared `Document` type exists there
// yet; apps/web defines its own local wire-shape type
// (apps/web/src/document/types.ts), 正典化归验收人.

import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { learner_agent_pairs } from './pair';

export const documents = pgTable('documents', {
  id: text('id').primaryKey(),
  pair_id: text('pair_id')
    .notNull()
    .references(() => learner_agent_pairs.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  content_md: text('content_md').notNull(),
  /** 'paste' | 'upload' | 'mcp' — see file header. */
  source: text('source').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export type DocumentRow = typeof documents.$inferSelect;
