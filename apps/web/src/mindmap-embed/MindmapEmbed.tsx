import { useEffect, useMemo, useRef, useState } from 'react';
import type { Mindmap as MindmapModel, MindmapNode } from '@learn-shell/contracts';
import { useT } from '../i18n';

/**
 * MindmapEmbed — lesson-page inline mind map (嵌入导图定稿·终局形态).
 *
 * 静态渲染，零交互（终审裁决 2026-07-06 午后）："可移动可缩放的效果完全
 * 没有之前那样一目了然。" 布局职责已正式移交备课侧——lesson-prep skill 军规
 * 要求 agent 备课时按 3:1 画布手排 0-100 百分比坐标（参照 7/2 老图的排法），
 * verify 闸拦截全 0 图；GDP 那张裸图已由发包人手排坐标回写数据库。本组件只
 * 负责呈现：一次布局、一次呈现，鼠标划过不发生任何事，文本选择等行为回归
 * 浏览器默认。
 *
 * 形态史（完整弧线，供后来者避坑）：嵌入导图定稿 一版给静态缩略图加 pan/zoom + 正方
 * 形虚拟画布 → 正方形坐标系把手排的宽扁布局拉散（"连线特别长"）；嵌入导图窗口适配案 二版
 * radial fallback 在 3:1 框里 fit 后文字 ~4px；三版横向分层树可读但被裁
 * "要 radial 观感"；四版百分比空间放射 + 帧比例映射（布局层保留至今）；终
 * 审拆掉全部交互——可拖可缩不如一目了然。教训：内嵌图是【地图缩略图】，
 * 不是编辑器视口。五轮精修：字号提到 12/13px（不可牺牲项，空间不够调坐标
 * 不缩字）、连线裁剪到 pill 边缘（不穿底）、fit 余量压到 4px。
 *
 * 保留的两层：
 *
 * 1. 帧比例位置映射——两条路径共用：
 *        canvas_x = pct_x / 100 × FRAME_BASIS_W   (718)
 *        canvas_y = pct_y / 100 × FRAME_BASIS_H   (240)
 *    只拉伸【位置】，pill 与文字不变形（与最早的 preserveAspectRatio=none
 *    整体拉伸渲染的唯一刻意差异：旧版连字都拉扁）。
 *      - 有有效坐标（原始 pos bbox 宽或高 ≥ 1）→ 备课手排的百分比直接进管道
 *      - 无有效坐标（全 0 / 全部重叠）→ radialPercentLayout 安全网生成。
 *        正常情况下备课军规 + verify 闸保证它永不触发；触发也是静态渲染
 *
 * 2. 一次性静态 fit——防边缘裁切的安全网，不是交互：内容 bbox（含 pill 实
 *    宽）超出画框时静态缩一次并居中；不放大、无动画。fit 需要真实 DOM 测
 *    量，保留逐帧重试直到首次成功（document.hidden 时 Chrome 冻结 rAF 的
 *    验收教训——排队的帧要等窗口可见才来），成功后除容器尺寸变化外不再动。
 *    ResizeObserver 保留（取舍：课文页主列会随窗口/Live 面板收窄，去掉它
 *    窄窗口下右缘会被永久裁切；它只做静态重排，等价于 CSS 响应式，与"禁
 *    交互"无冲突）。
 */

// Frame-proportional mapping basis — the lesson-page embed frame as measured
// on the learner's window (嵌入导图窗口适配案). Positions stretch to this aspect; any
// difference from the actual on-screen frame is absorbed by the static fit.
const FRAME_BASIS_W = 718;
const FRAME_BASIS_H = 240;

// 余量归零（五轮）："整体布局尽量利用好空间" — 只留防裁切的最低限。
const FIT_PADDING_PX = 4;
// Fit may scale UP as well as down (6轮反馈: "把连线缩短，整体还是可以再
// 继续 scale up"——tight layouts should fill the frame, not float in it).
// Capped so a 3-node map doesn't render as a billboard; the font constants
// remain the floor, scale-up is a bonus on top of them, never a substitute.
const MAX_STATIC_SCALE = 1.5;
const EMBED_HEIGHT_PX = 240; // unchanged from the old MindmapMiniView

// 字号（五轮，不可牺牲项）。git 考古：抽出前的 MindmapMiniView 基准是
// root 11px / body 10px（65d9c37 引入起从未变过，四轮线上值与之相同）——
// 学习者看到的"字号变小"来自 fit 缩放而非 CSS 值，"恢复基准"治不了病。
// 发包人重排 GDP 坐标时按 12px pill 实宽估算，故落地 body 12px（root 略
// 大一号 13px）与坐标工作对齐；空间不够时报告溢出 pill 调坐标，禁止缩字。
const FONT_ROOT_PX = 13;
const FONT_BODY_PX = 12;
// 连线两端沿方向裁剪到 pill 边缘后再留的空隙（五轮：线画到边缘不画到中心）。
const LINE_INSET_PX = 2;

// ---- radialPercentLayout tunables (all in 0-100 percentage space) ----
// Safety-net generator only — see module doc. Radii read as percentages of
// the frame; after the frame mapping a "circle" here becomes a wide ellipse
// (x-radius ×7.18px/pct, y-radius ×2.4px/pct) — the squash is the desired
// radial look, not an artifact.
const PCT_CENTER = 50;
const PCT_BRANCH_R = 24;
const PCT_DETAIL_R = 40;
// Adjacent detail siblings alternate ±stagger on their ring radius so a
// crowded sector reads as two interleaved arcs instead of one solid wall.
const PCT_DETAIL_STAGGER = 5;
// Depth ≥ 3 (notes under details, etc.) steps further out per level.
const PCT_RING_STEP = 14;
// Sweep starts straight up, clockwise — same convention as the full-page
// radial engine.
const PCT_START_ANGLE = -Math.PI / 2;
// Stragglers (free-floating notes with no tree membership) park in a row
// near the bottom of the percentage frame in fallback mode.
const PCT_STRAGGLER_X0 = 8;
const PCT_STRAGGLER_STEP = 14;
const PCT_STRAGGLER_Y = 94;

type Pos = { x: number; y: number };
type Fit = { scale: number; tx: number; ty: number };

/**
 * Percentage-space radial generator for maps with no authored layout:
 * root pinned at (50,50), depth-1 branches share the full 360° with
 * angular sectors proportional to their subtree leaf counts (heavy
 * branches get room), every deeper node fans out inside its parent's
 * sector — recursive proportional partition, deterministic (sort_order,
 * id tie-break), no randomness.
 *
 * Radii: branches on a tight inner ring, details on an outer ring with
 * alternating ±stagger, deeper levels stepping further out. All values in
 * 0-100 space — the shared frame mapping downstream turns these circles
 * into frame-filling ellipses.
 *
 * Multiple roots (rare, defensive): each root component gets an equal
 * horizontal slice of the frame and proportionally shrunken radii.
 * Free-floating notes are skipped (caller parks them in a straggler row).
 */
function radialPercentLayout(nodes: MindmapNode[]): Map<string, Pos> {
  const out = new Map<string, Pos>();

  const isFreeNote = (n: MindmapNode) => !n.parent_id && n.level !== 'root';
  const structural = nodes.filter((n) => !isFreeNote(n));
  const idSet = new Set(structural.map((n) => n.id));
  // Orphan defense: unresolvable parent (missing, or filtered out as a
  // free note) promotes the node to a root component. Cycles in corrupted
  // data are unreachable from any root and fall through to the caller's
  // straggler row.
  const parentOf = (n: MindmapNode): string | null =>
    n.parent_id && n.parent_id !== n.id && idSet.has(n.parent_id) ? n.parent_id : null;

  const bySort = (a: MindmapNode, b: MindmapNode) =>
    (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id);

  const children = new Map<string, MindmapNode[]>();
  for (const n of structural) {
    const pid = parentOf(n);
    if (!pid) continue;
    const arr = children.get(pid) ?? [];
    arr.push(n);
    children.set(pid, arr);
  }
  for (const [k, arr] of children) children.set(k, [...arr].sort(bySort));
  const roots = structural.filter((n) => parentOf(n) === null).sort(bySort);
  if (roots.length === 0) return out;

  // Subtree leaf counts drive proportional angular width.
  const leafCount = new Map<string, number>();
  const countLeaves = (id: string): number => {
    const cached = leafCount.get(id);
    if (cached !== undefined) return cached;
    const kids = children.get(id) ?? [];
    const v = kids.length === 0 ? 1 : kids.reduce((s, k) => s + countLeaves(k.id), 0);
    leafCount.set(id, v);
    return v;
  };
  for (const r of roots) countLeaves(r.id);

  // Multiple roots share the frame horizontally with shrunken radii.
  const rScale = 1 / roots.length;

  roots.forEach((root, rootIdx) => {
    const cx = ((rootIdx + 0.5) * 100) / roots.length;
    out.set(root.id, { x: cx, y: PCT_CENTER });

    // Recursive proportional sector partition. Each node's angle is the
    // center of its own sub-sector inside the parent's sector.
    const place = (
      parentId: string,
      sectorStart: number,
      sectorWidth: number,
      depth: number
    ) => {
      const kids = children.get(parentId) ?? [];
      if (kids.length === 0) return;
      const total = leafCount.get(parentId) ?? kids.length;
      let cursor = sectorStart;
      kids.forEach((kid, i) => {
        const kidLeaf = leafCount.get(kid.id) ?? 1;
        const width =
          total > 0 ? sectorWidth * (kidLeaf / total) : sectorWidth / kids.length;
        const angle = cursor + width / 2;
        const baseR =
          depth === 1
            ? PCT_BRANCH_R
            : PCT_DETAIL_R +
              (depth - 2) * PCT_RING_STEP +
              (i % 2 === 0 ? -PCT_DETAIL_STAGGER : PCT_DETAIL_STAGGER);
        const r = baseR * rScale;
        out.set(kid.id, {
          x: cx + r * Math.cos(angle),
          y: PCT_CENTER + r * Math.sin(angle),
        });
        place(kid.id, cursor, width, depth + 1);
        cursor += width;
      });
    };
    place(root.id, PCT_START_ANGLE, Math.PI * 2, 1);
  });

  return out;
}

/**
 * Per-node canvas positions for the embed. Both paths produce 0-100
 * percentage coordinates, then share one frame-proportional mapping:
 * x = pct/100 × FRAME_BASIS_W, y = pct/100 × FRAME_BASIS_H. Positions
 * stretch to the wide-flat frame; pills and text stay undistorted.
 *
 * Detection: a map counts as having NO authored layout when the raw pos
 * bbox is degenerate — width AND height both < 1 pos-unit (all pos 0 /
 * null → coerced 0, or all stacked on one point). Authored maps (备课军规
 * 手排的 0-100 布局) trivially clear 1 unit of spread on at least one axis.
 */
function computeEmbedPositions(nodes: MindmapNode[]): Map<string, Pos> {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const x = n.pos_x ?? 0;
    const y = n.pos_y ?? 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const hasAuthoredLayout =
    nodes.length > 0 && (maxX - minX >= 1 || maxY - minY >= 1);

  const pct: Map<string, Pos> = hasAuthoredLayout
    ? new Map(nodes.map((n) => [n.id, { x: n.pos_x ?? 0, y: n.pos_y ?? 0 }]))
    : radialPercentLayout(nodes);

  // Defensive (fallback path only in practice): nodes the generator
  // skipped — free-floating notes — park in a row near the bottom of the
  // frame instead of stacking at origin.
  let stragglerIdx = 0;
  for (const n of nodes) {
    if (pct.has(n.id)) continue;
    pct.set(n.id, {
      x: PCT_STRAGGLER_X0 + stragglerIdx * PCT_STRAGGLER_STEP,
      y: PCT_STRAGGLER_Y,
    });
    stragglerIdx++;
  }

  // Shared frame-proportional mapping.
  const out = new Map<string, Pos>();
  for (const [id, p] of pct) {
    out.set(id, {
      x: (p.x / 100) * FRAME_BASIS_W,
      y: (p.y / 100) * FRAME_BASIS_H,
    });
  }
  return out;
}

// Defensive (自动分页兜底案 同族): a node with no usable string id can't be
// addressed by anything downstream (Map keys, ref tracking, link
// endpoints) — drop it rather than let it silently collide with/shadow
// a real node under an `undefined` key. This is the "坏节点跳过不整图
// 白屏" half of the fix; the write-side validator (add_mindmap_seed)
// is the half that stops this from being written in the first place.
function dropNodesWithoutId(nodes: MindmapNode[]): MindmapNode[] {
  const seen = new Set<string>();
  return nodes.filter((n) => {
    if (typeof n.id !== 'string' || n.id === '' || seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}

export default function MindmapEmbed({ mindmap }: { mindmap: MindmapModel }) {
  const { t } = useT();
  const nodes = useMemo(() => dropNodesWithoutId(mindmap.content.nodes), [mindmap.content.nodes]);
  // 2026-07-11 定版：嵌入不画 root 药丸——课名已经是页面标题，root 挤
  // 在画布正中央零信息量。空态判断因此看"去掉 root 还剩不剩东西"，而不是
  // 原始 nodes.length：一张只有 root 的图现在也该走占位态，不是渲染孤零零
  // 一个不会被画出来的节点导致的空白无提示。
  const hasRenderableNodes = useMemo(
    () => nodes.some((n) => n.level !== 'root'),
    [nodes]
  );

  if (!hasRenderableNodes) {
    return (
      <div
        className="border border-dashed border-[var(--ls-border)] text-center text-[12px] leading-4 text-[var(--ls-text-tertiary)]"
        style={{ padding: '24px', borderRadius: '8px' }}
      >
        {t('lesson.mindmapEmbed.clearedPrefix')}<em>{t('mindmap.restoreAgentVersion')}</em>{t('lesson.mindmapEmbed.clearedSuffix')}
      </div>
    );
  }

  return <MindmapEmbedCanvas nodes={nodes} links={mindmap.content.links} />;
}

function MindmapEmbedCanvas({
  nodes,
  links,
}: {
  nodes: MindmapNode[];
  links: MindmapModel['content']['links'];
}) {
  // Authored-percentage or radial-percent fallback — both land in the same
  // frame-proportional pixel space; everything below reads only this map.
  // `nodes` (root included) feeds the layout so 防御性解析守则's orphan-reparenting
  // hardening in radialPercentLayout keeps its full tree to reason about;
  // root is only stripped from what actually gets painted, below.
  const positions = useMemo(() => computeEmbedPositions(nodes), [nodes]);

  // Root is hidden from the embed's paint (2026-07-11 定版): it still gets a
  // position from computeEmbedPositions above (harmless, unused pixels) —
  // this list is what fit-measurement and rendering read instead of `nodes`.
  const visibleNodes = useMemo(() => nodes.filter((n) => n.level !== 'root'), [nodes]);

  const canvasRef = useRef<HTMLDivElement>(null);
  const pillRefs = useRef(new Map<string, HTMLDivElement>());

  // Static fit — null until the first successful measurement. Paint is
  // gated on it (opacity 0) so the map never flashes unfitted.
  const [fit, setFit] = useState<Fit | null>(null);

  // One-shot fit computation off real DOM measurements. Returns null when
  // the canvas or pills aren't measurable yet — callers retry. Down-scale
  // only (never zooms in past 100%), centered. This is a clipping safety
  // net, not a viewport.
  const computeFit = (): Fit | null => {
    const canvas = canvasRef.current;
    if (!canvas || visibleNodes.length === 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let measuredAny = false;
    for (const n of visibleNodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      const el = pillRefs.current.get(n.id);
      // offsetWidth/Height are unaffected by the CSS transform, so this is
      // valid to measure regardless of any currently applied fit.
      if (el && el.offsetWidth > 0) measuredAny = true;
      const halfW = el ? el.offsetWidth / 2 : 40;
      const halfH = el ? el.offsetHeight / 2 : 14;
      minX = Math.min(minX, p.x - halfW);
      maxX = Math.max(maxX, p.x + halfW);
      minY = Math.min(minY, p.y - halfH);
      maxY = Math.max(maxY, p.y + halfH);
    }
    // No positioned node, or pills not laid out yet (all zero-width) — the
    // numbers would be garbage; report failure so the caller retries.
    if (!Number.isFinite(minX) || !measuredAny) return null;
    const bboxW = Math.max(1, maxX - minX);
    const bboxH = Math.max(1, maxY - minY);
    const scale = Math.min(
      MAX_STATIC_SCALE,
      (rect.width - FIT_PADDING_PX * 2) / bboxW,
      (rect.height - FIT_PADDING_PX * 2) / bboxH
    );
    return {
      scale,
      tx: (rect.width - bboxW * scale) / 2 - minX * scale,
      ty: (rect.height - bboxH * scale) / 2 - minY * scale,
    };
  };

  // Ref-indirection so the ResizeObserver (registered once) always calls
  // the current render's computeFit — otherwise it'd close over stale
  // `nodes`/`positions` after Restore/Clear-&-redo swaps content.
  const computeFitRef = useRef(computeFit);
  computeFitRef.current = computeFit;

  // Fit once per layout, retrying every frame until the first success.
  // rAF (not a one-shot timer): when the tab is hidden Chrome freezes rAF
  // and the queued frame arrives once the window becomes visible — a timer
  // would fire against a zero-size canvas and permanently miss (真机验收
  // 教训 2026-07-06). Capped so a pathological map still paints. After the
  // first success this effect never touches the transform again.
  useEffect(() => {
    const MAX_FIT_ATTEMPTS = 120;
    let attempts = 0;
    let raf: number;
    const tryFit = () => {
      attempts++;
      const f = computeFitRef.current();
      if (f) {
        setFit(f);
        return;
      }
      if (attempts >= MAX_FIT_ATTEMPTS) {
        setFit({ scale: 1, tx: 0, ty: 0 });
        return;
      }
      raf = requestAnimationFrame(tryFit);
    };
    raf = requestAnimationFrame(tryFit);
    return () => cancelAnimationFrame(raf);
  }, [positions]);

  // Container resize (window resize, Live-panel squeeze) → recompute the
  // static fit. Not interaction — responsive layout, same as CSS; without
  // it a narrowed lesson column would clip the map's right edge forever.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const f = computeFitRef.current();
      if (f) setFit(f);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const posOf = (id: string): Pos | undefined => positions.get(id);

  // Pill half-extents for line clipping — measured DOM size when the ref is
  // mounted (the visible frame always is: paint is gated on fit, which only
  // lands after a successful measurement pass), estimated from the title
  // otherwise (first invisible pass / defensive).
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const pillHalf = (id: string): { hw: number; hh: number } => {
    const el = pillRefs.current.get(id);
    if (el && el.offsetWidth > 0) {
      return { hw: el.offsetWidth / 2, hh: el.offsetHeight / 2 };
    }
    const n = nodeById.get(id);
    const isRoot = n?.level === 'root';
    const font = isRoot ? FONT_ROOT_PX : FONT_BODY_PX;
    let w = (isRoot ? 24 : 16) + 2; // horizontal padding + border
    for (const ch of n?.title ?? '') {
      w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? font : font * 0.5;
    }
    const h = font * 1.2 + (isRoot ? 12 : 6) + 2;
    return { hw: w / 2, hh: h / 2 };
  };

  // 连线画到 pill 边缘（五轮）：沿连线方向把两端各裁剪到该端 pill 的包围盒
  // 边缘再留 LINE_INSET_PX 空隙。老渲染是中心到中心、线穿 pill 底下，root
  // 一侧的视觉线长被 pill 半宽虚增——裁剪后线只在空白区可见，视觉立减。
  // 两端裁完不剩正长度（pill 相邻/重叠）时不画线。
  const clipLine = (
    a: Pos,
    b: Pos,
    aId: string,
    bId: string
  ): { x1: number; y1: number; x2: number; y2: number } | null => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return null;
    const ux = dx / len;
    const uy = dy / len;
    // Distance from a pill's center to its bounding-box edge along (ux,uy).
    const exitDist = (half: { hw: number; hh: number }): number =>
      Math.min(
        Math.abs(ux) > 1e-6 ? half.hw / Math.abs(ux) : Infinity,
        Math.abs(uy) > 1e-6 ? half.hh / Math.abs(uy) : Infinity
      );
    const tA = exitDist(pillHalf(aId)) + LINE_INSET_PX;
    const tB = exitDist(pillHalf(bId)) + LINE_INSET_PX;
    if (tA + tB >= len) return null;
    return {
      x1: a.x + ux * tA,
      y1: a.y + uy * tA,
      x2: b.x - ux * tB,
      y2: b.y - uy * tB,
    };
  };

  return (
    <div
      ref={canvasRef}
      className="relative border border-[var(--ls-border)] bg-[var(--ls-bg-subtle)] overflow-hidden"
      style={{ height: `${EMBED_HEIGHT_PX}px`, borderRadius: '8px' }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          transform: fit
            ? `translate(${fit.tx}px, ${fit.ty}px) scale(${fit.scale})`
            : undefined,
          opacity: fit ? 1 : 0,
        }}
      >
        <svg
          className="absolute pointer-events-none"
          style={{ left: 0, top: 0, overflow: 'visible' }}
          width={FRAME_BASIS_W}
          height={FRAME_BASIS_H}
        >
          {visibleNodes
            // Root itself is already excluded (visibleNodes); also drop any
            // line whose *parent* is root — hidden root, zero dangling
            // lines — "悬空线一根不留".
            .filter((n) => n.parent_id && nodeById.get(n.parent_id)?.level !== 'root')
            .map((n) => {
              const parent = posOf(n.parent_id!);
              const self = posOf(n.id);
              if (!parent || !self) return null;
              const seg = clipLine(parent, self, n.parent_id!, n.id);
              if (!seg) return null;
              return (
                <line
                  key={`pc-${n.id}`}
                  x1={seg.x1}
                  y1={seg.y1}
                  x2={seg.x2}
                  y2={seg.y2}
                  stroke="var(--ls-text-tertiary)"
                  strokeWidth={1}
                />
              );
            })}
          {links
            // Same rule for free-floating links: either end touching the
            // hidden root drops the line rather than leaving it dangling.
            .filter(
              (l) =>
                nodeById.get(l.from_node_id)?.level !== 'root' &&
                nodeById.get(l.to_node_id)?.level !== 'root'
            )
            .map((l) => {
              const from = posOf(l.from_node_id);
              const to = posOf(l.to_node_id);
              if (!from || !to) return null;
              const seg = clipLine(from, to, l.from_node_id, l.to_node_id);
              if (!seg) return null;
              return (
                <line
                  key={`l-${l.id}`}
                  x1={seg.x1}
                  y1={seg.y1}
                  x2={seg.x2}
                  y2={seg.y2}
                  stroke="var(--ls-text-tertiary)"
                  strokeWidth={0.75}
                  strokeDasharray="4 3"
                  opacity={0.75}
                />
              );
            })}
        </svg>

        {visibleNodes.map((n) => {
          const p = posOf(n.id);
          if (!p) return null;
          const isRoot = n.level === 'root';
          const isBranch = n.level === 'branch';
          return (
            <div
              key={n.id}
              ref={(el) => {
                if (el) pillRefs.current.set(n.id, el);
                else pillRefs.current.delete(n.id);
              }}
              className="absolute -translate-x-1/2 -translate-y-1/2 inline-flex items-center rounded-full border bg-[var(--ls-bg)]"
              style={{
                left: p.x,
                top: p.y,
                padding: isRoot ? '6px 12px' : '3px 8px',
                borderColor: isRoot
                  ? 'var(--ls-text)'
                  : isBranch
                    ? 'var(--ls-border-strong)'
                    : 'var(--ls-border)',
                fontSize: isRoot ? `${FONT_ROOT_PX}px` : `${FONT_BODY_PX}px`,
                lineHeight: '1.2',
                fontWeight: isRoot ? 600 : isBranch ? 500 : 400,
                color: 'var(--ls-text)',
                whiteSpace: 'nowrap',
              }}
              title={n.title || n.id}
            >
              {n.title || n.id}
            </div>
          );
        })}
      </div>
    </div>
  );
}
