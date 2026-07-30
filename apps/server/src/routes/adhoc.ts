// Hono REST routes — AdHoc Thread (Stage 7d-fix, 2026-06-30).
//
// One long-living thread per pair. Endpoints mounted at /api/adhoc/*:
//   GET    /threads/by-pair/:pairId        get-or-create the singleton (non-archived) thread
//   GET    /threads/:id                    full view (thread + messages; ?after_message_id= for incremental read)
//   POST   /threads/:id/messages           append (user or agent, dedup on client_message_id)
//   POST   /threads/:id/archive            archive (privacy cleanup)
//   DELETE /messages/:id                   hard-delete a single message
//
// GET /threads/:id and the MCP tool `adhoc_thread_get` (mcp/server.ts) are
// REST/MCP siblings reading the same rows — the ?after_message_id= param and
// its isNewerEventId cursor semantics are kept in lockstep between the two;
// see mcp/server.ts's adhoc_thread_get case for the fuller comment.

import { Hono } from 'hono';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { ad_hoc_threads, ad_hoc_messages } from '../db/schema';
import { isNewerEventId } from '../lib/live-wait';
import type {
  AdHocContextSnapshot,
  AdHocMessage,
  AdHocPayload,
  AdHocThread,
} from '@learn-shell/contracts';

const a = new Hono();

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// GET /api/adhoc/threads/by-pair/:pairId — get-or-create
//
// Only matches non-archived threads: once a thread is archived
// via POST /threads/:id/archive, this lookup no longer finds it, so the
// next call lazily creates a brand-new thread instead of resurrecting the
// archived one. Archived threads remain reachable by id via GET
// /threads/:id for as long as their rows exist.
a.get('/threads/by-pair/:pairId', async (c) => {
  const pairId = c.req.param('pairId');
  let [thread] = await db
    .select()
    .from(ad_hoc_threads)
    .where(and(eq(ad_hoc_threads.pair_id, pairId), isNull(ad_hoc_threads.archived_at)))
    .orderBy(desc(ad_hoc_threads.created_at))
    .limit(1);
  if (!thread) {
    const newId = genId('ah');
    const now = new Date();
    const [created] = await db
      .insert(ad_hoc_threads)
      .values({
        id: newId,
        pair_id: pairId,
        message_count: 0,
        created_at: now,
        last_activity_at: now,
      })
      .returning();
    thread = created;
  }
  return c.json(thread as unknown as AdHocThread);
});

// GET /api/adhoc/threads/:id — full view
// ?after_message_id=<id> — incremental read (值更契约·低损耗, 2026-07-19):
// only messages newer than this id come back, on the same isNewerEventId
// total order the MCP tool adhoc_thread_get uses. Omit for the full history
// (first day on duty / catching up after a gap) — default behavior is
// byte-for-byte unchanged from before this param existed.
a.get('/threads/:id', async (c) => {
  const id = c.req.param('id');
  const afterMessageId = c.req.query('after_message_id');
  const [thread] = await db
    .select()
    .from(ad_hoc_threads)
    .where(eq(ad_hoc_threads.id, id))
    .limit(1);
  if (!thread) return c.json({ error: 'not_found' }, 404);
  const allMessages = await db
    .select()
    .from(ad_hoc_messages)
    .where(eq(ad_hoc_messages.thread_id, id))
    .orderBy(asc(ad_hoc_messages.created_at));
  const messages = afterMessageId
    ? allMessages.filter((m) => isNewerEventId(m.id, afterMessageId))
    : allMessages;
  const hasEarlier = afterMessageId ? messages.length < allMessages.length : false;
  return c.json({
    thread: thread as unknown as AdHocThread,
    messages: messages as unknown as AdHocMessage[],
    returned_count: messages.length,
    has_earlier: hasEarlier,
  });
});

// POST /api/adhoc/threads/:id/messages — append (user or agent)
a.post('/threads/:id/messages', async (c) => {
  const thread_id = c.req.param('id');
  const input = await c.req.json<{
    role: 'user' | 'agent';
    content: string;
    payload?: AdHocPayload;
    context_snapshot: AdHocContextSnapshot;
    is_learning_related: boolean;
    client_message_id: string;
  }>();

  // sweep — a missing client_message_id used to reach the dedupe
  // select's eq() as undefined, which postgres-js rejects with
  // UNDEFINED_VALUE (the only lethal undefined position — see
  // lib/tool-args.ts). The web client always sends one; this 400 guards the
  // route for any other caller. role is NOT NULL values-only (undefined →
  // SQL DEFAULT → clear not-null violation), validated here anyway for a
  // 400 instead of a 500.
  if (typeof input.client_message_id !== 'string' || input.client_message_id.trim() === '') {
    return c.json({ error: 'client_message_id_required' }, 400);
  }
  if (input.role !== 'user' && input.role !== 'agent') {
    return c.json({ error: 'role_invalid' }, 400);
  }

  // Idempotency dedupe.
  const existing = await db
    .select()
    .from(ad_hoc_messages)
    .where(eq(ad_hoc_messages.client_message_id, input.client_message_id))
    .limit(1);
  if (existing.length > 0) {
    return c.json(existing[0] as unknown as AdHocMessage, 200);
  }

  const id = genId('ahm');
  const now = new Date();
  const [row] = await db
    .insert(ad_hoc_messages)
    .values({
      id,
      thread_id,
      role: input.role,
      content: input.content,
      payload: input.payload,
      context_snapshot: input.context_snapshot,
      is_learning_related: input.is_learning_related,
      client_message_id: input.client_message_id,
      created_at: now,
    })
    .returning();

  await db
    .update(ad_hoc_threads)
    .set({
      last_activity_at: now,
      message_count: sql`${ad_hoc_threads.message_count} + 1`,
    })
    .where(eq(ad_hoc_threads.id, thread_id));

  return c.json(row as unknown as AdHocMessage, 201);
});

// POST /api/adhoc/threads/:id/archive — privacy cleanup.
// Sets archived_at; does not delete messages. Idempotent — archiving an
// already-archived thread just re-stamps the timestamp.
a.post('/threads/:id/archive', async (c) => {
  const id = c.req.param('id');
  const now = new Date();
  const [row] = await db
    .update(ad_hoc_threads)
    .set({ archived_at: now })
    .where(eq(ad_hoc_threads.id, id))
    .returning();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row as unknown as AdHocThread);
});

// DELETE /api/adhoc/messages/:id — hard delete a single message
// (learner-initiated, no undo). Keeps thread.message_count in
// sync with the surviving row count.
a.delete('/messages/:id', async (c) => {
  const id = c.req.param('id');
  const [existing] = await db
    .select()
    .from(ad_hoc_messages)
    .where(eq(ad_hoc_messages.id, id))
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  await db.delete(ad_hoc_messages).where(eq(ad_hoc_messages.id, id));
  await db
    .update(ad_hoc_threads)
    .set({
      message_count: sql`greatest(${ad_hoc_threads.message_count} - 1, 0)`,
    })
    .where(eq(ad_hoc_threads.id, existing.thread_id));

  return c.body(null, 204);
});

export default a;
