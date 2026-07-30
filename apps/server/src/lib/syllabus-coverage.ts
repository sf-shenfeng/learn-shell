// 考纲登记簿 — 覆盖 × 衰减计算.
//
// Pure functions only — no db import here on purpose (node:test unit tests
// exercise this module directly; ../routes/syllabus.ts does the DB fetch and
// feeds plain data in). Nothing here is ever written back to a table — brief
// §2 header: "运行时派生，不落库存分".
//
// Two brief gaps this module resolves, both documented here so the report
// doesn't have to be re-derived from code:
//
// 1. coverage ladder for flashcard/mindmap_node-only mappings. Brief §2
//    defines only two positive states by example ("taught（有 lesson/document
//    映射）" / "tested（有 quiz 映射且有作答记录）") and leaves untouched as
//    "零映射". That leaves a node whose *only* mapping is a flashcard or a
//    mindmap node in a gap — not zero mappings, but matching neither named
//    condition. Resolution: `taught` is read as "has at least one mapping of
//    any kind" (a flashcard assigned to a LOS is still evidence something
//    was attached to it), with `tested` as a strictly stronger condition on
//    top (quiz mapping + an actual answered attempt). This keeps the
//    three-state ladder total (every node lands in exactly one state) instead
//    of leaving some nodes unclassifiable.
//
// 2. tree rollup formula. Brief §2: "父节点 = 子节点的加权汇总（无
//    exam_weight 时等权）" — read literally ("子节点的", the children's) this
//    would ignore a parent's own direct mappings entirely. Resolution: a
//    parent's rolled-up number is the weighted average across { the parent's
//    own leaf-level value (if it has direct mappings) } ∪ { each child's own
//    already-rolled-up value }, weight = exam_weight ?? 1 for each
//    contributing member. This still reduces to exactly the brief's literal
//    formula for the common case (parent has no direct mappings of its own),
//    while not silently discarding data on the less common case (a node with
//    both children AND its own mappings). `coverage`/`decay` returned per
//    node are the node's *own* (unrolled) three/two-state read — matches the
//    brief's literal per-node vocabulary; `coverage_pct`/`decay_value` are the
//    additional rolled-up numbers this resolution produces, for progress-bar
//    / Journal-% consumers.

export type SyllabusAssetType = 'lesson' | 'flashcard' | 'quiz_question' | 'document' | 'mindmap_node';
export type SyllabusMappedBy = 'agent' | 'user';
export type CoverageState = 'untouched' | 'taught' | 'tested';
export type DecayBand = 'fresh' | 'fading' | 'cold';

export interface SyllabusNodeInput {
  id: string;
  parent_id: string | null;
  code: string;
  title: string;
  description: string | null;
  syllabus_version: string;
  exam_weight: number | null;
  sort_order: number;
}

export interface SyllabusMappingInput {
  id: string;
  node_id: string;
  asset_type: SyllabusAssetType;
  asset_id: string;
  mapped_by: SyllabusMappedBy;
  created_at: string; // ISO
}

/** Everything the pure calc needs about the world beyond the mapping rows
 *  themselves — all pre-fetched by the route handler, all optional lookups
 *  (missing entries just mean "no signal", never an error). */
export interface CoverageContext {
  /** quiz_question asset_ids that have at least one answered attempt
   *  (real quiz path — quiz_attempts.answers[].question_id), for this pair's
   *  learner. Presence in the set = "tested". */
  testedQuizQuestionIds: Set<string>;
  /** flashcard asset_id → live-computed retrievability (0..1), see
   *  ../lib/fsrs.ts `currentRetrievability` — the route handler computes this
   *  per card at request time so decay reflects "right now", not the FSRS
   *  snapshot from the card's last review. */
  flashcardRetrievabilityById: Map<string, number>;
  /** flashcard asset_id → its fsrs_state.last_review_at (ISO or null) —
   *  folded into last_touched. */
  flashcardLastReviewById: Map<string, string | null>;
  /** quiz_question asset_id → latest attempt timestamp that answered it
   *  (ISO), folded into last_touched. */
  quizQuestionLastAnsweredById: Map<string, string>;
}

export interface NodeOwnState {
  coverage: CoverageState;
  decay: DecayBand | null;
  decay_value: number | null;
  last_touched: string | null;
}

export interface SyllabusTreeNode extends SyllabusNodeInput, NodeOwnState {
  /** Tree-rolled 0..100 — see resolution above. Always defined (0 for an
   *  untouched leaf with no children, never null) so UI can always render a
   *  bar. */
  coverage_pct: number;
  /** Tree-rolled 0..1 average retrievability, or null if no flashcard
   *  coverage exists anywhere in this node's own mapping + subtree. */
  decay_value_rollup: number | null;
  decay_rollup: DecayBand | null;
  /** Rolled-up max of own last_touched and every descendant's. */
  last_touched_rollup: string | null;
  children: SyllabusTreeNode[];
}

function coverageScore(state: CoverageState): number {
  if (state === 'tested') return 1;
  if (state === 'taught') return 0.5;
  return 0;
}

function decayBand(value: number): DecayBand {
  if (value >= 0.8) return 'fresh';
  if (value >= 0.5) return 'fading';
  return 'cold';
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function latestIso(values: (string | null | undefined)[]): string | null {
  let latest: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (!latest || v > latest) latest = v;
  }
  return latest;
}

/** null-safe weighted average — entries with a null value are excluded from
 *  both numerator and denominator (not treated as 0). Returns null if every
 *  entry was excluded (no signal at all). */
function weightedAverage(entries: { value: number | null; weight: number }[]): number | null {
  const usable = entries.filter((e): e is { value: number; weight: number } => e.value !== null);
  if (usable.length === 0) return null;
  const totalWeight = usable.reduce((sum, e) => sum + e.weight, 0);
  if (totalWeight <= 0) return null;
  return usable.reduce((sum, e) => sum + e.value * e.weight, 0) / totalWeight;
}

/** Own (unrolled) coverage/decay/last_touched for one node from its direct
 *  mappings only. */
export function computeOwnState(
  mappings: SyllabusMappingInput[],
  ctx: CoverageContext
): NodeOwnState {
  if (mappings.length === 0) {
    return { coverage: 'untouched', decay: null, decay_value: null, last_touched: null };
  }

  const tested = mappings.some(
    (m) => m.asset_type === 'quiz_question' && ctx.testedQuizQuestionIds.has(m.asset_id)
  );
  const coverage: CoverageState = tested ? 'tested' : 'taught';

  const retrievabilities = mappings
    .filter((m) => m.asset_type === 'flashcard')
    .map((m) => ctx.flashcardRetrievabilityById.get(m.asset_id))
    .filter((v): v is number => v !== undefined);
  const decay_value = retrievabilities.length > 0 ? mean(retrievabilities) : null;
  const decay = decay_value !== null ? decayBand(decay_value) : null;

  const touchTimestamps: (string | null | undefined)[] = [];
  for (const m of mappings) {
    touchTimestamps.push(m.created_at);
    if (m.asset_type === 'flashcard') {
      touchTimestamps.push(ctx.flashcardLastReviewById.get(m.asset_id));
    }
    if (m.asset_type === 'quiz_question') {
      touchTimestamps.push(ctx.quizQuestionLastAnsweredById.get(m.asset_id));
    }
  }
  const last_touched = latestIso(touchTimestamps);

  return { coverage, decay, decay_value, last_touched };
}

/** Build the full nested tree with own + rolled-up state for every node.
 *  `nodes` may be in any order — children are grouped by parent_id first. */
export function buildSyllabusTree(
  nodes: SyllabusNodeInput[],
  mappings: SyllabusMappingInput[],
  ctx: CoverageContext
): SyllabusTreeNode[] {
  const mappingsByNode = new Map<string, SyllabusMappingInput[]>();
  for (const m of mappings) {
    const bucket = mappingsByNode.get(m.node_id);
    if (bucket) bucket.push(m);
    else mappingsByNode.set(m.node_id, [m]);
  }

  const childrenByParent = new Map<string | null, SyllabusNodeInput[]>();
  for (const n of nodes) {
    const bucket = childrenByParent.get(n.parent_id);
    if (bucket) bucket.push(n);
    else childrenByParent.set(n.parent_id, [n]);
  }
  for (const bucket of childrenByParent.values()) {
    bucket.sort((a, b) => a.sort_order - b.sort_order);
  }

  function build(node: SyllabusNodeInput): SyllabusTreeNode {
    const own = computeOwnState(mappingsByNode.get(node.id) ?? [], ctx);
    const weight = node.exam_weight ?? 1;
    const childNodes = (childrenByParent.get(node.id) ?? []).map(build);

    // "if it has direct mappings" (resolution above) — an untouched node
    // contributes *no* signal of its own to the rollup (null, excluded by
    // weightedAverage), not a literal 0 that would drag a fully-covered
    // subtree's average down just because the parent node itself is a bare
    // organizational label with no assets attached directly to it. A leaf
    // with zero mappings still correctly reports 0% via the `?? 0` fallback
    // below (nothing else to average over).
    const hasOwnMapping = own.coverage !== 'untouched';
    const coverage_pct_ratio =
      weightedAverage([
        { value: hasOwnMapping ? coverageScore(own.coverage) : null, weight },
        ...childNodes.map((c) => ({ value: c.coverage_pct / 100, weight: c.exam_weight ?? 1 })),
      ]) ?? 0;

    const decay_value_rollup = weightedAverage([
      { value: own.decay_value, weight },
      ...childNodes.map((c) => ({ value: c.decay_value_rollup, weight: c.exam_weight ?? 1 })),
    ]);

    const last_touched_rollup = latestIso([
      own.last_touched,
      ...childNodes.map((c) => c.last_touched_rollup),
    ]);

    return {
      ...node,
      ...own,
      coverage_pct: Math.round(coverage_pct_ratio * 1000) / 10, // one decimal place
      decay_value_rollup,
      decay_rollup: decay_value_rollup !== null ? decayBand(decay_value_rollup) : null,
      last_touched_rollup,
      children: childNodes,
    };
  }

  const roots = childrenByParent.get(null) ?? [];
  return roots.map(build);
}

/** Whole-tree cumulative coverage %, weighted the same way a single
 *  parent's rollup is — used for the Journal projection's "累计覆盖 X%" and
 *  for any future top-level progress UI. Synthesizes a virtual root over the
 *  top-level nodes (equal-weight unless they carry exam_weight). */
export function overallCoveragePct(tree: SyllabusTreeNode[]): number {
  const pct = weightedAverage(
    tree.map((n) => ({ value: n.coverage_pct / 100, weight: n.exam_weight ?? 1 }))
  );
  return pct !== null ? Math.round(pct * 1000) / 10 : 0;
}

/** Flattens a tree back into a list (pre-order) — used where a flat
 *  node_id → derived-state lookup is more convenient than walking children
 *  (e.g. journal weekly projection matching mapping.node_id → code). */
export function flattenTree(tree: SyllabusTreeNode[]): SyllabusTreeNode[] {
  const out: SyllabusTreeNode[] = [];
  const walk = (nodes: SyllabusTreeNode[]) => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}
