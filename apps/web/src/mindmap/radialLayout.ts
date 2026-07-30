// radialLayout — pure, deterministic radial-map layout engine.
//
// Contract ("第一截: 引擎核心"):
//   - root at the origin (0,0); caller translates to canvas coords.
//   - first-ring (depth-1) branches share the full 360° proportionally
//     to how many leaves each branch's subtree carries. If a branch
//     carries an existing pos_x/pos_y "hint", the whole ring is rotated
//     (best-effort, deterministic tie-break by sort_order) so that
//     branch lands in the quadrant its hint points at.
//   - ring radius grows per depth (R1, R1+ΔR, R1+2ΔR, ...).
//   - label-aware collision avoidance: adjacent nodes on the SAME ring
//     keep at least their combined label half-width of angular
//     clearance — if the ring is too crowded for its base radius, that
//     ring's radius is bumped out (closed-form solve, not search — see
//     ringRadius below) until every pair fits. Deterministic: same
//     input -> same output, no randomness, no Date.
//   - fully-expanded computation always. is_expanded / fold state is a
//     visibility concern for the caller (mirrors Mindmap.tsx's
//     fold-as-visibility principle for tree mode) — this module never
//     looks at is_expanded.
//
// Free-floating notes (parent_id null, level !== 'root') are NOT part
// of the radial tree — they don't get an entry in the returned map.
// Same convention as tree mode: those nodes are already is_pinned with
// absolute pos_x/pos_y, and the caller (Mindmap.tsx) should keep
// rendering them there in both layout modes.

import type { MindmapNode } from '@learn-shell/contracts';

// ============================================================================
// Tunables — the follow-up visual-tuning session reaches for these first.
// ============================================================================

export interface RadialOptions {
  /** Radius (px) of the first ring (depth-1 / branch nodes). */
  R1: number;
  /** Radius growth (px) added per additional depth level ("ΔR"). */
  ringGap: number;
  /** Extra angular clearance (px of arc length) padded around every label. */
  labelPad: number;
  /** Approx pixel width contributed by each CJK glyph in a label. */
  cjkCharPx: number;
  /** Approx pixel width contributed by each Latin/other glyph in a label. */
  latinCharPx: number;
  /** Fixed pixel width added to every label estimate (pill chrome, icon...). */
  labelBasePx: number;
  /**
   * Blend factor (0..1) for the quadratic-curve control point used by
   * deeper (depth >= 2) edges: 0 = plain straight chord between parent
   * and child, 1 = full "radial sweep" elbow (control point sits at the
   * parent's radius, rotated to the child's angle). See
   * radialEdgeControlPoint below.
   */
  curveTension: number;
  /** Horizontal spacing (px) between independent root components when a
   *  mindmap has more than one top-level root node. */
  rootSpacing: number;
  /** Angle (radians) the sweep starts from when no first-ring node
   *  carries a pos hint. -PI/2 = straight up, sweeping clockwise. */
  startAngle: number;
}

export const RADIAL_DEFAULTS: RadialOptions = {
  R1: 190,
  ringGap: 150,
  labelPad: 20,
  cjkCharPx: 14,
  latinCharPx: 7,
  labelBasePx: 24,
  curveTension: 0.65,
  rootSpacing: 900,
  startAngle: -Math.PI / 2,
};

// ============================================================================
// Label width estimate — CJK glyphs count "double" a Latin glyph.
// ============================================================================

// Coarse ranges covering the CJK-ish scripts we actually see in titles:
// Hangul jamo/syllables, Hiragana/Katakana, CJK Unified + ext A, CJK
// compatibility, fullwidth forms. Good enough for an *estimate* — exact
// glyph metrics are a visual-tuning concern, not an engine concern.
const CJK_RANGES: Array<[number, number]> = [
  [0x1100, 0x11ff],
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
];

function isCjkCodePoint(cp: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/** Approximate rendered pixel width of a node title. */
export function estimateLabelWidthPx(
  title: string,
  opts: RadialOptions = RADIAL_DEFAULTS
): number {
  let cjk = 0;
  let latin = 0;
  for (const ch of Array.from(title || '')) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjkCodePoint(cp)) cjk++;
    else latin++;
  }
  return opts.labelBasePx + cjk * opts.cjkCharPx + latin * opts.latinCharPx;
}

// ============================================================================
// Geometry helpers
// ============================================================================

const TWO_PI = Math.PI * 2;

function normalizeAngle(a: number): number {
  let x = a % TWO_PI;
  if (x < 0) x += TWO_PI;
  return x;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Deterministic sibling order: sort_order, then id as a final tie-break. */
function sortSiblings(nodes: MindmapNode[]): MindmapNode[] {
  return [...nodes].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id)
  );
}

/** (0,0) is the documented "no hint left" placeholder value (contracts'
 *  MindmapNode comment: "agents can leave them at 0"). */
function hasHintPos(n: MindmapNode): boolean {
  return !!(n.pos_x || n.pos_y);
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Compute a deterministic radial layout for a mindmap's node set.
 *
 * Returns a Map from node id -> {x, y} in "engine space" (root of the
 * first component at the origin). Positions are computed as if every
 * node were fully expanded — fold/visibility is entirely the caller's
 * concern, mirroring tree mode's fold-as-visibility principle.
 *
 * Free-floating notes (parent_id null, level !== 'root') are omitted
 * from the result — see module doc comment.
 */
export function radialLayout(
  nodes: MindmapNode[],
  opts?: Partial<RadialOptions>
): Map<string, { x: number; y: number }> {
  const o: RadialOptions = { ...RADIAL_DEFAULTS, ...opts };
  const result = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return result;

  const byId = new Map(nodes.map((n) => [n.id, n]));

  const isFreeNote = (n: MindmapNode) => !n.parent_id && n.level !== 'root';
  const structural = nodes.filter((n) => !isFreeNote(n));
  if (structural.length === 0) return result;
  const structuralIds = new Set(structural.map((n) => n.id));

  // Orphan defense: a node whose parent_id doesn't resolve to a
  // structural node (missing, or itself filtered out as a free note)
  // is promoted to its own root component instead of throwing data
  // away or risking a cycle.
  const resolvedParentId = (n: MindmapNode): string | null => {
    if (!n.parent_id) return null;
    if (n.parent_id === n.id) return null; // self-reference — treat as a root, not a self-loop
    if (!structuralIds.has(n.parent_id)) return null;
    return n.parent_id;
  };

  const childrenOf = new Map<string, MindmapNode[]>();
  for (const n of structural) {
    const pid = resolvedParentId(n);
    if (pid === null) continue;
    const arr = childrenOf.get(pid) ?? [];
    arr.push(n);
    childrenOf.set(pid, arr);
  }
  for (const [k, arr] of childrenOf) childrenOf.set(k, sortSiblings(arr));

  const roots = sortSiblings(structural.filter((n) => resolvedParentId(n) === null));

  // ---- leaf counts (post-order) — drive proportional angular width ----
  const leafCount = new Map<string, number>();
  const computeLeaf = (id: string): number => {
    const cached = leafCount.get(id);
    if (cached !== undefined) return cached;
    const kids = childrenOf.get(id) ?? [];
    const v = kids.length === 0 ? 1 : kids.reduce((s, k) => s + computeLeaf(k.id), 0);
    leafCount.set(id, v);
    return v;
  };
  for (const r of roots) computeLeaf(r.id);

  // ---- raw (pre-rotation) angle + own half-sector-width per node ----
  // Proportional partition of the parent's angular sector by leaf
  // count — deeper nodes fan out inside their parent's wedge (brief:
  // "subtree angular span proportional to leaf count").
  interface AngleInfo {
    rawAngle: number;
    depth: number;
  }
  const angleInfo = new Map<string, AngleInfo>();

  const partition = (parentId: string, sectorStart: number, sectorWidth: number, depth: number) => {
    const kids = childrenOf.get(parentId) ?? [];
    if (kids.length === 0) return;
    const total = leafCount.get(parentId) ?? kids.length;
    let cursor = sectorStart;
    for (const kid of kids) {
      const kidLeaf = leafCount.get(kid.id) ?? 1;
      const width = total > 0 ? sectorWidth * (kidLeaf / total) : sectorWidth / kids.length;
      const center = cursor + width / 2;
      angleInfo.set(kid.id, { rawAngle: normalizeAngle(center), depth });
      partition(kid.id, cursor, width, depth + 1);
      cursor += width;
    }
  };

  for (const root of roots) {
    angleInfo.set(root.id, { rawAngle: 0, depth: 0 });
    partition(root.id, 0, TWO_PI, 1);
  }

  // ---- first-ring hint rotation (best-effort quadrant match) ----
  // Only the first hinted direct child of each root (lowest sort_order)
  // anchors the rotation — deterministic, no averaging of conflicting
  // hints. Every other node in that root's component rotates rigidly
  // along with it.
  const rotationByRoot = new Map<string, number>();
  for (const root of roots) {
    const kids = childrenOf.get(root.id) ?? [];
    let rotation = o.startAngle;
    for (const kid of kids) {
      if (hasHintPos(kid)) {
        const hintAngle = normalizeAngle(Math.atan2(kid.pos_y, kid.pos_x));
        const raw = angleInfo.get(kid.id)!.rawAngle;
        rotation = normalizeAngle(hintAngle - raw);
        break;
      }
    }
    rotationByRoot.set(root.id, rotation);
  }

  // ---- group nodes by (root component, depth) for ring collision ----
  const rootOfNode = new Map<string, string>();
  for (const root of roots) {
    const stack: string[] = [root.id];
    while (stack.length) {
      const id = stack.pop()!;
      rootOfNode.set(id, root.id);
      for (const kid of childrenOf.get(id) ?? []) stack.push(kid.id);
    }
  }

  const nodesByRootAndDepth = new Map<string, Map<number, string[]>>();
  for (const root of roots) nodesByRootAndDepth.set(root.id, new Map());
  for (const n of structural) {
    const info = angleInfo.get(n.id);
    if (!info || info.depth === 0) continue;
    const rid = rootOfNode.get(n.id)!;
    const byDepth = nodesByRootAndDepth.get(rid)!;
    const arr = byDepth.get(info.depth) ?? [];
    arr.push(n.id);
    byDepth.set(info.depth, arr);
  }

  // ---- ring radius: closed-form collision solve, deterministic ----
  // Angular gaps between adjacent nodes on a ring are fixed by the
  // topology (proportional partition above); they don't change with
  // radius. What DOES change with radius is how much *arc length* that
  // fixed angular gap buys — arc length = angle * radius. So instead of
  // iteratively growing the radius and re-checking, solve directly for
  // the minimum radius that makes every adjacent pair's fixed angular
  // gap wide enough to fit both labels' half-widths: this is
  // mathematically equivalent to "bump the radius until it fits" but
  // exact and guaranteed to terminate (no search loop).
  const EPS = 1e-6;
  const ringRadius = new Map<string, number>(); // key: `${rootId}:${depth}`
  for (const root of roots) {
    const byDepth = nodesByRootAndDepth.get(root.id)!;
    for (const [depth, ids] of byDepth) {
      const base = o.R1 + (depth - 1) * o.ringGap;
      let required = base;
      if (ids.length > 1) {
        const items = ids
          .map((id) => ({
            angle: angleInfo.get(id)!.rawAngle,
            halfExtentPx: estimateLabelWidthPx(byId.get(id)!.title, o) / 2 + o.labelPad / 2,
          }))
          .sort((a, b) => a.angle - b.angle);
        for (let i = 0; i < items.length; i++) {
          const a = items[i]!;
          const isLastPair = i === items.length - 1;
          const b = items[isLastPair ? 0 : i + 1]!;
          const gap = isLastPair ? b.angle + TWO_PI - a.angle : b.angle - a.angle;
          const safeGap = gap < EPS ? EPS : gap;
          const req = (a.halfExtentPx + b.halfExtentPx) / safeGap;
          if (req > required) required = req;
        }
      }
      ringRadius.set(`${root.id}:${depth}`, required);
    }
  }

  // ---- final Cartesian coordinates ----
  roots.forEach((root, rootIndex) => {
    const offsetX = rootIndex * o.rootSpacing;
    const rotation = rotationByRoot.get(root.id) ?? o.startAngle;
    const walk = (id: string) => {
      const info = angleInfo.get(id)!;
      if (info.depth === 0) {
        result.set(id, { x: offsetX, y: 0 });
      } else {
        const radius = ringRadius.get(`${root.id}:${info.depth}`) ?? o.R1;
        const finalAngle = normalizeAngle(info.rawAngle + rotation);
        result.set(id, {
          x: offsetX + radius * Math.cos(finalAngle),
          y: radius * Math.sin(finalAngle),
        });
      }
      for (const kid of childrenOf.get(id) ?? []) walk(kid.id);
    };
    walk(root.id);
  });

  return result;
}

// ============================================================================
// Edge geometry helper — for the caller's SVG rendering.
// ============================================================================

/**
 * Quadratic-curve control point for a radial-mode edge from `parent` to
 * `child`, both already in the same translated canvas space as `origin`
 * (the map's visual center — usually the root's rendered position).
 *
 * Blends between a plain straight-line midpoint (curveTension 0) and a
 * "radial sweep" elbow at the parent's own radius but rotated to the
 * child's angle (curveTension 1) — the classic radial-tree link shape
 * that reads as an arc swinging around the center rather than a chord
 * cutting through it.
 */
export function radialEdgeControlPoint(
  origin: { x: number; y: number },
  parent: { x: number; y: number },
  child: { x: number; y: number },
  opts?: Partial<RadialOptions>
): { x: number; y: number } {
  const o: RadialOptions = { ...RADIAL_DEFAULTS, ...opts };
  const straightMidX = (parent.x + child.x) / 2;
  const straightMidY = (parent.y + child.y) / 2;
  const parentR = Math.hypot(parent.x - origin.x, parent.y - origin.y);
  const childAngle = Math.atan2(child.y - origin.y, child.x - origin.x);
  const sweepX = origin.x + parentR * Math.cos(childAngle);
  const sweepY = origin.y + parentR * Math.sin(childAngle);
  const t = clamp01(o.curveTension);
  return {
    x: straightMidX + (sweepX - straightMidX) * t,
    y: straightMidY + (sweepY - straightMidY) * t,
  };
}
