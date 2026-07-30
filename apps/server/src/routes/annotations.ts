// Hono REST routes — Annotation (batch A).
//
// 高亮与注释是同一条记录的两个面: POST 不传 note = 纯高亮, 传了 = 笔记.
// 批A单色 (color 默认 'amber'); 批B 收紧到 Mindmap 调色板 union 在 UI 层
// (apps/web/src/annotation/palette.ts) — contracts 的 AnnotationColorKey
// 本批只读, 仍是 string, 见批B报告.
// 硬删 (批A没有孤儿区 UI — 锚点 resolve 失败的"孤儿"是渲染层状态,
// apps/web/src/annotation 里处理, 跟这里的行删除无关).
//
// 学习证据 (批B 交付物 6, brief §3): annotation.created / annotation.note_added
// 落 session_events. 现成管道核实: `../lib/session-events` 的
// appendSessionEvent 已被 write.ts/mcp/server.ts 多处直接调用 (review.rated /
// exercise.submitted / …), 同一模式搬来这里. SessionEventType (contracts,
// 本批只读) 没有 'annotation.created'/'annotation.note_added' 字面量 —
// 服从现实条款: 复用已有的 'learning.evidence' 泛型事件类型 (session.ts 自己
// 的设计注释就是"优先作为 typed SessionEvent 落库, dogfood 证明需要独立生命
// 周期再拆专表"), payload.kind 携带子类型区分, 而不是新造 schema/迁移
// (军规明确禁止). 是否要在 contracts 里正式开两个专属字面量, 留给批B报告里
// 请发包人裁.
import { Hono } from 'hono';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { lesson_annotations } from '../db/schema';
import type { AnnotationColorKey } from '@learn-shell/contracts';
import { appendSessionEvent } from '../lib/session-events';
import { sweepPairAnnotations } from '../lib/annotation-sweep';

const a = new Hono();

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// GET /api/lessons/:id/annotations
a.get('/lessons/:id/annotations', async (c) => {
  const lessonId = c.req.param('id');
  const rows = await db
    .select()
    .from(lesson_annotations)
    .where(eq(lesson_annotations.lesson_id, lessonId))
    .orderBy(asc(lesson_annotations.created_at));
  return c.json(rows);
});

// POST /api/lessons/:id/annotations
//
// Deviation from the brief's literal body field list (page_index/
// selected_text/prefix/suffix/color?/note?): `pair_id` is also required
// here. `lesson_annotations.pair_id` is a NOT NULL cascade FK (brief §
// 交付物 1), and every other pair-scoped write route in this codebase
// (createFlashcard, recordLearningEvent, submitExercise, …) takes pair_id
// explicitly from the client rather than resolving a "current pair"
// server-side — that shortcut exists in exactly one place (`GET
// /pair/current`, explicitly flagged there as a W1 hack pending real auth)
// and the client already has pairId in hand via usePair(), so there is no
// reason to add a second instance of it here. 服从现实条款.
a.post('/lessons/:id/annotations', async (c) => {
  const lessonId = c.req.param('id');
  const input = await c.req.json<{
    pair_id: string;
    page_index: number;
    selected_text: string;
    prefix: string;
    suffix: string;
    color?: AnnotationColorKey;
    note?: string | null;
  }>();
  const now = new Date();
  const id = genId('ann');
  const [row] = await db
    .insert(lesson_annotations)
    .values({
      id,
      pair_id: input.pair_id,
      lesson_id: lessonId,
      page_index: input.page_index,
      selected_text: input.selected_text,
      prefix: input.prefix,
      suffix: input.suffix,
      color: input.color ?? 'amber',
      note: input.note ?? null,
      created_at: now,
      updated_at: now,
    })
    .returning();
  if (!row) return c.json({ error: 'insert_failed' }, 500);

  // annotation.created (批B 交付物 6) — every highlight, note or not.
  await appendSessionEvent({
    pair_id: input.pair_id,
    event_type: 'learning.evidence',
    actor_type: 'learner',
    mode: 'self_study',
    payload: {
      kind: 'annotation.created',
      annotation_id: row.id,
      lesson_id: lessonId,
      page_index: row.page_index,
      color: row.color,
      has_note: row.note != null,
      observation: `learner highlighted a passage in lesson ${lessonId}`,
      related_concept_ids: [],
      signal_strength: 'weak',
    },
    occurred_at: now,
  });

  return c.json(row, 201);
});

// PATCH /api/annotations/:id — note and/or color; at least one field required.
a.patch('/annotations/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ note?: string | null; color?: AnnotationColorKey }>();
  const patch: { note?: string | null; color?: AnnotationColorKey; updated_at: Date } = {
    updated_at: new Date(),
  };
  if (body.note !== undefined) patch.note = body.note;
  if (body.color !== undefined) patch.color = body.color;
  if (body.note === undefined && body.color === undefined) {
    return c.json({ error: 'no_patch_fields' }, 400);
  }
  const [row] = await db
    .update(lesson_annotations)
    .set(patch)
    .where(eq(lesson_annotations.id, id))
    .returning();
  if (!row) return c.json({ error: 'not_found' }, 404);

  // annotation.note_added (批B 交付物 6) — only when this patch actually set
  // real note text (a bare color reclassify isn't "the learner wrote
  // something", brief §3 names note-writing specifically as the signal).
  if (body.note != null && body.note.trim() !== '') {
    await appendSessionEvent({
      pair_id: row.pair_id,
      event_type: 'learning.evidence',
      actor_type: 'learner',
      mode: 'self_study',
      payload: {
        kind: 'annotation.note_added',
        annotation_id: row.id,
        lesson_id: row.lesson_id,
        page_index: row.page_index,
        color: row.color,
        observation: `learner added a note to a highlight in lesson ${row.lesson_id}`,
        related_concept_ids: [],
        signal_strength: 'moderate',
      },
    });
  }

  return c.json(row);
});

// DELETE /api/annotations/:id — hard delete (批A没有孤儿区, no undo).
a.delete('/annotations/:id', async (c) => {
  const id = c.req.param('id');
  const [existing] = await db
    .select()
    .from(lesson_annotations)
    .where(eq(lesson_annotations.id, id))
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);
  await db.delete(lesson_annotations).where(eq(lesson_annotations.id, id));
  return c.body(null, 204);
});

// GET /api/documents/:id/annotations — 批G, mirrors GET
// /lessons/:id/annotations above (学习机器
// 换宿主, 不新造平行零件 — same list shape, just keyed on document_id instead
// of lesson_id).
a.get('/documents/:id/annotations', async (c) => {
  const documentId = c.req.param('id');
  const rows = await db
    .select()
    .from(lesson_annotations)
    .where(eq(lesson_annotations.document_id, documentId))
    .orderBy(asc(lesson_annotations.created_at));
  return c.json(rows);
});

// POST /api/documents/:id/annotations — 批G create, mirrors POST
// /lessons/:id/annotations. Documents don't page (brief §4, continuous
// scroll) — page_index is always 0, not taken from the request body (unlike
// the lesson route, where the client supplies whichever page it's on).
a.post('/documents/:id/annotations', async (c) => {
  const documentId = c.req.param('id');
  const input = await c.req.json<{
    pair_id: string;
    selected_text: string;
    prefix: string;
    suffix: string;
    color?: AnnotationColorKey;
    note?: string | null;
  }>();
  const now = new Date();
  const id = genId('ann');
  const [row] = await db
    .insert(lesson_annotations)
    .values({
      id,
      pair_id: input.pair_id,
      lesson_id: null,
      document_id: documentId,
      live_session_id: null,
      page_index: 0,
      selected_text: input.selected_text,
      prefix: input.prefix,
      suffix: input.suffix,
      color: input.color ?? 'amber',
      note: input.note ?? null,
      created_at: now,
      updated_at: now,
    })
    .returning();
  if (!row) return c.json({ error: 'insert_failed' }, 500);

  // annotation.created — same learning-evidence event lessons' own POST
  // writes (batch B 交付物 6), document_id substituted for lesson_id in the
  // payload so downstream readers can tell the two hosts apart.
  await appendSessionEvent({
    pair_id: input.pair_id,
    event_type: 'learning.evidence',
    actor_type: 'learner',
    mode: 'self_study',
    payload: {
      kind: 'annotation.created',
      annotation_id: row.id,
      document_id: documentId,
      page_index: row.page_index,
      color: row.color,
      has_note: row.note != null,
      observation: `learner highlighted a passage in document ${documentId}`,
      related_concept_ids: [],
      signal_strength: 'weak',
    },
    occurred_at: now,
  });

  return c.json(row, 201);
});

// GET /api/live-sessions/:id/annotations — 第三种作用域, mirrors GET
// /documents/:id/annotations above (same "学习机器换宿主, 不新造平行零件"
// principle) but keyed on live_session_id. Unlike documents (continuous
// scroll, no paging concept), live sessions page by move — page_index on
// each row is that move's seq — so this list, like the lesson one, doesn't
// hardcode page_index; it's whatever the row was created with.
a.get('/live-sessions/:id/annotations', async (c) => {
  const liveSessionId = c.req.param('id');
  const rows = await db
    .select()
    .from(lesson_annotations)
    .where(eq(lesson_annotations.live_session_id, liveSessionId))
    .orderBy(asc(lesson_annotations.created_at));
  return c.json(rows);
});

// POST /api/live-sessions/:id/annotations — 第三种作用域 create, mirrors
// POST /lessons/:id/annotations (not the document route) because live
// sessions page like lessons do — page_index is supplied by the client, and
// by convention equals the seq of the move the annotation was captured
// against (web 端约定, this route doesn't itself validate the seq exists —
// same trust level the lesson route extends its page_index today).
//
// 三选一校验: this route derives its host (live_session_id) from the URL,
// same as the lesson/document POSTs above — it never accepts lesson_id/
// document_id/live_session_id as arbitrary body fields, so "exactly one
// host set" holds by construction, not by a runtime field-count check. The
// DB's lesson_annotations_host_exclusive CHECK (schema/annotation.ts) is the
// actual backstop, same division of labor 批G already established for
// lesson vs. document.
a.post('/live-sessions/:id/annotations', async (c) => {
  const liveSessionId = c.req.param('id');
  const input = await c.req.json<{
    pair_id: string;
    page_index: number;
    selected_text: string;
    prefix: string;
    suffix: string;
    color?: AnnotationColorKey;
    note?: string | null;
  }>();
  const now = new Date();
  const id = genId('ann');
  const [row] = await db
    .insert(lesson_annotations)
    .values({
      id,
      pair_id: input.pair_id,
      lesson_id: null,
      document_id: null,
      live_session_id: liveSessionId,
      page_index: input.page_index,
      selected_text: input.selected_text,
      prefix: input.prefix,
      suffix: input.suffix,
      color: input.color ?? 'amber',
      note: input.note ?? null,
      created_at: now,
      updated_at: now,
    })
    .returning();
  if (!row) return c.json({ error: 'insert_failed' }, 500);

  // annotation.created — same learning-evidence event the lesson/document
  // POSTs write (批B 交付物 6), live_session_id substituted in the payload.
  await appendSessionEvent({
    pair_id: input.pair_id,
    event_type: 'learning.evidence',
    actor_type: 'learner',
    mode: 'self_study',
    payload: {
      kind: 'annotation.created',
      annotation_id: row.id,
      live_session_id: liveSessionId,
      page_index: row.page_index,
      color: row.color,
      has_note: row.note != null,
      observation: `learner highlighted a passage in live session ${liveSessionId}`,
      related_concept_ids: [],
      signal_strength: 'weak',
    },
    occurred_at: now,
  });

  return c.json(row, 201);
});

// GET /api/pairs/:pairId/annotations/free — 批E 自由笔记读端点
// (批E). 自由笔记不挂在任何宿主下
// (lesson_id IS NULL AND document_id IS NULL — apps/server/src/db/schema/annotation.ts
// 批E注记 + 批G 批注宿主泛化注记), 所以现有 GET /lessons/:id/annotations /
// GET /documents/:id/annotations (按各自宿主扇出) 天然拿不到它们；Journal
// 面板另开一条按 pair 直接取的读端点, 一次拿全部自由笔记.
//
// 批G: added the `isNull(document_id)` half of this filter — without it, a
// document-anchored row (lesson_id null, document_id set) would have been
// misread as a free note here, since the original 批E filter only checked
// lesson_id.
//
// 第三种作用域: added the `isNull(live_session_id)` third of this filter for
// the same reason — a live-session-anchored row (lesson_id/document_id null,
// live_session_id set) would otherwise misread as a free note too.
a.get('/pairs/:pairId/annotations/free', async (c) => {
  const pairId = c.req.param('pairId');
  const rows = await db
    .select()
    .from(lesson_annotations)
    .where(
      and(
        eq(lesson_annotations.pair_id, pairId),
        isNull(lesson_annotations.lesson_id),
        isNull(lesson_annotations.document_id),
        isNull(lesson_annotations.live_session_id)
      )
    )
    .orderBy(asc(lesson_annotations.created_at));
  return c.json(rows);
});

// POST /api/pairs/:pairId/annotations/free — 批E 自由笔记创建. 不锚定课文:
// page_index/selected_text/prefix/suffix 落固定空值 (工头裁定, brief 批E) —
// 唯一必填字段是 note (自由笔记存在的全部理由就是写下的这段话; 空笔记没有
// 意义, 拒绝创建而不是落一条空记录).
a.post('/pairs/:pairId/annotations/free', async (c) => {
  const pairId = c.req.param('pairId');
  const input = await c.req.json<{ color?: AnnotationColorKey; note: string }>();
  if (!input.note || !input.note.trim()) {
    return c.json({ error: 'note_required' }, 400);
  }
  const now = new Date();
  const id = genId('ann');
  const [row] = await db
    .insert(lesson_annotations)
    .values({
      id,
      pair_id: pairId,
      lesson_id: null,
      document_id: null,
      live_session_id: null,
      page_index: 0,
      selected_text: '',
      prefix: '',
      suffix: '',
      color: input.color ?? 'amber',
      note: input.note,
      created_at: now,
      updated_at: now,
    })
    .returning();
  if (!row) return c.json({ error: 'insert_failed' }, 500);
  return c.json(row, 201);
});

// GET /api/pairs/:pairId/annotations/count — 遗留优化点. RecentRail's
// "笔记" row (apps/web/src/shell/RecentRail.tsx) only ever needed a number —
// it was getting it by running Journal's full read model
// (journal/useJournalNotes.ts: courses → per-course lessons → per-lesson
// annotations fan-out, plus a free-notes fetch) just to take
// `entries.length + orphans.length` off the end. That total is exactly
// "every lesson_annotations row this pair owns" (孤儿/自由/锚定 都算在内 —
// none of those states drop a row, 金缮条款), so a flat count(*) on pair_id
// reproduces the same number without walking courses/lessons/lesson-annotations
// three levels deep. NotesDrawer keeps calling useJournalNotes() unchanged —
// its full listing genuinely needs every row's content, not just the count.
a.get('/pairs/:pairId/annotations/count', async (c) => {
  const pairId = c.req.param('pairId');
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(lesson_annotations)
    .where(eq(lesson_annotations.pair_id, pairId));
  return c.json({ total: row?.n ?? 0 });
});

// POST /api/pairs/:pairId/annotations/sweep-orphans — batch D 孤儿普查.
// Re-anchors every one of this pair's
// annotations against each touched lesson's *current* content_markdown
// (apps/server/src/lib/annotation-sweep.ts — reuses batch A's disambiguation
// core, see that file's header for the DOM-vs-plain-text caveat) and writes
// orphaned_at accordingly. Not wired to any auto-trigger from the web client
// (Journal reads whatever orphaned_at already holds — kept fresh day-to-day
// by update_lesson's own post-write resweep below); this route is the
// standalone "run the census" entry point the brief asks to expose.
a.post('/pairs/:pairId/annotations/sweep-orphans', async (c) => {
  const pairId = c.req.param('pairId');
  const summary = await sweepPairAnnotations(pairId);
  return c.json(summary);
});

export default a;
