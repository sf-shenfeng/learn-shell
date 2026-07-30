// Hono REST routes — Document (batch G).
//
// "LS 阅读模块不是通用阅读器, 是带学习机器的自习室" — documents are Markdown-
// only (brief §0), created via Web paste/upload (this file) or MCP
// add_document (apps/server/src/mcp/server.ts). Content updates re-sweep this
// document's annotations (brief §3 item 3, same post-write-hook shape as
// PATCH /lessons/:id — routes/write.ts).
//
// Title derivation (brief §2: frontmatter → 首个 H1 → 文件名/首行截断) lives
// in ../lib/document-title.ts, called here only when the caller didn't
// supply an explicit title — same "server derives, client can override" shape
// update_lesson/add_lesson use for their own optional fields.

import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { documents, session_events } from '../db/schema';
import { deriveDocumentTitle } from '../lib/document-title';
import { sweepDocumentAnnotations } from '../lib/annotation-sweep';

const d = new Hono();

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

type DocumentSource = 'paste' | 'upload' | 'mcp';
const VALID_SOURCES: DocumentSource[] = ['paste', 'upload', 'mcp'];

// GET /api/pairs/:pairId/documents — full list (Reading 页 list view).
d.get('/pairs/:pairId/documents', async (c) => {
  const pairId = c.req.param('pairId');
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.pair_id, pairId))
    .orderBy(desc(documents.updated_at));
  return c.json(rows);
});

// GET /api/pairs/:pairId/documents/recent?limit=N — 参照
// annotations/count 端点 (routes/annotations.ts): RecentRail's "最近文档" row
// only ever needs id/title/updated_at for the single most-recent document —
// a light projection rather than the full list.getRecentDocuments's
// list-select above already returns full content_md, which RecentRail has
// no use for and shouldn't have to fetch just to read three fields off it.
//
// 排序键 = "最近接触" (2026-07-30): `updated_at` 只写在创建/编辑两处, 读完一份
// 文档不动它——于是"最近"一直指最近被写过的那份, 不是刚读完的那份。这里改取
// greatest(updated_at, 该文档最近一条 document.viewed 事件时间)。没有任何
// viewed 事件的存量文档 greatest 只剩 updated_at (Postgres 的 GREATEST 忽略
// NULL), 行为与改前逐位相同。
d.get('/pairs/:pairId/documents/recent', async (c) => {
  const pairId = c.req.param('pairId');
  const limitParam = c.req.query('limit');
  const limit = Math.max(1, Math.min(20, Number(limitParam) || 5));
  const lastViewed = db
    .select({
      document_id: sql<string>`${session_events.payload}->>'document_id'`.as('document_id'),
      last_viewed_at: sql<Date>`max(${session_events.occurred_at})`.as('last_viewed_at'),
    })
    .from(session_events)
    .where(
      and(
        eq(session_events.pair_id, pairId),
        eq(session_events.event_type, 'document.viewed')
      )
    )
    .groupBy(sql`${session_events.payload}->>'document_id'`)
    .as('last_viewed');
  const rows = await db
    .select({ id: documents.id, title: documents.title, updated_at: documents.updated_at })
    .from(documents)
    .leftJoin(lastViewed, eq(lastViewed.document_id, documents.id))
    .where(eq(documents.pair_id, pairId))
    .orderBy(desc(sql`greatest(${documents.updated_at}, ${lastViewed.last_viewed_at})`))
    .limit(limit);
  return c.json(rows);
});

// GET /api/documents/:id — single document, full content (Reading 页详情).
d.get('/documents/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

// POST /api/pairs/:pairId/documents — Web 粘贴/上传两通道共用此端点
// (brief §3 item 1); `source` distinguishes them, `filename` is upload-only
// (paste has none) and only feeds title derivation, never persisted itself.
d.post('/pairs/:pairId/documents', async (c) => {
  const pairId = c.req.param('pairId');
  const input = await c.req.json<{
    title?: string;
    content_md: string;
    source: DocumentSource;
    filename?: string;
  }>();

  if (!input.content_md || !input.content_md.trim()) {
    return c.json({ error: 'content_required' }, 400);
  }
  if (!VALID_SOURCES.includes(input.source)) {
    return c.json({ error: 'invalid_source' }, 400);
  }

  const now = new Date();
  const id = genId('doc');
  const title = input.title?.trim() || deriveDocumentTitle(input.content_md, input.filename);

  const [row] = await db
    .insert(documents)
    .values({
      id,
      pair_id: pairId,
      title,
      content_md: input.content_md,
      source: input.source,
      created_at: now,
      updated_at: now,
    })
    .returning();
  if (!row) return c.json({ error: 'insert_failed' }, 500);
  return c.json(row, 201);
});

// PATCH /api/documents/:id — title and/or content_md; a content_md change
// re-sweeps this document's annotations right away (brief §3 item 3, same
// shape as PATCH /lessons/:id's post-write resweep in routes/write.ts).
d.patch('/documents/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ title?: string; content_md?: string }>();

  const patch: { title?: string; content_md?: string; updated_at: Date } = { updated_at: new Date() };
  if (body.title !== undefined) patch.title = body.title;
  if (body.content_md !== undefined) patch.content_md = body.content_md;
  if (body.title === undefined && body.content_md === undefined) {
    return c.json({ error: 'no_patch_fields' }, 400);
  }

  const [updated] = await db
    .update(documents)
    .set(patch)
    .where(eq(documents.id, id))
    .returning();
  if (!updated) return c.json({ error: 'not_found' }, 404);

  let sweepNote: { swept: number; orphaned: number; resolved: number } | undefined;
  if (body.content_md !== undefined) {
    sweepNote = await sweepDocumentAnnotations(id);
  }

  return c.json({ ...updated, _sweep: sweepNote });
});

// DELETE /api/documents/:id — hard delete; cascades to its annotations
// (documents.id FK, ON DELETE CASCADE — apps/server/src/db/schema/annotation.ts).
d.delete('/documents/:id', async (c) => {
  const id = c.req.param('id');
  const [existing] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);
  await db.delete(documents).where(eq(documents.id, id));
  return c.body(null, 204);
});

export default d;
