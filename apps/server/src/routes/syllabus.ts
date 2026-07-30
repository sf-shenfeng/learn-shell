// Hono REST routes — Syllabus Registry.
//
// "考纲的哪个角落没人管必须是一个可查询的事实" (brief §0). Two tables
// (syllabus_nodes / syllabus_mappings), zero stored scores — coverage/decay
// are always computed at request time by ../lib/syllabus-coverage.ts, fed by
// this file's DB reads (flashcards for retrievability, quiz_attempts for
// "tested" + last-answered timestamps).
//
// brief §3 batch-create shape: "支持嵌套或平铺+parent 引用，二选一报告理由" —
// this ships **flat + parent_id reference**, not nested JSON. Reason: every
// other relational table in this schema dir (lessons→lesson_revisions,
// concepts→lessons, exercises→lessons…) is flat rows + FK, never a nested
// JSON tree — nested-JSON trees exist in this codebase exactly once
// (mindmaps.content) and that's a documented §6
// deliberate outlier for a *canvas* (freeform node/link graph), not a
// relational hierarchy. Syllabus nodes are relational (brief §1 literally
// lists parent_id as a column), so flat+FK matches the schema's own idiom
// and lets PATCH/DELETE target one row by id without re-submitting a subtree.
// Batch inserts that create a parent and its children in the same call are
// still supported — items may set an explicit client-chosen `id` and have
// sibling items reference it via `parent_id` before it exists in the DB;
// see `planInsertOrder` below for how that's made safe against Postgres FK
// ordering within one statement.

import { Hono } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { syllabus_nodes, syllabus_mappings, learner_agent_pairs, flashcards, quiz_attempts } from '../db/schema';
import { currentRetrievability } from '../lib/fsrs';
import {
  buildSyllabusTree,
  overallCoveragePct,
  type CoverageContext,
  type SyllabusAssetType,
  type SyllabusMappedBy,
  type SyllabusMappingInput,
  type SyllabusNodeInput,
} from '../lib/syllabus-coverage';
import type { QuizAttemptAnswer } from '@learn-shell/contracts';

const s = new Hono();

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const VALID_ASSET_TYPES: SyllabusAssetType[] = [
  'lesson',
  'flashcard',
  'quiz_question',
  'document',
  'mindmap_node',
];
const VALID_MAPPED_BY: SyllabusMappedBy[] = ['agent', 'user'];

// ============================================================================
// GET /pairs/:pairId/syllabus?version= — full tree + derived state
// ============================================================================

s.get('/pairs/:pairId/syllabus', async (c) => {
  const pairId = c.req.param('pairId');
  const requestedVersion = c.req.query('version');

  // brief §5 空态克制: no version resolvable (either none requested and the
  // pair has zero nodes anywhere, or the requested version has zero rows) →
  // return the empty structure verbatim, no error.
  let version = requestedVersion ?? null;
  if (!version) {
    // No version given → default to whichever version has the most
    // recently-created node (brief doesn't specify a default; documented in
    // the delivery report as this endpoint's resolution).
    const [mostRecent] = await db
      .select({ syllabus_version: syllabus_nodes.syllabus_version })
      .from(syllabus_nodes)
      .where(eq(syllabus_nodes.pair_id, pairId))
      .orderBy(desc(syllabus_nodes.created_at))
      .limit(1);
    version = mostRecent?.syllabus_version ?? null;
  }

  if (!version) {
    return c.json({ version: null, nodes: [], mappings: [], coverage_pct: null });
  }

  const nodeRows = await db
    .select()
    .from(syllabus_nodes)
    .where(and(eq(syllabus_nodes.pair_id, pairId), eq(syllabus_nodes.syllabus_version, version)));

  if (nodeRows.length === 0) {
    return c.json({ version, nodes: [], mappings: [], coverage_pct: null });
  }

  const nodeIds = nodeRows.map((n) => n.id);
  const mappingRows = nodeIds.length
    ? await db.select().from(syllabus_mappings).where(inArray(syllabus_mappings.node_id, nodeIds))
    : [];

  const flashcardIds = [...new Set(mappingRows.filter((m) => m.asset_type === 'flashcard').map((m) => m.asset_id))];
  const quizQuestionIds = [
    ...new Set(mappingRows.filter((m) => m.asset_type === 'quiz_question').map((m) => m.asset_id)),
  ];

  const flashcardRetrievabilityById = new Map<string, number>();
  const flashcardLastReviewById = new Map<string, string | null>();
  if (flashcardIds.length > 0) {
    const cardRows = await db.select().from(flashcards).where(inArray(flashcards.id, flashcardIds));
    const now = new Date();
    for (const card of cardRows) {
      flashcardRetrievabilityById.set(card.id, currentRetrievability(card.fsrs_state, now));
      flashcardLastReviewById.set(card.id, card.fsrs_state.last_review_at);
    }
  }

  const testedQuizQuestionIds = new Set<string>();
  const quizQuestionLastAnsweredById = new Map<string, string>();
  if (quizQuestionIds.length > 0) {
    const [pairRow] = await db
      .select()
      .from(learner_agent_pairs)
      .where(eq(learner_agent_pairs.id, pairId))
      .limit(1);
    if (pairRow) {
      const attempts = await db
        .select()
        .from(quiz_attempts)
        .where(eq(quiz_attempts.learner_id, pairRow.learner_id));
      const quizQuestionIdSet = new Set(quizQuestionIds);
      for (const attempt of attempts) {
        const answers = attempt.answers as QuizAttemptAnswer[];
        const attemptTs = attempt.finished_at?.toISOString() ?? attempt.started_at.toISOString();
        for (const answer of answers) {
          if (!quizQuestionIdSet.has(answer.question_id)) continue;
          testedQuizQuestionIds.add(answer.question_id);
          const prev = quizQuestionLastAnsweredById.get(answer.question_id);
          if (!prev || attemptTs > prev) quizQuestionLastAnsweredById.set(answer.question_id, attemptTs);
        }
      }
    }
  }

  const ctx: CoverageContext = {
    testedQuizQuestionIds,
    flashcardRetrievabilityById,
    flashcardLastReviewById,
    quizQuestionLastAnsweredById,
  };

  const nodesInput: SyllabusNodeInput[] = nodeRows.map((n) => ({
    id: n.id,
    parent_id: n.parent_id,
    code: n.code,
    title: n.title,
    description: n.description,
    syllabus_version: n.syllabus_version,
    exam_weight: n.exam_weight,
    sort_order: n.sort_order,
  }));
  const mappingsInput: SyllabusMappingInput[] = mappingRows.map((m) => ({
    id: m.id,
    node_id: m.node_id,
    asset_type: m.asset_type,
    asset_id: m.asset_id,
    mapped_by: m.mapped_by,
    created_at: m.created_at.toISOString(),
  }));

  const tree = buildSyllabusTree(nodesInput, mappingsInput, ctx);
  const codeByNodeId = new Map(nodeRows.map((n) => [n.id, n.code]));

  // Flat mapping list (with denormalized `code`) — Journal's syllabus-week
  // projection buckets these by calendar week client-side
  // (apps/web/src/journal/useJournalTimeline.ts / format.ts's weekKeyOf),
  // same "raw rows in, aggregate client-side" shape review-day entries
  // already use for session data (see that hook's header comment) — journal
  // aggregation in this codebase is a client concern, not a server one
  // (confirmed via full-repo grep against the current code, §1.3/§6 —
  // see this task's delivery report for the brief-vs-reality note).
  const mappings = mappingRows.map((m) => ({
    node_id: m.node_id,
    code: codeByNodeId.get(m.node_id) ?? m.node_id,
    asset_type: m.asset_type,
    asset_id: m.asset_id,
    created_at: m.created_at.toISOString(),
  }));

  return c.json({
    version,
    nodes: tree,
    mappings,
    coverage_pct: overallCoveragePct(tree),
  });
});

// ============================================================================
// POST /pairs/:pairId/syllabus/nodes — batch create (flat + parent_id)
// ============================================================================

interface NodeInput {
  id?: string;
  parent_id?: string | null;
  code: string;
  title: string;
  description?: string | null;
  exam_weight?: number | null;
  sort_order?: number;
}

/** Orders a batch for insertion so every row's parent (if it's also in this
 *  batch) is inserted before it — required because `syllabus_nodes.parent_id`
 *  is a plain (non-deferrable) FK, so a single multi-row INSERT would fail
 *  if a child row's values are positioned before its in-batch parent's.
 *  Returns null if the batch contains a cycle or a parent_id that resolves
 *  to neither an existing DB row nor another item in the batch. */
function planInsertOrder(
  items: { id: string; parent_id: string | null }[],
  existingIds: Set<string>
): typeof items | null {
  const ordered: typeof items = [];
  const placed = new Set<string>();
  let remaining = [...items];

  while (remaining.length > 0) {
    const next = remaining.filter(
      (i) => i.parent_id === null || existingIds.has(i.parent_id) || placed.has(i.parent_id)
    );
    if (next.length === 0) return null; // cycle or dangling parent_id
    for (const i of next) {
      ordered.push(i);
      placed.add(i.id);
    }
    const nextIds = new Set(next.map((i) => i.id));
    remaining = remaining.filter((i) => !nextIds.has(i.id));
  }
  return ordered;
}

s.post('/pairs/:pairId/syllabus/nodes', async (c) => {
  const pairId = c.req.param('pairId');
  const body = await c.req.json<{ syllabus_version: string; nodes: NodeInput[] }>();

  if (!body.syllabus_version?.trim()) {
    return c.json({ error: 'syllabus_version_required' }, 400);
  }
  if (!Array.isArray(body.nodes) || body.nodes.length === 0) {
    return c.json({ error: 'nodes_required' }, 400);
  }
  for (const n of body.nodes) {
    if (!n.code?.trim() || !n.title?.trim()) {
      return c.json({ error: 'code_and_title_required' }, 400);
    }
  }

  const now = new Date();
  const prepared = body.nodes.map((n) => ({
    id: n.id?.trim() || genId('syn'),
    parent_id: n.parent_id ?? null,
    code: n.code,
    title: n.title,
    description: n.description ?? null,
    exam_weight: n.exam_weight ?? null,
    sort_order: n.sort_order ?? 0,
  }));

  // parent_id may point at an existing row in this pair+version (attaching
  // new nodes under an already-established tree).
  const existingRows = await db
    .select({ id: syllabus_nodes.id })
    .from(syllabus_nodes)
    .where(
      and(eq(syllabus_nodes.pair_id, pairId), eq(syllabus_nodes.syllabus_version, body.syllabus_version))
    );
  const existingIds = new Set(existingRows.map((r) => r.id));

  const order = planInsertOrder(
    prepared.map((p) => ({ id: p.id, parent_id: p.parent_id })),
    existingIds
  );
  if (!order) {
    return c.json({ error: 'invalid_parent_reference', message: 'A node\'s parent_id must be either an existing node id in this pair/version or another node\'s id in the same batch, with no cycles.' }, 400);
  }

  const byId = new Map(prepared.map((p) => [p.id, p]));
  const inserted = [];
  // Insert one at a time in dependency order — a single multi-row INSERT
  // would hit the same FK-ordering problem `planInsertOrder` exists to avoid
  // (Postgres checks each row's constraints as it's processed within the
  // statement, not only at the statement's end).
  for (const item of order) {
    const p = byId.get(item.id)!;
    const [row] = await db
      .insert(syllabus_nodes)
      .values({
        id: p.id,
        pair_id: pairId,
        parent_id: p.parent_id,
        code: p.code,
        title: p.title,
        description: p.description,
        syllabus_version: body.syllabus_version,
        exam_weight: p.exam_weight,
        sort_order: p.sort_order,
        created_at: now,
        updated_at: now,
      })
      .returning();
    if (row) inserted.push(row);
  }

  return c.json(inserted, 201);
});

// ============================================================================
// PATCH /syllabus/nodes/:id
// ============================================================================

s.patch('/syllabus/nodes/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    code?: string;
    title?: string;
    description?: string | null;
    exam_weight?: number | null;
    sort_order?: number;
    parent_id?: string | null;
  }>();

  const [existing] = await db.select().from(syllabus_nodes).where(eq(syllabus_nodes.id, id)).limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  if (body.parent_id !== undefined && body.parent_id !== null) {
    if (body.parent_id === id) {
      return c.json({ error: 'invalid_parent', message: 'A node cannot be its own parent.' }, 400);
    }
    // Walk up the candidate new parent's ancestor chain — reject if `id`
    // (the node being moved) appears in it, which would create a cycle.
    let cursor: string | null = body.parent_id;
    const guardAgainstInfiniteLoop = new Set<string>();
    while (cursor) {
      if (cursor === id) {
        return c.json(
          { error: 'invalid_parent', message: 'That parent is a descendant of this node — would create a cycle.' },
          400
        );
      }
      if (guardAgainstInfiniteLoop.has(cursor)) break;
      guardAgainstInfiniteLoop.add(cursor);
      const [row] = await db
        .select({ parent_id: syllabus_nodes.parent_id })
        .from(syllabus_nodes)
        .where(eq(syllabus_nodes.id, cursor))
        .limit(1);
      cursor = row?.parent_id ?? null;
    }
  }

  const patch: Record<string, unknown> = { updated_at: new Date() };
  if (body.code !== undefined) patch.code = body.code;
  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) patch.description = body.description;
  if (body.exam_weight !== undefined) patch.exam_weight = body.exam_weight;
  if (body.sort_order !== undefined) patch.sort_order = body.sort_order;
  if (body.parent_id !== undefined) patch.parent_id = body.parent_id;

  const [updated] = await db.update(syllabus_nodes).set(patch).where(eq(syllabus_nodes.id, id)).returning();
  return c.json(updated);
});

// ============================================================================
// DELETE /syllabus/nodes/:id — hard-blocked if mapped or has children
// ============================================================================

s.delete('/syllabus/nodes/:id', async (c) => {
  const id = c.req.param('id');
  const [existing] = await db.select().from(syllabus_nodes).where(eq(syllabus_nodes.id, id)).limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  const mappingCount = await db.select().from(syllabus_mappings).where(eq(syllabus_mappings.node_id, id));
  if (mappingCount.length > 0) {
    return c.json(
      {
        error: 'has_mappings',
        message: `This node has ${mappingCount.length} mapping(s) — detach them first via DELETE /syllabus/mappings/:id before deleting the node.`,
        mapping_ids: mappingCount.map((m) => m.id),
      },
      409
    );
  }

  const children = await db.select({ id: syllabus_nodes.id }).from(syllabus_nodes).where(eq(syllabus_nodes.parent_id, id));
  if (children.length > 0) {
    return c.json(
      {
        error: 'has_children',
        message: `This node has ${children.length} child node(s) — delete or reparent them first.`,
        child_ids: children.map((n) => n.id),
      },
      409
    );
  }

  await db.delete(syllabus_nodes).where(eq(syllabus_nodes.id, id));
  return c.body(null, 204);
});

// ============================================================================
// POST /pairs/:pairId/syllabus/mappings
// ============================================================================

s.post('/pairs/:pairId/syllabus/mappings', async (c) => {
  const pairId = c.req.param('pairId');
  const body = await c.req.json<{
    node_id: string;
    asset_type: SyllabusAssetType;
    asset_id: string;
    mapped_by: SyllabusMappedBy;
  }>();

  if (!VALID_ASSET_TYPES.includes(body.asset_type)) {
    return c.json({ error: 'invalid_asset_type' }, 400);
  }
  if (!VALID_MAPPED_BY.includes(body.mapped_by)) {
    return c.json({ error: 'invalid_mapped_by' }, 400);
  }
  if (!body.node_id?.trim() || !body.asset_id?.trim()) {
    return c.json({ error: 'node_id_and_asset_id_required' }, 400);
  }

  const [node] = await db
    .select({ id: syllabus_nodes.id })
    .from(syllabus_nodes)
    .where(and(eq(syllabus_nodes.id, body.node_id), eq(syllabus_nodes.pair_id, pairId)))
    .limit(1);
  if (!node) return c.json({ error: 'node_not_found' }, 404);

  const [row] = await db
    .insert(syllabus_mappings)
    .values({
      id: genId('sym'),
      pair_id: pairId,
      node_id: body.node_id,
      asset_type: body.asset_type,
      asset_id: body.asset_id,
      mapped_by: body.mapped_by,
      created_at: new Date(),
    })
    .returning();

  return c.json(row, 201);
});

// ============================================================================
// DELETE /syllabus/mappings/:id
// ============================================================================

s.delete('/syllabus/mappings/:id', async (c) => {
  const id = c.req.param('id');
  const [existing] = await db.select().from(syllabus_mappings).where(eq(syllabus_mappings.id, id)).limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);
  await db.delete(syllabus_mappings).where(eq(syllabus_mappings.id, id));
  return c.body(null, 204);
});

export default s;
