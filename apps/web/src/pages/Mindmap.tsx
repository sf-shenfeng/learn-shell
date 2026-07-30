import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Mindmap as MindmapModel,
  MindmapContent,
  MindmapId,
  MindmapNode,
  NodeLevel,
  PairId,
  PendingCardId,
  PendingCardSourceType,
  PendingMindmapCard,
} from '@learn-shell/contracts';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';
import { useT } from '../i18n';
import type { DictKey } from '../i18n/dict';
import { radialLayout, radialEdgeControlPoint } from '../mindmap/radialLayout';
import { focusOverlayStyle, FocusToggleButton } from '../shell/FocusOverlay';
import Kbd from '../shell/Kbd';
// Same sentinel + accordion vocabulary as Review page's Course▸Deck▸Cards
// grouping (导图课程分组) — this is 两级课程分组, its two-level sibling (Course▸
// mindmaps). Reusing the exported constant instead of re-declaring a
// magic string keeps "no course resolved" meaning one thing app-wide.
import { UNGROUPED_COURSE_KEY } from '../review/DeckRail';

/** mindmap.viewed 的防抖窗口 (最近接触, 2026-07-30) — 与
 *  document/DocumentReader.tsx 的同名常量同值同理由, 见下方 effect 的注释。 */
const VIEWED_DEBOUNCE_MS = 700;

// Same source-type → dict-key mapping as PoolDrawer/pool.source.* — pending
// cards shown here are the same PendingMindmapCard rows, just a different
// list view (mindmap landing page vs. the drawer).
const PENDING_SOURCE_LABEL_KEY: Record<PendingCardSourceType, DictKey> = {
  flashcard: 'pool.source.flashcard',
  lesson_highlight: 'pool.source.lessonHighlight',
  exercise: 'pool.source.exercise',
  manual: 'pool.source.manual',
  agent_seed: 'pool.source.agentSeed',
  annotation: 'pool.source.annotation',
};

/**
 * Mindmap — top-level page (G M).
 *
 * TEACHING-SPEC §6.7: aggregation + 自由编辑区.
 *   - 主区: 所有图按 scope 分组 (lesson / course / custom)
 *   - 顶部 "+ New mindmap" 创建 custom 空图
 *   - 右侧 PendingCard 池 (FSRS 难卡 / lesson_highlight / exercise_miss)
 *   - 点图卡进 detail view (mini SVG + reset/restore + clear)
 *
 * 深度交互 (拖拽节点 / 多关联编辑) 留 W2+. 当前以汇总+查看+清除/恢复为主.
 */
export default function Mindmap() {
  const { t } = useT();
  const repo = useRepository();
  const { pairId } = usePair();
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState<MindmapId | null>(null);

  // ?map=<id> 单向深链（URL→选中态）：Recent 栏等外部入口可直达具体图。
  // 未知/已删 id 由下方 find() 兜底回列表页；页内切图不回写 URL（最小刀口，
  // 双向同步等"分享当前图"需求出现再做）。导图深链案。
  const [searchParams] = useSearchParams();
  const mapParam = searchParams.get('map');
  useEffect(() => {
    if (mapParam) setSelectedId(mapParam as MindmapId);
  }, [mapParam]);

  const mindmapsQ = useQuery({
    queryKey: ['all-mindmaps', pairId],
    queryFn: () => (repo && pairId ? repo.getAllMindmaps(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });
  const all = mindmapsQ.data ?? [];

  const pendingQ = useQuery({
    queryKey: ['pending-cards', pairId],
    queryFn: () => (repo && pairId ? repo.getPendingCards(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });

  // ---- Course grouping (两级课程分组, two-level sibling of 导图课程分组's Course▸
  // Deck▸Cards) ----
  //
  // Unlike Review's deck→course (no FK at all, majority-vote over
  // flashcard.concept_id), Mindmap has a real many-to-many join table
  // (MindmapAssociation: mindmap_id → target_type/target_id). So the
  // chain here is a lookup, not a vote:
  //   - target_type 'course' → target_id IS the course_id already.
  //   - target_type 'lesson' → target_id is a lesson_id; lesson.course_id
  //     (a direct field, no bridge needed) resolves it the rest of the
  //     way. `lessonToCourse` below is just that field lifted into a map.
  // A mindmap with no association, or one that only resolves to a lesson
  // whose course isn't in `courses` (deleted/orphaned), falls into the
  // Ungrouped bucket — same "no vote wins" fallback as 导图课程分组.
  //
  // Query keys ['courses', pairId] / ['lessons', courseId] are the exact
  // shared cache Courses.tsx / Review.tsx / RecentRail already populate —
  // riding it here means no fresh fetch if the learner's been on those
  // pages this session. ['mindmap-associations', id] is a new key, but
  // GET /mindmaps/:id/associations is an existing endpoint (zero new
  // endpoints, per 两级课程分组 的既定约束).
  const coursesQ = useQuery({
    queryKey: ['courses', pairId],
    queryFn: () => (repo && pairId ? repo.getCourses(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });
  const courses = coursesQ.data ?? [];

  const lessonsQs = useQueries({
    queries: courses.map((c) => ({
      queryKey: ['lessons', c.id],
      queryFn: () => (repo ? repo.getLessons(c.id) : Promise.resolve([])),
      enabled: !!repo,
    })),
  });

  const lessonToCourse = useMemo(() => {
    const m = new Map<string, string>();
    courses.forEach((c, i) => {
      const lessons = lessonsQs[i]?.data ?? [];
      for (const lesson of lessons) m.set(lesson.id, c.id);
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courses, lessonsQs]);

  const associationsQs = useQueries({
    queries: all.map((m) => ({
      queryKey: ['mindmap-associations', m.id],
      queryFn: () => (repo ? repo.getMindmapAssociations(m.id) : Promise.resolve([])),
      enabled: !!repo,
    })),
  });

  // mindmap_id -> course_id | undefined (undefined = Ungrouped). A
  // custom map can carry multiple associations (multi-course/lesson);
  // first resolvable course wins — same single-bucket UX as 导图课程分组's
  // deckCourseId, just first-found instead of a majority vote (there's
  // rarely more than one or two associations per map).
  const mindmapCourseId = useMemo(() => {
    const result = new Map<string, string>();
    all.forEach((m, i) => {
      const assocs = associationsQs[i]?.data ?? [];
      const courseAssoc = assocs.find((a) => a.target_type === 'course');
      if (courseAssoc) {
        result.set(m.id, courseAssoc.target_id as string);
        return;
      }
      const lessonAssoc = assocs.find(
        (a) => a.target_type === 'lesson' && lessonToCourse.has(a.target_id as string)
      );
      if (lessonAssoc) {
        result.set(m.id, lessonToCourse.get(lessonAssoc.target_id as string)!);
      }
    });
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, associationsQs, lessonToCourse]);

  // Course groups in getCourses() order, Ungrouped bucket always last —
  // rendered as its own top-level accordion, default collapsed (same
  // shape/rule as 导图课程分组's courseGroups in Review.tsx).
  const courseGroups = useMemo(() => {
    const byCourse = new Map<string, MindmapModel[]>();
    for (const m of all) {
      const courseId = mindmapCourseId.get(m.id) ?? UNGROUPED_COURSE_KEY;
      let arr = byCourse.get(courseId);
      if (!arr) {
        arr = [];
        byCourse.set(courseId, arr);
      }
      arr.push(m);
    }
    const groups: Array<{ courseId: string; topic: string; maps: MindmapModel[] }> = [];
    for (const c of courses) {
      const maps = byCourse.get(c.id);
      if (maps && maps.length > 0) groups.push({ courseId: c.id, topic: c.topic, maps });
    }
    const ungrouped = byCourse.get(UNGROUPED_COURSE_KEY);
    if (ungrouped && ungrouped.length > 0) {
      groups.push({ courseId: UNGROUPED_COURSE_KEY, topic: '', maps: ungrouped });
    }
    return groups;
  }, [all, mindmapCourseId, courses]);

  // Per-course accordion open state — session-local, all-collapsed by
  // default (the actual fix for "随课程数线性变长"), same Set-of-open-keys
  // vocabulary as DeckRail's openCourses/openDecks.
  const [openCourseGroups, setOpenCourseGroups] = useState<ReadonlySet<string>>(new Set());
  const toggleCourseGroupOpen = (courseId: string) =>
    setOpenCourseGroups((prev) => {
      const next = new Set(prev);
      if (next.has(courseId)) next.delete(courseId);
      else next.add(courseId);
      return next;
    });

  const createMut = useMutation({
    mutationFn: async () => {
      if (!repo || !pairId) throw new Error('no repo');
      return repo.createMindmap({
        owner_pair_id: pairId,
        scope: 'custom',
        title: t('mindmap.untitledTitle'),
        source: 'user',
        content: { nodes: [], links: [] },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['all-mindmaps', pairId] }),
  });

  const dismissPending = useMutation({
    mutationFn: (id: PendingCardId) => {
      if (!repo) throw new Error('no repo');
      return repo.dismissPendingCard(id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pending-cards', pairId] }),
  });

  // mindmap.viewed 已读信号 (Recents 最近接触, 2026-07-30) — 打开某张图看
  // (点卡片进 detail, 或 ?map= 深链直达) 时发一枚, 同一张图每次打开只发一枚
  // (ref 按 mindmap_id 去重, StrictMode 双跑挡在同一个 ref 上)。跑的是
  // lesson.viewed 那条既有 sessions/events 轨道, payload 只有 mindmap_id。
  // fire-and-forget: 失败只吞不弹, 看图不被埋点打扰。
  //
  // 防抖 VIEWED_DEBOUNCE_MS 两个用处: ①列表里连着翻看不算"看过" ②等
  // PairProvider 把 pair 解析完 —— 它开机先给一个占位 pair (SEEDED_PAIR_ID),
  // 深链直达时 selectedId 在第一帧就有值, 立刻发会打到一个本机不存在的 pair
  // (片场实测: 500)。发失败还会把去重标记退回去, 下一次依赖变化(pair 落定)
  // 自己重试。
  const viewedFiredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId) {
      // 退回列表 = 这次接触结束; 再点开同一张算新的一次。
      viewedFiredForRef.current = null;
      return;
    }
    if (!repo || !pairId) return;
    if (viewedFiredForRef.current === selectedId) return;
    const mindmapId = selectedId;
    const timer = window.setTimeout(() => {
      viewedFiredForRef.current = mindmapId;
      repo
        .recordLearningEvent({
          pair_id: pairId,
          event_type: 'mindmap.viewed',
          mode: 'self_study',
          payload: { mindmap_id: mindmapId },
        })
        .then(() => {
          qc.invalidateQueries({ queryKey: ['recent-rail', 'mindmaps', pairId] });
        })
        .catch(() => {
          if (viewedFiredForRef.current === mindmapId) viewedFiredForRef.current = null;
        });
    }, VIEWED_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [repo, pairId, selectedId, qc]);

  if (!repo) {
    return (
      <div className="text-sm text-[var(--ls-text-secondary)]">
        {t('mindmap.emptyMode')}
      </div>
    );
  }

  const pending = pendingQ.data?.filter((p) => !p.placed_in_mindmap_id) ?? [];

  const selected = selectedId ? all.find((m) => m.id === selectedId) ?? null : null;

  if (selected) {
    return (
      <MindmapDetail
        mindmap={selected}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-baseline justify-between flex-wrap" style={{ gap: '14px', marginBottom: '6px' }}>
        <div className="flex items-baseline flex-wrap" style={{ gap: '14px' }}>
          <h1 className="font-bold text-[24px] leading-[32px] tracking-[-0.02em]" style={{ margin: 0 }}>
            {t('mindmap.title')}
          </h1>
          <span className="text-[13px] leading-[20px] text-[var(--ls-text-tertiary)]">
            {t('mindmap.subtitle')}
          </span>
        </div>
        <button
          type="button"
          onClick={() => createMut.mutate()}
          disabled={createMut.isPending}
          className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 disabled:opacity-50 transition-opacity duration-[var(--ls-duration-fast)]"
          style={{ height: '32px', padding: '0 13px', borderRadius: '6px', fontSize: '12px', lineHeight: '1', gap: '6px' }}
        >
          {t('mindmap.newMindmapButton')}
        </button>
      </div>

      {/* 2-col grid: maps + pending pool sidebar */}
      <div
        className="grid"
        style={{
          marginTop: '24px',
          gap: '20px',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(220px, 280px)',
        }}
      >
        {/* maps column */}
        <div className="flex flex-col" style={{ gap: '4px' }}>
          {courseGroups.length === 0 ? (
            <p
              className="border border-dashed border-[var(--ls-border)] text-[12px] leading-[18px] text-[var(--ls-text-tertiary)] text-center"
              style={{ padding: '20px', borderRadius: '8px' }}
            >
              {t('mindmap.group.noMindmapsHint')}
            </p>
          ) : (
            courseGroups.map((group) => (
              <CourseMapGroup
                key={group.courseId}
                label={
                  group.courseId === UNGROUPED_COURSE_KEY
                    ? t('mindmap.group.ungrouped')
                    : group.topic
                }
                maps={group.maps}
                open={openCourseGroups.has(group.courseId)}
                onToggle={() => toggleCourseGroupOpen(group.courseId)}
                onSelect={setSelectedId}
              />
            ))
          )}
        </div>

        {/* pending pool */}
        <aside
          className="border border-[var(--ls-border)]"
          style={{ padding: '14px 16px', borderRadius: '10px', alignSelf: 'flex-start' }}
        >
          <div
            className="text-[11px] font-medium leading-4 tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)]"
            style={{ marginBottom: '12px' }}
          >
            {t('mindmap.pendingPoolPrefix')}{pending.length}
          </div>
          {pending.length === 0 ? (
            <p className="text-[12px] leading-[18px] text-[var(--ls-text-tertiary)]">
              {t('mindmap.pendingPoolEmptyHint')}
            </p>
          ) : (
            <ul className="flex flex-col" style={{ gap: '8px' }}>
              {pending.map((p) => (
                <li
                  key={p.id}
                  className="border border-[var(--ls-border)] bg-[var(--ls-bg-subtle)]"
                  style={{ padding: '10px 12px', borderRadius: '8px' }}
                >
                  <div className="flex items-start justify-between" style={{ gap: '6px' }}>
                    <span
                      className="border tracking-[0.04em] text-[var(--ls-text-tertiary)]"
                      style={{
                        padding: '1px 6px',
                        borderRadius: '4px',
                        fontSize: '9px',
                        lineHeight: '12px',
                        borderColor: 'var(--ls-border)',
                      }}
                    >
                      {t(PENDING_SOURCE_LABEL_KEY[p.source_type] ?? 'pool.source.manual')}
                    </span>
                    <button
                      type="button"
                      onClick={() => dismissPending.mutate(p.id)}
                      className="text-[var(--ls-text-tertiary)] hover:text-[var(--ls-risk)]"
                      style={{ fontSize: '14px', lineHeight: 1 }}
                      title={t('mindmap.dismissTitle')}
                    >
                      ×
                    </button>
                  </div>
                  <div className="font-medium text-[12px] leading-4" style={{ marginTop: '6px' }}>
                    {p.title}
                  </div>
                  <p
                    className="text-[11px] leading-4 text-[var(--ls-text-secondary)]"
                    style={{ marginTop: '4px' }}
                  >
                    {p.content}
                  </p>
                  {p.reason && (
                    <div
                      className="text-[10px] leading-[14px] text-[var(--ls-text-tertiary)]"
                      style={{ marginTop: '6px' }}
                    >
                      {t('mindmap.reasonPrefix')}{p.reason}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * CourseMapGroup — Mind Map page's Course accordion (两级课程分组, two-level
 * sibling of Review's Course▸Deck▸Cards, 导图课程分组). Row style/tokens/chevron
 * are lifted directly from DeckRail's course header (font-semibold marks
 * the outer hierarchy level, same ▸ rotate + --ls-radius-control +
 * --ls-duration-fast vocabulary) — only the body swaps DeckRail's nested
 * deck list for this page's existing MapCard grid, since 两级课程分组 only needs
 * two levels (Course▸mindmaps), not three. Default collapsed is the whole
 * point: that's what keeps a growing course count from reading as "一眼到
 * 底" flat wall of cards.
 */
function CourseMapGroup({
  label,
  maps,
  open,
  onToggle,
  onSelect,
}: {
  label: string;
  maps: MindmapModel[];
  open: boolean;
  onToggle: () => void;
  onSelect: (id: MindmapId) => void;
}) {
  const { t } = useT();
  return (
    <section>
      <div className="w-full flex items-center rounded-[var(--ls-radius-control)] transition-colors duration-[var(--ls-duration-fast)] text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)]">
        <button
          type="button"
          onClick={onToggle}
          className="flex-none text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors"
          style={{ padding: '7px 0 7px 6px', lineHeight: '1', fontSize: '10px' }}
          title={open ? t('mindmap.group.browseClose') : t('mindmap.group.browseOpen')}
        >
          <span
            style={{
              display: 'inline-block',
              transform: open ? 'rotate(90deg)' : 'none',
              transition: 'transform var(--ls-duration-fast)',
            }}
          >
            ▸
          </span>
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center justify-between flex-1 min-w-0"
          style={{ padding: '7px 10px 7px 6px', gap: '8px' }}
        >
          <span
            className="text-[13px] leading-5 font-semibold truncate text-left flex-1 min-w-0"
            title={label}
          >
            {label}
          </span>
          <span className="flex-none text-[11px] leading-4 text-[var(--ls-text-tertiary)] tabular-nums">
            {maps.length}
          </span>
        </button>
      </div>
      {open && (
        <div
          className="grid"
          style={{
            gap: '12px',
            margin: '8px 0 12px',
            paddingLeft: '10px',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          }}
        >
          {maps.map((m) => (
            <MapCard key={m.id} mindmap={m} onSelect={onSelect} />
          ))}
        </div>
      )}
    </section>
  );
}

function MapCard({
  mindmap,
  onSelect,
}: {
  mindmap: MindmapModel;
  onSelect: (id: MindmapId) => void;
}) {
  const nodeCount = mindmap.content.nodes.length;
  const linkCount = mindmap.content.links.length;
  return (
    <button
      type="button"
      onClick={() => onSelect(mindmap.id)}
      className="text-left border border-[var(--ls-border)] bg-[var(--ls-bg)] hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
      style={{ padding: '14px 16px', borderRadius: '10px' }}
    >
      <div className="flex items-baseline justify-between flex-wrap" style={{ gap: '8px', marginBottom: '6px' }}>
        <span className="font-semibold text-[14px] leading-5">{mindmap.title}</span>
        <span
          className="border tracking-[0.04em] uppercase text-[var(--ls-text-tertiary)]"
          style={{
            padding: '1px 6px',
            borderRadius: '4px',
            fontSize: '9px',
            lineHeight: '12px',
            borderColor: 'var(--ls-border)',
          }}
        >
          {mindmap.source}
        </span>
      </div>
      <div className="text-[11px] leading-4 text-[var(--ls-text-tertiary)] tabular-nums">
        {nodeCount} nodes · {linkCount} links
      </div>
      {mindmap.has_been_reset && (
        <div
          className="text-[10px] leading-[14px]"
          style={{ marginTop: '6px', color: 'var(--ls-hypothesis)' }}
        >
          ⚠ cleared — restore agent version in detail
        </div>
      )}
    </button>
  );
}

/* -------------------------------------------------------------------------- */

/* ==========================================================================
 * MindmapDetail — editor v2 (2026-07-01 定向: "回归朴素思维导图, 树式展开").
 *
 * Layout: automatic left-to-right tree. Root nodes on the left; each level
 * offsets X_STEP px to the right; each parent sits at the vertical midpoint
 * of its children. Sibling children stack vertically in sort_order.
 * Positions in schema (pos_x/pos_y) are ignored by the editor — laid out
 * every render from parent_id + sort_order + is_expanded state.
 *
 * Fold/unfold: nodes with children carry a small +/− button. Toggling
 * flips is_expanded and re-lays out. Detail-level nodes ship collapsed by
 * default (fixture writes is_expanded: false), so the initial view shows
 * just root + branch + detail — clean framework.
 *
 * Interactions:
 *   - click node   → select for Inspector
 *   - click blank  → deselect
 *   - +/− on node  → toggle expand/collapse
 *   - Tab (sel)    → add child + auto-expand parent
 *   - Delete       → cascade remove
 *   - Esc          → deselect
 *   - "+ Root" btn → add a new root topic at bottom
 *
 * No drag. Auto layout is the whole point — dragging fights it.
 *
 * Autosave: 400ms debounced to updateMindmapContent, pill in toolbar.
 * ========================================================================== */

// Layout constants. Bracket-style lines let us pack levels closer than a
// bezier would, so X_STEP is deliberately tight — font sizes go up in
// exchange (see TreeNodePill).
//
// Pills are UNIFORM WIDTH (PILL_WIDTH) so peer nodes at the same depth
// left-align automatically: same x (from layout) + same width + centered
// transform ⇒ identical left edges. X_STEP > PILL_WIDTH gives room for
// visible bracket lines; 240-180 = 60px per gap reads cleanly (was 200,
// too tight — 2026-07-01 实机反馈 "节点之间的左右间距似乎也变小了").
// Note pills are wider (240) but still fit within the same X_STEP with
// enough margin.
const PILL_WIDTH = 180;
const NOTE_WIDTH = 240;
const X_STEP = 260;           // 200 → 260 for breathing room
const NODE_ROW_H = 60;        // 56 → 60 slightly more vertical air too
const CANVAS_PAD_X = 130;
const CANVAS_PAD_Y = 32;
const CANVAS_HEIGHT_PX = 560;
const PILL_HALF_WIDTH = PILL_WIDTH / 2;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
const DRAG_THRESHOLD_PX = 3;

// ---- Radial layout mode ("第一截: 引擎核心") -------------------
//
// Layout is a VIEW MODE, not a data property — same content, two ways to
// render it. Tree ⇄ Radial choice persists per-browser (not per-mindmap).
// The actual radial math lives in ../mindmap/radialLayout.ts (pure,
// deterministic); everything below is just wiring it into this editor's
// existing render/drag/fold pipeline.
type LayoutMode = 'tree' | 'radial';
const LAYOUT_MODE_STORAGE_KEY = 'learn-shell:mindmap:layout-mode';
const loadLayoutMode = (): LayoutMode => {
  if (typeof window === 'undefined') return 'tree';
  try {
    return window.localStorage.getItem(LAYOUT_MODE_STORAGE_KEY) === 'radial' ? 'radial' : 'tree';
  } catch {
    return 'tree';
  }
};
// Translate the engine's root-at-origin space into this editor's canvas
// space (same idea as tree mode's CANVAS_PAD_X/Y, picked so a freshly
// opened radial map sits in positive-coordinate territory before the
// very first auto-fit runs).
const RADIAL_ORIGIN_X = 520;
const RADIAL_ORIGIN_Y = 300;

const NODE_COLORS: Array<{ name: string; hex: string }> = [
  { name: 'default', hex: '' },
  { name: 'blue',    hex: '#5b8def' },
  { name: 'green',   hex: '#3ba55c' },
  { name: 'amber',   hex: '#d99b3e' },
  { name: 'red',     hex: '#d95757' },
  { name: 'purple',  hex: '#8a6fd6' },
];

const NODE_COLOR_LABEL_KEY: Record<string, DictKey> = {
  default: 'mindmap.color.default',
  blue: 'mindmap.color.blue',
  green: 'mindmap.color.green',
  amber: 'mindmap.color.amber',
  red: 'mindmap.color.red',
  purple: 'mindmap.color.purple',
};

const genNodeId = (): string =>
  `n_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36).slice(-4)}`;

const deriveChildLevel = (parentLevel: NodeLevel): NodeLevel => {
  if (parentLevel === 'root') return 'branch';
  if (parentLevel === 'branch') return 'detail';
  return 'note';
};

function MindmapDetail({
  mindmap,
  onBack,
}: {
  mindmap: MindmapModel;
  onBack: () => void;
}) {
  const repo = useRepository();
  const { pairId } = usePair();
  const qc = useQueryClient();
  const { t } = useT();

  // Local editable copy. Server writes flow through debounced autosave.
  const [content, setContent] = useState<MindmapContent>(mindmap.content);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Type-to-edit: null = no active edit. seed is the initial draft
  // (a typed character when triggered by keydown, empty string on
  // double-click / Enter). Pill uses `seed || node.title`.
  const [editingState, setEditingState] = useState<{
    id: string;
    seed: string;
  } | null>(null);
  // Link tool: when linkMode is on, node clicks build a free MindmapLink
  // instead of selecting. First click sets linkFromId; second click on a
  // different node creates the link and exits. Esc / blank cancels.
  const [linkMode, setLinkMode] = useState(false);
  const [linkFromId, setLinkFromId] = useState<string | null>(null);
  // Focus mode = true fullscreen (fixed inset:0 over the whole app shell,
  // see the render below) with editing fully intact — Inspector floats
  // over the canvas instead of disappearing. 2026-07-02 实机反馈: "现在进入
  // Focus 模式只是取消了旁边的 Indicator" / "我希望 Focus 时能直接进入全屏"
  // / "在这个模式下应该加上 Indicator，让我可以在专注模式下进行编辑，而不只
  // 是阅览". inspectorCollapsed is the lighter-weight direct-manipulation
  // path — collapse to a 40px rail with one click, works the same whether
  // floating or docked. Pending pool lives in a toolbar popover, never
  // right-column.
  const [focusMode, setFocusMode] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [pendingPopoverOpen, setPendingPopoverOpen] = useState(false);
  const pendingWrapperRef = useRef<HTMLDivElement>(null);

  // Close popover on click outside its trigger + panel.
  useEffect(() => {
    if (!pendingPopoverOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && !pendingWrapperRef.current?.contains(t)) {
        setPendingPopoverOpen(false);
      }
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [pendingPopoverOpen]);
  const dirtyRef = useRef(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Tree ⇄ Radial view mode. Persisted per-browser (not per-mindmap —
  // it's a viewing preference, not mindmap data). Radial-mode manual
  // drag overrides live only in local state (not on the node schema —
  // see computeRadialLaidOut's doc comment) so they reset per mindmap
  // and don't survive reload; that's the one real gap vs. tree mode's
  // is_pinned, called out in the integration report.
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(loadLayoutMode);
  const [radialPins, setRadialPins] = useState<Map<string, { x: number; y: number }>>(
    () => new Map()
  );
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, layoutMode);
    } catch {
      /* ignore */
    }
  }, [layoutMode]);

  // When switching to a different mindmap, resync from server.
  useEffect(() => {
    setContent(mindmap.content);
    setSelectedId(null);
    dirtyRef.current = false;
    setSaveState('idle');
    setRadialPins(new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mindmap.id]);

  // Reset/Restore reload mindmap from server → sync content across.
  useEffect(() => {
    if (dirtyRef.current) return;
    setContent(mindmap.content);
  }, [mindmap.content]);

  // Debounced autosave — 400ms after last edit.
  useEffect(() => {
    if (!dirtyRef.current) return;
    if (!repo) return;
    setSaveState('saving');
    const t = window.setTimeout(async () => {
      try {
        await repo.updateMindmapContent(mindmap.id, content);
        dirtyRef.current = false;
        setSaveState('saved');
        // Refresh top-level list counts / mini-view thumbnails.
        qc.invalidateQueries({ queryKey: ['all-mindmaps', pairId] });
        qc.invalidateQueries({ queryKey: ['mindmaps-lesson'] });
        window.setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 900);
      } catch {
        setSaveState('idle');
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [content, mindmap.id, pairId, qc, repo]);

  const editContent = (updater: (c: MindmapContent) => MindmapContent) => {
    dirtyRef.current = true;
    setContent(updater);
  };

  const updateNode = (id: string, patch: Partial<MindmapNode>) => {
    editContent((c) => ({
      ...c,
      nodes: c.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    }));
  };

  const addNode = (parentId: string | null) => {
    const parent = parentId ? content.nodes.find((n) => n.id === parentId) : null;
    const level: NodeLevel = parent ? deriveChildLevel(parent.level) : 'root';
    const siblingCount = parentId
      ? content.nodes.filter((n) => n.parent_id === parentId).length
      : content.nodes.filter((n) => !n.parent_id).length;
    const newId = genNodeId();
    editContent((c) => ({
      ...c,
      nodes: [
        // Auto-expand the parent so the new child is actually visible.
        ...c.nodes.map((n) =>
          parentId && n.id === parentId ? { ...n, is_expanded: true } : n
        ),
        {
          id: newId,
          parent_id: parent?.id,
          title: level === 'root' ? t('mindmap.newTopicTitle') : t('mindmap.newNodeTitle'),
          level,
          // pos_x/pos_y are unused by the auto layout but the schema
          // still requires them — set to 0 as placeholder.
          pos_x: 0,
          pos_y: 0,
          is_expanded: false,
          sort_order: siblingCount,
        },
      ],
    }));
    setSelectedId(newId);
  };

  // Free-floating note (Hub iOS "note node" pattern). Parent is null, so
  // the auto-layout doesn't try to place it in the tree; is_pinned=true
  // so pos_x/pos_y are honoured. Position defaults to canvas centre in
  // canvas coords — EditorCanvas provides it via callback.
  const addNoteAt = (pos: { x: number; y: number }) => {
    const newId = genNodeId();
    editContent((c) => ({
      ...c,
      nodes: [
        ...c.nodes,
        {
          id: newId,
          title: t('mindmap.newNote'),
          level: 'note',
          pos_x: pos.x,
          pos_y: pos.y,
          is_pinned: true,
          is_expanded: false,
          sort_order: c.nodes.length,
        },
      ],
    }));
    setSelectedId(newId);
    // Auto-open editing so user can start typing immediately.
    setEditingState({ id: newId, seed: '' });
  };

  // Pending pool data + drop handler.
  const pendingQuery = useQuery({
    queryKey: ['pending-cards', pairId],
    queryFn: () =>
      repo && pairId ? repo.getPendingCards(pairId) : Promise.resolve([]),
    enabled: !!repo && !!pairId,
  });
  const pendingCards = (pendingQuery.data ?? []).filter(
    (p) => !p.placed_in_mindmap_id
  );

  const handleDropPendingCard = (
    cardId: PendingCardId,
    pos: { x: number; y: number }
  ) => {
    const card = pendingCards.find((c) => c.id === cardId);
    if (!card || !repo || !pairId) return;
    // Preserve full card data on the note so we can display tag +
    // headline + content in the pill, and reconstruct the card when
    // the user restores the note back to the pool.
    const newId = genNodeId();
    editContent((c) => ({
      ...c,
      nodes: [
        ...c.nodes,
        {
          id: newId,
          title: card.title, // headline
          content: card.content, // body
          level: 'note',
          source_type:
            card.source_type === 'agent_seed'
              ? 'custom'
              : (card.source_type as MindmapNode['source_type']),
          source_id: card.source_id,
          source_title: card.source_title,
          pos_x: pos.x,
          pos_y: pos.y,
          is_pinned: true,
          is_expanded: false,
          sort_order: c.nodes.length,
        },
      ],
    }));
    setSelectedId(newId);
    // Remove from the pool so it doesn't show up as draggable again.
    void repo.dismissPendingCard(cardId).then(() => {
      qc.invalidateQueries({ queryKey: ['pending-cards', pairId] });
    });
  };

  // Restore a note node back to the pending pool: recreate a card from
  // the note's preserved data + delete the note. Only makes sense for
  // notes that originally came from a pending card (source_type set).
  const handleRestoreNoteToPool = (nodeId: string) => {
    const node = content.nodes.find((n) => n.id === nodeId);
    if (!node || node.level !== 'note' || !repo || !pairId) return;
    // Guard: only restore if the note carries source data (i.e. was
    // dropped from the pool). Manually-created "+ Note" notes don't
    // qualify — the button for those is hidden in Inspector.
    if (!node.source_type) return;
    const pendingSourceType =
      node.source_type === 'custom' ? 'manual' : node.source_type;
    void repo
      .addPendingCard(pairId, {
        title: node.title,
        content: node.content ?? '',
        source_type:
          pendingSourceType as PendingMindmapCard['source_type'],
        source_id: node.source_id,
        source_title: node.source_title,
        reason: 'restored from mindmap',
      })
      .then(() => {
        qc.invalidateQueries({ queryKey: ['pending-cards', pairId] });
      });
    // Delete the note from the mindmap.
    editContent((c) => ({
      ...c,
      nodes: c.nodes.filter((n) => n.id !== nodeId),
      links: c.links.filter(
        (l) => l.from_node_id !== nodeId && l.to_node_id !== nodeId
      ),
    }));
    setSelectedId(null);
  };

  const toggleExpand = (id: string) => {
    editContent((c) => ({
      ...c,
      nodes: c.nodes.map((n) =>
        n.id === id ? { ...n, is_expanded: !n.is_expanded } : n
      ),
    }));
  };

  const removeLink = (linkId: string) => {
    editContent((c) => ({
      ...c,
      links: c.links.filter((l) => l.id !== linkId),
    }));
  };

  const addLink = (fromId: string, toId: string) => {
    // Don't dup: skip if a link between these two already exists in
    // either direction.
    const already = content.links.some(
      (l) =>
        (l.from_node_id === fromId && l.to_node_id === toId) ||
        (l.from_node_id === toId && l.to_node_id === fromId)
    );
    if (already) return;
    const newId = `l_${Math.random().toString(36).slice(2, 8)}`;
    editContent((c) => ({
      ...c,
      links: [
        ...c.links,
        { id: newId, from_node_id: fromId, to_node_id: toId },
      ],
    }));
  };

  const handleNodeSelect = (id: string | null) => {
    if (!linkMode) {
      setSelectedId(id);
      return;
    }
    if (id === null) {
      // Blank canvas click cancels link mode.
      setLinkMode(false);
      setLinkFromId(null);
      return;
    }
    if (linkFromId === null) {
      setLinkFromId(id);
    } else if (linkFromId === id) {
      // Clicked the same source node — cancel.
      setLinkFromId(null);
    } else {
      addLink(linkFromId, id);
      setLinkFromId(null);
      setLinkMode(false);
    }
  };

  // Hub-style "自动排列": drop all manual pins so every node goes back
  // to the automatic layout position. Cheap because layoutTree ignores
  // pos_x/pos_y whenever is_pinned is false — radial mode's equivalent
  // is just clearing the local radialPins override map.
  const autoArrange = () => {
    if (layoutMode === 'radial') {
      setRadialPins(new Map());
      return;
    }
    editContent((c) => ({
      ...c,
      nodes: c.nodes.map((n) =>
        n.is_pinned ? { ...n, is_pinned: false } : n
      ),
    }));
  };

  // Drag session: subtree tracking. On drag start we snapshot the
  // current position of the target and every descendant; on each move
  // we apply the same delta to all of them (Hub iOS descendantsAndSelf
  // pattern). Preserves parent-child relative positions during the drag.
  const dragSessionRef = useRef<{
    targetId: string;
    startX: number;
    startY: number;
    snapshot: Map<string, { x: number; y: number }>;
  } | null>(null);

  const collectDescendantsAndSelf = (id: string): string[] => {
    const out: string[] = [];
    const visit = (nid: string) => {
      out.push(nid);
      for (const child of content.nodes) {
        if (child.parent_id === nid) visit(child.id);
      }
    };
    visit(id);
    return out;
  };

  const startDrag = (id: string) => {
    // Compute layout on the current content so we know where every node
    // is right now (whether pinned or auto), for whichever mode is active.
    const laidNow =
      layoutMode === 'radial'
        ? computeRadialLaidOut(content.nodes, radialPins)
        : layoutTree(content.nodes);
    const target = laidNow.find((l) => l.node.id === id);
    if (!target) return;
    const affected = collectDescendantsAndSelf(id);
    const snapshot = new Map<string, { x: number; y: number }>();
    for (const nid of affected) {
      const l = laidNow.find((ll) => ll.node.id === nid);
      if (l) snapshot.set(nid, { x: l.x, y: l.y });
    }
    dragSessionRef.current = {
      targetId: id,
      startX: target.x,
      startY: target.y,
      snapshot,
    };
  };

  const dragTo = (id: string, x: number, y: number) => {
    const s = dragSessionRef.current;
    if (!s || s.targetId !== id) return;
    const dx = x - s.startX;
    const dy = y - s.startY;
    if (layoutMode === 'radial') {
      // Radial pins: same "drag pins the whole dragged subtree" idea as
      // tree mode, tracked in local state instead of on the node (see
      // computeRadialLaidOut doc comment for why).
      setRadialPins((prev) => {
        const next = new Map(prev);
        for (const [nid, snap] of s.snapshot) {
          next.set(nid, { x: snap.x + dx, y: snap.y + dy });
        }
        return next;
      });
      return;
    }
    editContent((c) => ({
      ...c,
      nodes: c.nodes.map((n) => {
        const snap = s.snapshot.get(n.id);
        if (!snap) return n;
        return {
          ...n,
          pos_x: snap.x + dx,
          pos_y: snap.y + dy,
          is_pinned: true,
        };
      }),
    }));
  };

  const endDrag = () => {
    dragSessionRef.current = null;
  };

  const commitTitle = (id: string, title: string) => {
    editContent((c) => ({
      ...c,
      nodes: c.nodes.map((n) => (n.id === id ? { ...n, title } : n)),
    }));
  };

  const deleteNodeCascade = (id: string) => {
    const toDelete = new Set<string>();
    const visit = (nid: string) => {
      toDelete.add(nid);
      content.nodes.filter((n) => n.parent_id === nid).forEach((c) => visit(c.id));
    };
    visit(id);
    editContent((c) => ({
      ...c,
      nodes: c.nodes.filter((n) => !toDelete.has(n.id)),
      links: c.links.filter(
        (l) => !toDelete.has(l.from_node_id) && !toDelete.has(l.to_node_id)
      ),
    }));
    setSelectedId(null);
  };

  // Global key handling (skip when focus is in a form control).
  useEffect(() => {
    const isPrintable = (e: KeyboardEvent): boolean => {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      // Any single-character key: letters, numbers, symbols, space.
      // Chinese IME will fire keydown with the Latin key first; the
      // input element then handles composition internally once focused.
      return e.key.length === 1;
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) {
        return;
      }
      if (e.key === 'Escape') {
        setSelectedId(null);
        setEditingState(null);
        if (linkMode) {
          setLinkMode(false);
          setLinkFromId(null);
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        deleteNodeCascade(selectedId);
      } else if (e.key === 'Tab' && selectedId) {
        e.preventDefault();
        addNode(selectedId);
      } else if (e.key === 'Enter' && selectedId && !editingState) {
        // Enter opens the selected node for editing with existing title
        // (select all — user probably wants to replace or edit).
        e.preventDefault();
        setEditingState({ id: selectedId, seed: '' });
      } else if (selectedId && !editingState && isPrintable(e)) {
        // Typing on a selected node opens editing with the pressed char
        // as the seed — the character becomes the start of the new title.
        e.preventDefault();
        setEditingState({ id: selectedId, seed: e.key });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, content, editingState, linkMode]);

  const resetMut = useMutation({
    mutationFn: () => {
      if (!repo) throw new Error('no repo');
      return repo.resetMindmap(mindmap.id);
    },
    onSuccess: () => {
      dirtyRef.current = false;
      qc.invalidateQueries({ queryKey: ['all-mindmaps', pairId] });
    },
  });

  const restoreMut = useMutation({
    mutationFn: () => {
      if (!repo) throw new Error('no repo');
      return repo.restoreMindmapFromSeed(mindmap.id);
    },
    onSuccess: () => {
      dirtyRef.current = false;
      qc.invalidateQueries({ queryKey: ['all-mindmaps', pairId] });
    },
  });

  // Rename (导图改名案): title-only patch, separate from the debounced
  // content autosave above — fires immediately on commit, same
  // invalidate-and-refetch shape as reset/restore.
  const renameMut = useMutation({
    mutationFn: (title: string) => {
      if (!repo) throw new Error('no repo');
      return repo.updateMindmapTitle(mindmap.id, title);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['all-mindmaps', pairId] });
    },
  });

  const selectedNode = selectedId ? content.nodes.find((n) => n.id === selectedId) ?? null : null;

  return (
    // Focus mode escapes AppShell entirely — see shell/FocusOverlay.tsx
    // for why fixed inset:0 is enough to clear the route column's
    // maxWidth:880px + padding, the sidebar, and the top bar in one move.
    // 2026-07-02 实机反馈: "现在进入 Focus 模式只是取消了旁边的 Indicator" /
    // "我希望 Focus 时能直接进入全屏". Shared with Review's Focus mode.
    <div style={focusOverlayStyle(focusMode)}>
      {/* Back link */}
      <button
        type="button"
        onClick={onBack}
        className="text-[12px] hover:underline"
        style={{ color: 'var(--ls-structure)', marginBottom: '14px' }}
      >
        {t('mindmap.backToAllMindmaps')}
      </button>

      {/* Title + meta */}
      <div
        className="flex items-baseline justify-between flex-wrap"
        style={{ gap: '12px', marginBottom: '6px' }}
      >
        <MindmapTitle mindmap={mindmap} onRename={(title) => renameMut.mutate(title)} />
        <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]">
          {t('mindmap.scopePrefix')}{mindmap.scope}{t('mindmap.sourceMidPrefix')}{mindmap.source}
          {mindmap.agent_skill_used && `${t('mindmap.skillPrefix')}${mindmap.agent_skill_used}`}
        </span>
      </div>

      {/* Toolbar row */}
      <div
        className="flex flex-wrap items-center"
        style={{ marginTop: '14px', marginBottom: '16px', gap: '8px' }}
      >
        <button
          type="button"
          onClick={() => addNode(null)}
          className="inline-flex items-center border border-[var(--ls-border-strong)] text-[var(--ls-text)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
          style={{ height: '30px', padding: '0 12px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
          title={t('mindmap.addRootTopicTitle')}
        >
          {t('mindmap.addRootButton')}
        </button>
        <button
          type="button"
          onClick={() => {
            // Bottom of current layout — enough offset so it doesn't
            // overlap. Auto-fit will re-centre the view.
            const cur =
              layoutMode === 'radial'
                ? computeRadialLaidOut(content.nodes, radialPins)
                : layoutTree(content.nodes);
            const bottomY =
              cur.length > 0
                ? Math.max(...cur.map((l) => l.y)) + NODE_ROW_H * 2
                : 100;
            const centerX =
              cur.length > 0
                ? (Math.min(...cur.map((l) => l.x)) +
                    Math.max(...cur.map((l) => l.x))) /
                  2
                : 100;
            addNoteAt({ x: centerX, y: bottomY });
          }}
          className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
          style={{ height: '30px', padding: '0 12px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
          title={t('mindmap.addFreeNoteTitle')}
        >
          {t('mindmap.addNoteButton')}
        </button>
        <button
          type="button"
          onClick={() => {
            setLinkMode((m) => !m);
            setLinkFromId(null);
          }}
          className="inline-flex items-center border font-medium transition-colors duration-[var(--ls-duration-fast)]"
          style={{
            height: '30px',
            padding: '0 12px',
            borderRadius: '6px',
            fontSize: '12px',
            lineHeight: '1',
            background: linkMode ? 'var(--ls-hypothesis)' : 'transparent',
            color: linkMode ? '#fff' : 'var(--ls-text-secondary)',
            borderColor: linkMode ? 'var(--ls-hypothesis)' : 'var(--ls-border)',
          }}
          title={linkMode
            ? t('mindmap.linkModeActiveTitle')
            : t('mindmap.drawFreeLinkHint')}
        >
          {linkMode
            ? linkFromId
              ? t('mindmap.linkModePickTarget')
              : t('mindmap.linkModePickSource')
            : t('mindmap.linkLabel')}
        </button>
        <button
          type="button"
          onClick={autoArrange}
          className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
          style={{ height: '30px', padding: '0 12px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
          title={t('mindmap.rearrangeTitle')}
        >
          {t('mindmap.autoArrange')}
        </button>
        <button
          type="button"
          onClick={() => setLayoutMode((m) => (m === 'tree' ? 'radial' : 'tree'))}
          className="inline-flex items-center border font-medium transition-colors duration-[var(--ls-duration-fast)]"
          style={{
            height: '30px',
            padding: '0 12px',
            borderRadius: '6px',
            fontSize: '12px',
            lineHeight: '1',
            background: layoutMode === 'radial' ? 'var(--ls-text)' : 'transparent',
            color: layoutMode === 'radial' ? 'var(--ls-bg)' : 'var(--ls-text-secondary)',
            borderColor: layoutMode === 'radial' ? 'var(--ls-text)' : 'var(--ls-border)',
          }}
          title={
            layoutMode === 'radial'
              ? t('mindmap.switchToTree')
              : t('mindmap.switchToRadial')
          }
        >
          {t('mindmap.treeRadialToggle')}
        </button>
        {pendingCards.length > 0 && (
          <div ref={pendingWrapperRef} style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setPendingPopoverOpen((o) => !o)}
              className="inline-flex items-center border font-medium transition-colors duration-[var(--ls-duration-fast)]"
              style={{
                height: '30px',
                padding: '0 12px',
                borderRadius: '6px',
                fontSize: '12px',
                lineHeight: '1',
                gap: '6px',
                background: pendingPopoverOpen
                  ? 'var(--ls-panel)'
                  : 'transparent',
                color: 'var(--ls-text-secondary)',
                borderColor: 'var(--ls-border)',
              }}
              title={
                pendingPopoverOpen
                  ? t('mindmap.pendingPopoverClose')
                  : t('mindmap.showPendingCardsHint')
              }
            >
              <span style={{ fontSize: '13px' }}>⊞</span>
              {t('mindmap.pendingLabel')}{pendingCards.length}
            </button>
            {pendingPopoverOpen && (
              <PendingPoolPopover
                cards={pendingCards}
                pairId={pairId}
                qc={qc}
                repo={repo}
              />
            )}
          </div>
        )}
        <FocusToggleButton
          active={focusMode}
          onClick={() => setFocusMode((f) => !f)}
          activeTitle={t('mindmap.focus.exitTitle')}
          inactiveTitle={t('mindmap.focus.enterTitle')}
        />
        {mindmap.has_been_reset && (
          <button
            type="button"
            onClick={() => restoreMut.mutate()}
            disabled={restoreMut.isPending}
            className="inline-flex items-center border border-[var(--ls-border-strong)] text-[var(--ls-text)] font-medium hover:bg-[var(--ls-panel)] disabled:opacity-50 transition-colors duration-[var(--ls-duration-fast)]"
            style={{ height: '30px', padding: '0 12px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
          >
            {t('mindmap.restoreAgentVersion')}
          </button>
        )}
        {!mindmap.has_been_reset && mindmap.content.nodes.length > 0 && (
          <button
            type="button"
            onClick={() => resetMut.mutate()}
            disabled={resetMut.isPending}
            className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] font-medium hover:bg-[var(--ls-panel)] disabled:opacity-50 transition-colors duration-[var(--ls-duration-fast)]"
            style={{ height: '30px', padding: '0 12px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
          >
            {t('lesson.mindmapEmbed.clearAndRedo')}
          </button>
        )}

        <div style={{ flex: 1 }} />

        <SavePill state={saveState} />
      </div>

      {/* Editor: canvas + right column (pending pool + inspector). In
          Focus mode the Inspector doesn't disappear (2026-07-02 实机反馈:
          "在这个模式下应该加上 Indicator，让我可以在专注模式下进行编辑，而
          不只是阅览") — it becomes a floating panel over the canvas instead
          of a flex sibling, so the canvas can claim the full row while
          editing stays fully available. `position: relative` on the row
          is the floating panel's containing block. */}
      <div
        className="flex"
        style={
          focusMode
            ? { position: 'relative', alignItems: 'stretch', flex: '1 1 auto', minHeight: 0 }
            : { gap: '16px', alignItems: 'stretch', minHeight: CANVAS_HEIGHT_PX }
        }
      >
        <EditorCanvas
          content={content}
          layoutMode={layoutMode}
          radialPins={radialPins}
          focusMode={focusMode}
          selectedId={selectedId}
          linkSourceId={linkFromId}
          onSelect={handleNodeSelect}
          onToggleExpand={toggleExpand}
          onAddRoot={() => addNode(null)}
          onDragStart={startDrag}
          onDragMove={dragTo}
          onDragEnd={endDrag}
          onCommitTitle={commitTitle}
          editingId={editingState?.id ?? null}
          editSeed={editingState?.seed ?? ''}
          onStartEditing={(id) => setEditingState({ id, seed: '' })}
          onStopEditing={() => setEditingState(null)}
          onDropPendingCard={handleDropPendingCard}
        />
        <div
          style={
            focusMode
              ? {
                  position: 'absolute',
                  top: 16,
                  right: 16,
                  maxHeight: 'calc(100% - 32px)',
                  overflowY: 'auto',
                  borderRadius: '10px',
                  boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
                }
              : undefined
          }
        >
          <Inspector
            node={selectedNode}
            connectedLinks={
              selectedId
                ? content.links.filter(
                    (l) =>
                      l.from_node_id === selectedId ||
                      l.to_node_id === selectedId
                  )
                : []
            }
            allNodes={content.nodes}
            collapsed={inspectorCollapsed}
            onToggleCollapse={() => setInspectorCollapsed((c) => !c)}
            onUpdate={(patch) => selectedId && updateNode(selectedId, patch)}
            onDelete={() => selectedId && deleteNodeCascade(selectedId)}
            pinned={
              layoutMode === 'radial'
                ? !!selectedId && radialPins.has(selectedId)
                : !!selectedNode?.is_pinned
            }
            onUnpin={() => {
              if (!selectedId) return;
              if (layoutMode === 'radial') {
                setRadialPins((prev) => {
                  if (!prev.has(selectedId)) return prev;
                  const next = new Map(prev);
                  next.delete(selectedId);
                  return next;
                });
                return;
              }
              updateNode(selectedId, { is_pinned: false });
            }}
            onRestoreToPool={() => selectedId && handleRestoreNoteToPool(selectedId)}
            onRemoveLink={removeLink}
          />
        </div>
      </div>

      {/* Hotkey cheat sheet */}
      <p
        className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]"
        style={{ marginTop: '10px' }}
      >
        {t('mindmap.hotkeys.dragPanZoom')}<Kbd>Enter</Kbd>{t('mindmap.hotkeys.toRename')}<Kbd>Shift+↵</Kbd>{t('mindmap.hotkeys.newline')}
        <Kbd>Tab</Kbd>{t('mindmap.hotkeys.child')}
        <Kbd>+</Kbd>/<Kbd>−</Kbd>{t('mindmap.hotkeys.fold')}
        <Kbd>Delete</Kbd>{t('mindmap.hotkeys.remove')}
        <Kbd>Esc</Kbd>{t('mindmap.hotkeys.deselect')}
      </p>
    </div>
  );
}

/* --------- MindmapTitle --------- */
//
// Inline rename for the detail header (导图改名案: new custom maps were
// stuck at "Untitled mindmap" — no rename path existed at all). Click the
// title to edit; Enter commits, Esc cancels, blur saves — same inline
// semantics as TreeNodePill's title editing below, just single-line and
// single-click (no double-click/type-to-seed — this is a page heading,
// not a canvas node).

function MindmapTitle({
  mindmap,
  onRename,
}: {
  mindmap: MindmapModel;
  onRename: (title: string) => void;
}) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(mindmap.title);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reseed the draft whenever edit mode starts (or the underlying title
  // changes server-side while not editing) so a stale local value never
  // shadows a fresher title.
  useEffect(() => {
    if (editing) setDraft(mindmap.title);
  }, [editing, mindmap.title]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== mindmap.title) onRename(trimmed);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(mindmap.title);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // IME 组字守卫（IME 组字守卫 同族）：拼音选词的 Enter 不是确认改名
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        className="font-bold text-[22px] leading-[30px] tracking-[-0.02em] bg-transparent focus:outline-none"
        style={{
          margin: 0,
          padding: '0 0 1px',
          minWidth: '160px',
          maxWidth: '100%',
          borderBottom: '1px solid var(--ls-border-strong)',
          color: 'inherit',
        }}
      />
    );
  }

  return (
    <h1
      onClick={() => setEditing(true)}
      className="font-bold text-[22px] leading-[30px] tracking-[-0.02em] cursor-text hover:opacity-80 transition-opacity duration-[var(--ls-duration-fast)]"
      style={{ margin: 0 }}
      title={t('mindmap.clickToRenameTitle')}
    >
      {mindmap.title}
    </h1>
  );
}

/* --------- SavePill --------- */

function SavePill({ state }: { state: 'idle' | 'saving' | 'saved' }) {
  const { t } = useT();
  const label = state === 'saving' ? t('mindmap.savingLabel') : state === 'saved' ? t('mindmap.savedLabel') : t('mindmap.autoSaveOnLabel');
  const color =
    state === 'saving' ? 'var(--ls-hypothesis)' :
    state === 'saved'  ? 'var(--ls-corroborated)' :
    'var(--ls-text-tertiary)';
  return (
    <span
      className="inline-flex items-center text-[10px] leading-3 font-medium tracking-[0.06em] uppercase"
      style={{ color, gap: '5px' }}
    >
      <span
        style={{
          display: 'inline-block',
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: color,
          opacity: state === 'saving' ? 0.9 : state === 'saved' ? 1 : 0.6,
        }}
      />
      {label}
    </span>
  );
}

/* --------- Layout algorithm --------- */

interface LaidOutNode {
  node: MindmapNode;
  x: number;
  y: number;
  depth: number;
  hasChildren: boolean;
  // Fold state is a visibility overlay on top of a stable layout — the
  // node keeps its "fully expanded" position; only isVisible flips.
  // Consumers should render invisible nodes with opacity 0 (not skip
  // them) so a CSS opacity transition can fade the subtree in/out
  // without any other nodes shifting.
  isVisible: boolean;
}

/**
 * Compute a left-to-right tree layout. Root(s) on the left; each depth
 * offsets X_STEP to the right; parent centered vertically on its
 * children's midpoint.
 *
 * Fold state (`is_expanded`) does NOT affect the computed positions —
 * every node is laid out as though the tree were fully expanded. A
 * second pass marks nodes with any folded ancestor as `isVisible: false`
 * so consumers can hide them (opacity 0) without shifting the layout.
 * This is what keeps unrelated branches perfectly still when the user
 * collapses one — only the subtree fades; nothing else moves.
 */
function layoutTree(nodes: MindmapNode[]): LaidOutNode[] {
  // Defensive (自动分页兜底案/防御性解析守则 同族, bench 案一): a naive agent's write can
  // hand us a parent_id that references itself or an id not present in
  // this content at all (typo, dangling ref, or — as in the bench data —
  // a shape that never had parent_id in the first place). Grouping by the
  // RAW parent_id used to make such a node vanish silently: it landed
  // under a phantom key in `byParent` that `walk()` never visits (walk
  // only recurses from real roots down through real children), so the
  // node just disappeared from the map with no error anywhere. Resolving
  // unresolvable parent_id to "no parent" instead means the node still
  // renders — as a flat root — instead of vanishing.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const resolvedParentId = (n: MindmapNode): string | null =>
    n.parent_id && n.parent_id !== n.id && nodeIds.has(n.parent_id) ? n.parent_id : null;

  const byParent = new Map<string | null, MindmapNode[]>();
  for (const n of nodes) {
    const key = resolvedParentId(n);
    const arr = byParent.get(key) ?? [];
    arr.push(n);
    byParent.set(key, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  }

  const out: LaidOutNode[] = [];
  let cursorY = CANVAS_PAD_Y;

  const walk = (
    node: MindmapNode,
    depth: number
  ): { centerY: number } => {
    const children = byParent.get(node.id) ?? [];
    const hasChildren = children.length > 0;

    // Always recurse — position calculation ignores is_expanded so
    // folding a subtree leaves every other node exactly where it was.
    if (!hasChildren) {
      const centerY = cursorY + NODE_ROW_H / 2;
      out.push({
        node,
        x: CANVAS_PAD_X + depth * X_STEP,
        y: centerY,
        depth,
        hasChildren: false,
        isVisible: true,
      });
      cursorY += NODE_ROW_H;
      return { centerY };
    }

    const childCenters: number[] = [];
    for (const child of children) {
      const r = walk(child, depth + 1);
      childCenters.push(r.centerY);
    }
    const centerY =
      (childCenters[0]! + childCenters[childCenters.length - 1]!) / 2;
    out.push({
      node,
      x: CANVAS_PAD_X + depth * X_STEP,
      y: centerY,
      depth,
      hasChildren: true,
      isVisible: true,
    });
    return { centerY };
  };

  const roots = byParent.get(null) ?? [];
  for (const root of roots) {
    walk(root, 0);
    cursorY += NODE_ROW_H / 2;
  }

  // Second pass: any node whose chain of parents contains a folded
  // ancestor is hidden. Walk parent_id up until we hit root or find
  // is_expanded === false.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const laid of out) {
    let p: string | undefined = laid.node.parent_id;
    // Cycle guard (belt-and-suspenders on top of resolvedParentId above):
    // corrupted data walked here should terminate, never hang the render.
    const seenAncestors = new Set<string>([laid.node.id]);
    while (p) {
      if (seenAncestors.has(p)) break;
      seenAncestors.add(p);
      const parent = nodeById.get(p);
      if (!parent) break;
      if (!parent.is_expanded) {
        laid.isVisible = false;
        break;
      }
      p = parent.parent_id;
    }
  }

  // Pinned nodes float to their saved canvas coords, overriding the
  // auto layout. Their auto-layout row is still consumed above (leaves
  // vertical space free for its former slot).
  return out.map((l) =>
    l.node.is_pinned
      ? { ...l, x: l.node.pos_x, y: l.node.pos_y }
      : l
  );
}

/**
 * Radial counterpart of layoutTree — same LaidOutNode[] shape so the
 * rest of EditorCanvas (bbox/pan/zoom, drag machinery, TreeNodePill,
 * fold-as-visibility) doesn't need to know which mode is active.
 *
 * Positions come from the pure radialLayout() engine (always computed
 * fully expanded, translated by RADIAL_ORIGIN_*), EXCEPT nodes the user
 * has manually dragged in radial mode — `pins` overrides those, same
 * "manual override wins" idea as tree mode's is_pinned, but tracked in
 * local component state instead of on the node (see MindmapDetail: the
 * node schema's is_pinned/pos_x/pos_y are tree-mode's own absolute
 * canvas coords and reusing them here would corrupt Tree mode's layout
 * whenever the user switches back — see integration report).
 *
 * Free-floating notes (parent_id null, level !== 'root') are skipped by
 * the engine on purpose; they keep rendering at their own pos_x/pos_y,
 * exactly like tree mode.
 */
function computeRadialLaidOut(
  nodes: MindmapNode[],
  pins: Map<string, { x: number; y: number }>
): LaidOutNode[] {
  const engine = radialLayout(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childCount = new Map<string, number>();
  for (const n of nodes) {
    if (!n.parent_id) continue;
    childCount.set(n.parent_id, (childCount.get(n.parent_id) ?? 0) + 1);
  }
  const depthOf = (id: string): number => {
    let d = 0;
    let cur: MindmapNode | undefined = byId.get(id);
    const seen = new Set<string>();
    while (cur?.parent_id && byId.has(cur.parent_id) && !seen.has(cur.id)) {
      seen.add(cur.id);
      d++;
      cur = byId.get(cur.parent_id);
    }
    return d;
  };

  const out: LaidOutNode[] = nodes.map((node) => {
    const pin = pins.get(node.id);
    const enginePos = engine.get(node.id);
    const x = pin ? pin.x : enginePos ? enginePos.x + RADIAL_ORIGIN_X : node.pos_x;
    const y = pin ? pin.y : enginePos ? enginePos.y + RADIAL_ORIGIN_Y : node.pos_y;
    return {
      node,
      x,
      y,
      depth: depthOf(node.id),
      hasChildren: (childCount.get(node.id) ?? 0) > 0,
      isVisible: true,
    };
  });

  // Same fold-ancestor visibility overlay as layoutTree: position is
  // always fully expanded, folding only flips isVisible so nothing
  // else in the map shifts.
  const nodeById = byId;
  for (const laid of out) {
    let p: string | undefined = laid.node.parent_id;
    // Cycle guard — see layoutTree's identical comment: corrupted
    // parent_id chains (self-reference, mutual A↔B) must terminate here,
    // never hang the render.
    const seenAncestors = new Set<string>([laid.node.id]);
    while (p) {
      if (seenAncestors.has(p)) break;
      seenAncestors.add(p);
      const parent = nodeById.get(p);
      if (!parent) break;
      if (!parent.is_expanded) {
        laid.isVisible = false;
        break;
      }
      p = parent.parent_id;
    }
  }

  return out;
}

/** Walk parent_id up to the component's root LaidOutNode — used to find
 *  the visual "center" a radial-mode curved edge should sweep around
 *  (see radialEdgeControlPoint). Falls back to the starting node if the
 *  chain is somehow broken. */
function findRootLaid(byId: Map<string, LaidOutNode>, id: string): LaidOutNode {
  let cur = byId.get(id);
  if (!cur) {
    // Shouldn't happen (id always comes from a node already in byId),
    // but keep the return type non-nullable rather than propagating
    // undefined into SVG path math.
    return { node: { id } as MindmapNode, x: 0, y: 0, depth: 0, hasChildren: false, isVisible: true };
  }
  const seen = new Set<string>();
  while (cur.node.parent_id && !seen.has(cur.node.id)) {
    seen.add(cur.node.id);
    const parent = byId.get(cur.node.parent_id);
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

/* --------- EditorCanvas --------- */

function EditorCanvas({
  content,
  layoutMode,
  radialPins,
  focusMode,
  selectedId,
  linkSourceId,
  onSelect,
  onToggleExpand,
  onAddRoot,
  onDragStart,
  onDragMove,
  onDragEnd,
  onCommitTitle,
  editingId,
  editSeed,
  onStartEditing,
  onStopEditing,
  onDropPendingCard,
}: {
  content: MindmapContent;
  layoutMode: LayoutMode;
  radialPins: Map<string, { x: number; y: number }>;
  // 2026-07-02 实机反馈 (导图居中案): "进入到focus页面把导图能尽量居中放置" — the
  // canvas container's size changes when focusMode toggles (fixed-height
  // column → full-viewport row), but scale/tx/ty don't move on their own.
  // We only need the boolean to know a refit is due; the actual
  // recentring reuses fitToView below.
  focusMode: boolean;
  selectedId: string | null;
  linkSourceId: string | null;
  onSelect: (id: string | null) => void;
  onToggleExpand: (id: string) => void;
  onAddRoot: () => void;
  onDragStart: (id: string) => void;
  onDragMove: (id: string, x: number, y: number) => void;
  onDragEnd: (id: string) => void;
  onCommitTitle: (id: string, title: string) => void;
  editingId: string | null;
  editSeed: string;
  onStartEditing: (id: string) => void;
  onStopEditing: () => void;
  onDropPendingCard: (
    cardId: PendingCardId,
    pos: { x: number; y: number }
  ) => void;
}) {
  const { t } = useT();
  const laid =
    layoutMode === 'radial'
      ? computeRadialLaidOut(content.nodes, radialPins)
      : layoutTree(content.nodes);
  // Bbox is computed from VISIBLE nodes only. Hidden (folded) nodes
  // keep their positions in `laid` but shouldn't influence the canvas
  // extent or auto-fit — otherwise fitting to a folded tree would zoom
  // out as if everything were still visible.
  const visibleLaid = laid.filter((l) => l.isVisible);
  const bboxMinX =
    visibleLaid.length > 0
      ? Math.min(...visibleLaid.map((l) => l.x)) - PILL_HALF_WIDTH
      : 0;
  const bboxMinY =
    visibleLaid.length > 0
      ? Math.min(...visibleLaid.map((l) => l.y)) - NODE_ROW_H
      : 0;
  const bboxMaxX =
    visibleLaid.length > 0
      ? Math.max(...visibleLaid.map((l) => l.x)) + PILL_HALF_WIDTH + CANVAS_PAD_X
      : 800;
  const bboxMaxY =
    visibleLaid.length > 0
      ? Math.max(...visibleLaid.map((l) => l.y)) + CANVAS_PAD_Y + NODE_ROW_H / 2
      : 400;
  const contentWidth = bboxMaxX - bboxMinX;
  const contentHeight = bboxMaxY - bboxMinY;

  const byId = new Map<string, LaidOutNode>();
  for (const l of laid) byId.set(l.node.id, l);

  // ---- Pan + zoom viewport ----
  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setViewState] = useState<{ scale: number; tx: number; ty: number }>({
    scale: 1,
    tx: 0,
    ty: 0,
  });
  // Ref-synced view for handlers that need the latest value synchronously
  // (drag/pan/rAF loop). Every setView also updates viewRef so reads from
  // event handlers between renders see the up-to-date state.
  const viewRef = useRef(view);
  const setView = (
    updater: typeof view | ((prev: typeof view) => typeof view)
  ) => {
    const next = typeof updater === 'function' ? updater(viewRef.current) : updater;
    viewRef.current = next;
    setViewState(next);
  };
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; tx: number; ty: number }>({
    x: 0, y: 0, tx: 0, ty: 0,
  });
  // Auto-fit signature: refit when node count changes materially. Track
  // last-fitted node count so add/delete triggers a refit, but a title
  // edit does not shift the view around.
  const lastFittedRef = useRef<number>(-1);
  // Anti-flash (防闪修复): mount paints nodes at the default view for the
  // 1-2 frames before the double-rAF fit lands — the origin-nearest node
  // "blinks" then the whole map jumps into place. Hide the transform layer
  // until the first fit pass has run (set in the rAF, fit or not, so an
  // empty/early-return fit can never leave the canvas hidden forever).
  const [firstFitDone, setFirstFitDone] = useState(false);

  const fitToView = () => {
    const canvas = canvasRef.current;
    if (!canvas || visibleLaid.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const minX = Math.min(...visibleLaid.map((l) => l.x)) - PILL_HALF_WIDTH;
    const maxX = Math.max(...visibleLaid.map((l) => l.x)) + PILL_HALF_WIDTH;
    const minY = Math.min(...visibleLaid.map((l) => l.y)) - NODE_ROW_H / 2;
    const maxY = Math.max(...visibleLaid.map((l) => l.y)) + NODE_ROW_H / 2;
    const bboxW = Math.max(1, maxX - minX);
    const bboxH = Math.max(1, maxY - minY);
    const paddingPx = 32;
    const scaleX = (rect.width - paddingPx * 2) / bboxW;
    const scaleY = (rect.height - paddingPx * 2) / bboxH;
    const scale = Math.max(MIN_SCALE, Math.min(1, Math.min(scaleX, scaleY)));
    const tx = (rect.width - bboxW * scale) / 2 - minX * scale;
    const ty = (rect.height - bboxH * scale) / 2 - minY * scale;
    setView({ scale, tx, ty });
  };

  // Auto-fit only when the TOTAL node count changes (add/delete). Skip
  // fold/unfold — those just hide/show existing subtrees; refitting on
  // every collapse feels jumpy (2026-07-02 实机反馈). Also skip title
  // edits and drag repositioning (both leave nodes.length alone).
  // Double rAF so a fresh mount waits until canvas has final layout
  // dimensions before computing the fit rect.
  //
  // 2026-07-02 实机报障: first-entry zoom was stuck at 100% instead of
  // fitting. Root cause was StrictMode's dev-only double-invoke: the
  // ref bookkeeping (`lastFittedRef.current = total`) ran eagerly in
  // the effect body, so the throwaway first mount marked the fit as
  // "done" and cancelled its own rAF before it ever painted — the
  // real (kept) second mount then saw the ref already matched `total`
  // and skipped scheduling entirely. Fix: only stamp the ref once
  // fitToView actually runs, inside the rAF callback itself, so a
  // cancelled/cleaned-up pass never poisons the guard for the mount
  // that follows it.
  useEffect(() => {
    const total = content.nodes.length;
    if (total === 0) return;
    if (lastFittedRef.current === total) return;
    let raf2: number | null = null;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        lastFittedRef.current = total;
        fitToView();
        setFirstFitDone(true);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content.nodes.length]);

  // Re-fit whenever Focus mode toggles (导图居中案). Entering/exiting Focus
  // resizes this canvas's container (fixed-height column ⇄ full-viewport
  // row) but leaves scale/tx/ty untouched, so the map is left wherever it
  // happened to sit before — usually crammed in a corner of the new,
  // larger space. Skip the very first render (mount already gets a fit
  // from the node-count effect above) — this effect only reacts to actual
  // toggles. Same double-rAF as above: wait for the browser to finish
  // laying out the resized container before measuring its rect.
  const isFirstFocusRenderRef = useRef(true);
  useEffect(() => {
    if (isFirstFocusRenderRef.current) {
      isFirstFocusRenderRef.current = false;
      return;
    }
    let raf2: number | null = null;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        fitToView();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMode]);

  // ---- Node drag lifecycle (lifted from TreeNodePill) ----
  //
  // Pill fires raw client coords; EditorCanvas owns the math so it can
  // (a) do view-aware coord conversion (so zoom/pan during drag stays
  // consistent) and (b) run an auto-scroll rAF loop that shifts view AND
  // recomputes node position even when the pointer is stationary at the
  // canvas edge. Drag state also lives here so a single ref is enough —
  // only one pill can be dragged at a time.
  const draggingRef = useRef<{
    id: string;
    initialClientX: number;
    initialClientY: number;
    initialNodeX: number;
    initialNodeY: number;
    initialViewTx: number;
    initialViewTy: number;
    initialScale: number;
    lastClientX: number;
    lastClientY: number;
    moved: boolean;
  } | null>(null);
  const scrollDirRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const scrollRafRef = useRef<number | null>(null);
  // Rendered draggingId (state, not ref) — used to suppress CSS
  // position-transition on the pill being actively dragged. Non-dragged
  // pills keep their smooth layout transitions.
  const [draggingIdState, setDraggingIdState] = useState<string | null>(null);

  const computeNewNodePos = (): { x: number; y: number } | null => {
    const d = draggingRef.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!d || !rect) return null;
    const v = viewRef.current;
    // Pointer's canvas position right now (uses current view) and at
    // drag start (uses view snapshot). Node follows the pointer.
    const pNowX = (d.lastClientX - rect.left - v.tx) / v.scale;
    const pNowY = (d.lastClientY - rect.top - v.ty) / v.scale;
    const p0X = (d.initialClientX - rect.left - d.initialViewTx) / d.initialScale;
    const p0Y = (d.initialClientY - rect.top - d.initialViewTy) / d.initialScale;
    return {
      x: d.initialNodeX + (pNowX - p0X),
      y: d.initialNodeY + (pNowY - p0Y),
    };
  };

  const startAutoScrollLoop = () => {
    if (scrollRafRef.current !== null) return;
    const tick = () => {
      const d = draggingRef.current;
      const dir = scrollDirRef.current;
      if (!d || !d.moved || (!dir.dx && !dir.dy)) {
        scrollRafRef.current = null;
        return;
      }
      setView((v) => ({
        scale: v.scale,
        tx: v.tx - dir.dx,
        ty: v.ty - dir.dy,
      }));
      const pos = computeNewNodePos();
      if (pos) onDragMove(d.id, pos.x, pos.y);
      scrollRafRef.current = requestAnimationFrame(tick);
    };
    scrollRafRef.current = requestAnimationFrame(tick);
  };

  const updateScrollDirection = (cx: number, cy: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const localX = cx - rect.left;
    const localY = cy - rect.top;
    const EDGE = 44;
    const SPEED = 9;
    let dx = 0, dy = 0;
    if (localX < EDGE) dx = -SPEED * ((EDGE - localX) / EDGE);
    else if (rect.width - localX < EDGE)
      dx = SPEED * ((EDGE - (rect.width - localX)) / EDGE);
    if (localY < EDGE) dy = -SPEED * ((EDGE - localY) / EDGE);
    else if (rect.height - localY < EDGE)
      dy = SPEED * ((EDGE - (rect.height - localY)) / EDGE);
    scrollDirRef.current = { dx, dy };
    if (dx || dy) startAutoScrollLoop();
  };

  const handleNodePointerDown = (id: string, cx: number, cy: number) => {
    const laidNode = laid.find((l) => l.node.id === id);
    if (!laidNode) return;
    const v = viewRef.current;
    draggingRef.current = {
      id,
      initialClientX: cx,
      initialClientY: cy,
      initialNodeX: laidNode.x,
      initialNodeY: laidNode.y,
      initialViewTx: v.tx,
      initialViewTy: v.ty,
      initialScale: v.scale,
      lastClientX: cx,
      lastClientY: cy,
      moved: false,
    };
  };

  const handleNodePointerMove = (cx: number, cy: number) => {
    const d = draggingRef.current;
    if (!d) return;
    d.lastClientX = cx;
    d.lastClientY = cy;
    if (!d.moved) {
      const dxs = cx - d.initialClientX;
      const dys = cy - d.initialClientY;
      if (
        Math.abs(dxs) < DRAG_THRESHOLD_PX &&
        Math.abs(dys) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      d.moved = true;
      setDraggingIdState(d.id);
      onDragStart(d.id);
    }
    const pos = computeNewNodePos();
    if (pos) onDragMove(d.id, pos.x, pos.y);
    updateScrollDirection(cx, cy);
  };

  const handleNodePointerUp = () => {
    const d = draggingRef.current;
    if (!d) return;
    const wasMoved = d.moved;
    const id = d.id;
    draggingRef.current = null;
    scrollDirRef.current = { dx: 0, dy: 0 };
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    if (wasMoved) onDragEnd(id);
    setDraggingIdState(null);
  };

  // Clean up rAF if component unmounts mid-drag.
  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  // Nudge zoom around a screen point (centered when pointer absent).
  const zoomAround = (factor: number, screenX?: number, screenY?: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = screenX ?? rect.width / 2;
    const cy = screenY ?? rect.height / 2;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
    const ratio = newScale / view.scale;
    const newTx = cx - (cx - view.tx) * ratio;
    const newTy = cy - (cy - view.ty) * ratio;
    setView({ scale: newScale, tx: newTx, ty: newTy });
  };

  // Non-passive wheel listener — React's onWheel is passive so
  // preventDefault() there is a no-op. We attach imperatively.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Ignore trackpad horizontal-only scrolls; those pan the outer page
      // if we don't handle. Since this is inside overflow-hidden, they'd
      // do nothing anyway. Only zoom on vertical deltas.
      if (Math.abs(e.deltaY) < 0.5) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 0.92 : 1.08;
      zoomAround(factor, localX, localY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Pan on empty canvas background. Pills opt out via data-node attr.
  const isBackground = (target: EventTarget | null): boolean => {
    if (!target) return false;
    return !(target as HTMLElement).closest('[data-node]');
  };

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (!isBackground(e.target)) return;
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      tx: view.tx,
      ty: view.ty,
    };
    setIsPanning(true);
    onSelect(null);
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onCanvasPointerMove = (e: React.PointerEvent) => {
    if (!isPanning) return;
    const dx = e.clientX - panStartRef.current.x;
    const dy = e.clientY - panStartRef.current.y;
    setView({
      scale: view.scale,
      tx: panStartRef.current.tx + dx,
      ty: panStartRef.current.ty + dy,
    });
  };

  const onCanvasPointerUp = (e: React.PointerEvent) => {
    if (!isPanning) return;
    setIsPanning(false);
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      ref={canvasRef}
      className="relative flex-1 border border-[var(--ls-border)] bg-[var(--ls-bg-subtle)] overflow-hidden select-none"
      style={{
        minHeight: CANVAS_HEIGHT_PX,
        borderRadius: '10px',
        touchAction: 'none',
        cursor: content.nodes.length === 0
          ? 'default'
          : isPanning ? 'grabbing' : 'grab',
      }}
      onPointerDown={onCanvasPointerDown}
      onPointerMove={onCanvasPointerMove}
      onPointerUp={onCanvasPointerUp}
      onPointerCancel={onCanvasPointerUp}
      // HTML5 drop target for pending cards. Drag events are separate
      // from pointer events, so this doesn't conflict with pan/drag.
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-ls-pending')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData('application/x-ls-pending');
        if (!raw) return;
        e.preventDefault();
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const v = viewRef.current;
        const canvasX = (e.clientX - rect.left - v.tx) / v.scale;
        const canvasY = (e.clientY - rect.top - v.ty) / v.scale;
        onDropPendingCard(raw as PendingCardId, {
          x: canvasX,
          y: canvasY,
        });
      }}
    >
      {content.nodes.length === 0 ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center pointer-events-none"
          style={{ padding: '40px' }}
        >
          <p className="text-[13px] leading-5 text-[var(--ls-text-tertiary)]">
            {t('mindmap.emptyCanvas')}
          </p>
          <button
            type="button"
            // Root cause (按钮命中修复): this button sits inside canvasRef but
            // isn't marked [data-node], so a bare pointerdown bubbles up to
            // onCanvasPointerDown, which treats it as background — claims
            // pointer capture on the canvas div and deselects. Same failure
            // mode ZoomControls' stopBubble already guards against ("Bubbled
            // pointerdown from these buttons would hit the canvas's pan
            // handler, which claims pointer capture and cancels the button
            // click") — this was the one spot that precedent didn't reach.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onAddRoot}
            className="pointer-events-auto inline-flex items-center border border-[var(--ls-border-strong)] text-[var(--ls-text)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
            style={{ height: '32px', padding: '0 14px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
          >
            {t('mindmap.addRootTopicButton')}
          </button>
        </div>
      ) : (
        <>
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: contentWidth,
              height: contentHeight,
              transformOrigin: '0 0',
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
              visibility: firstFitDone || content.nodes.length === 0 ? 'visible' : 'hidden',
            }}
          >
            <svg
              className="absolute pointer-events-none"
              style={{ left: bboxMinX, top: bboxMinY, overflow: 'visible' }}
              width={contentWidth}
              height={contentHeight}
              viewBox={`${bboxMinX} ${bboxMinY} ${contentWidth} ${contentHeight}`}
            >
              {/* Parent-child lines. Tree mode: bracket-style L (parent →
                  bracket_x at midpoint → drop to child y → across to
                  child), rounded joins for the classic mind-map bracket
                  look. Radial mode: root→first-ring is a straight line;
                  deeper edges are a smooth quadratic curve sweeping
                  around the map's center (radialEdgeControlPoint),
                  matching how a hand-drawn radial map's branches curve
                  rather than cut straight through the middle. */}
              {laid.map((l) => {
                const parentId = l.node.parent_id;
                if (!parentId) return null;
                const p = byId.get(parentId);
                if (!p) return null;
                const bothVisible = l.isVisible && p.isVisible;

                if (layoutMode === 'radial') {
                  // Parent itself is a root (no parent_id) → this is a
                  // root→first-ring edge: straight line, no curve.
                  const isFirstRing = !p.node.parent_id;
                  const d = isFirstRing
                    ? `M ${p.x} ${p.y} L ${l.x} ${l.y}`
                    : (() => {
                        const origin = findRootLaid(byId, p.node.id);
                        const cp = radialEdgeControlPoint(
                          { x: origin.x, y: origin.y },
                          { x: p.x, y: p.y },
                          { x: l.x, y: l.y }
                        );
                        return `M ${p.x} ${p.y} Q ${cp.x} ${cp.y} ${l.x} ${l.y}`;
                      })();
                  return (
                    <path
                      key={`pc-${l.node.id}`}
                      d={d}
                      stroke="var(--ls-text-tertiary)"
                      strokeWidth={1.3}
                      strokeLinecap="round"
                      fill="none"
                      opacity={bothVisible ? 1 : 0}
                    />
                  );
                }

                const bx = (p.x + l.x) / 2;
                return (
                  <path
                    key={`pc-${l.node.id}`}
                    d={`M ${p.x} ${p.y} L ${bx} ${p.y} L ${bx} ${l.y} L ${l.x} ${l.y}`}
                    stroke="var(--ls-text-tertiary)"
                    strokeWidth={1.3}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    fill="none"
                    opacity={bothVisible ? 1 : 0}
                  />
                );
              })}
              {content.links.map((link) => {
                const from = byId.get(link.from_node_id);
                const to = byId.get(link.to_node_id);
                if (!from || !to) return null;
                // Free-link dashes hide when either endpoint is folded
                // away — otherwise the dashed line hangs in space with
                // nothing to connect (2026-07-02 实机反馈: "被孤立了").
                const bothVisible = from.isVisible && to.isVisible;
                return (
                  <line
                    key={`l-${link.id}`}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke="var(--ls-text-tertiary)"
                    strokeWidth={1}
                    strokeDasharray="4 3"
                    opacity={bothVisible ? 0.6 : 0}
                  />
                );
              })}
            </svg>

            {laid.map((l) => (
              <TreeNodePill
                key={l.node.id}
                laid={l}
                selected={selectedId === l.node.id}
                // Whenever ANY node is being dragged, suppress the layout
                // transition on ALL pills. The transition applies to CSS
                // left/top on the pill DOM node, but SVG bracket lines
                // update instantly per render — so during a drag the pill
                // glides while the line snaps, and they visually detach.
                // Killing transition tree-wide during drag keeps pill and
                // line in lockstep. Non-drag re-flows (add/delete/fold)
                // still get the smooth transition.
                suppressTransition={draggingIdState !== null}
                isLinkSource={linkSourceId === l.node.id}
                editing={editingId === l.node.id}
                editSeed={editingId === l.node.id ? editSeed : ''}
                onSelect={() => onSelect(l.node.id)}
                onStartEditing={() => onStartEditing(l.node.id)}
                onStopEditing={onStopEditing}
                onToggleExpand={() => onToggleExpand(l.node.id)}
                onNodePointerDown={(cx, cy) =>
                  handleNodePointerDown(l.node.id, cx, cy)
                }
                onNodePointerMove={handleNodePointerMove}
                onNodePointerUp={handleNodePointerUp}
                onCommitTitle={(t) => onCommitTitle(l.node.id, t)}
              />
            ))}
          </div>

          {/* Floating zoom controls — bottom-right, non-scrolling with content */}
          <ZoomControls
            scale={view.scale}
            onZoomIn={() => zoomAround(1.2)}
            onZoomOut={() => zoomAround(1 / 1.2)}
            onFit={fitToView}
          />
        </>
      )}
    </div>
  );
}

/* --------- ZoomControls --------- */

function ZoomControls({
  scale,
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  const { t } = useT();
  const btn: React.CSSProperties = {
    width: '28px',
    height: '28px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '13px',
    lineHeight: '1',
    borderRadius: '6px',
    background: 'var(--ls-bg)',
    color: 'var(--ls-text-secondary)',
    border: '1px solid var(--ls-border)',
  };
  // Bubbled pointerdown from these buttons would hit the canvas's pan
  // handler, which claims pointer capture and cancels the button click.
  // Stop the bubble at the container.
  const stopBubble = (e: React.PointerEvent | React.MouseEvent) => {
    e.stopPropagation();
  };
  return (
    <div
      className="absolute flex items-center"
      onPointerDown={stopBubble}
      onPointerUp={stopBubble}
      onClick={stopBubble}
      onDoubleClick={stopBubble}
      style={{
        bottom: '12px',
        right: '12px',
        gap: '6px',
        padding: '4px',
        borderRadius: '8px',
        background: 'color-mix(in srgb, var(--ls-bg) 92%, transparent)',
        backdropFilter: 'blur(6px)',
        border: '1px solid var(--ls-border)',
      }}
    >
      <button type="button" onClick={onZoomOut} style={btn} title={t('mindmap.zoomOutTitle')}>
        −
      </button>
      <span
        className="tabular-nums text-[var(--ls-text-tertiary)]"
        style={{ minWidth: '38px', textAlign: 'center', fontSize: '11px' }}
      >
        {Math.round(scale * 100)}%
      </span>
      <button type="button" onClick={onZoomIn} style={btn} title={t('mindmap.zoomInTitle')}>
        +
      </button>
      <button
        type="button"
        onClick={onFit}
        style={{ ...btn, width: 'auto', padding: '0 10px', fontSize: '11px' }}
        title={t('mindmap.fitToViewTitle')}
      >
        {t('mindmap.fitLabel')}
      </button>
    </div>
  );
}

/* --------- TreeNodePill --------- */

function TreeNodePill({
  laid,
  selected,
  isLinkSource,
  suppressTransition,
  editing,
  editSeed,
  onSelect,
  onStartEditing,
  onStopEditing,
  onToggleExpand,
  onNodePointerDown,
  onNodePointerMove,
  onNodePointerUp,
  onCommitTitle,
}: {
  laid: LaidOutNode;
  selected: boolean;
  isLinkSource: boolean;
  suppressTransition: boolean;
  editing: boolean;
  editSeed: string;
  onSelect: () => void;
  onStartEditing: () => void;
  onStopEditing: () => void;
  onToggleExpand: () => void;
  onNodePointerDown: (clientX: number, clientY: number) => void;
  onNodePointerMove: (clientX: number, clientY: number) => void;
  onNodePointerUp: () => void;
  onCommitTitle: (title: string) => void;
}) {
  const { t } = useT();
  const { node, x, y, hasChildren } = laid;
  const isRoot = node.level === 'root';
  const isBranch = node.level === 'branch';
  // Sticky-note styling is reserved for FREE-FLOATING notes (parent_id
  // is null) — those are the "+ Note" or dropped-from-pool cards the design
  // wants to visually differentiate. Tree-embedded note children (which
  // some fixtures use as leaf points under a detail) stay in regular
  // tree-pill style so they read as part of the hierarchy.
  const isFreeNote = node.level === 'note' && !node.parent_id;
  const expanded = !!node.is_expanded;
  const hasFill = !!node.color;
  // Free notes always render as the app's token sticky-note look, full
  // stop — 2026-07-02 实机反馈: "我要那个 Amber 色（UI 里已经用的那种）,
  // 但目前好像没换成功" (superseded 2026-07-05, 自由笔记转蓝案: amber → blue,
  // see noteAccent above). Root cause at the time: the Inspector's Fill
  // swatch stores a standalone hex (NODE_COLORS' 'amber' === #d99b3e) on
  // node.color, which was a *different* amber from the design system's
  // token. Any free note that had ever been given an explicit fill (old
  // swatch click, imported data, whatever) rendered with that mismatched
  // raw hex instead of the token-tinted card look every other note uses.
  // Render layer normalizes: free notes ignore node.color entirely and
  // always use the token tint below — underlying data is untouched, so
  // nothing here is destructive. `noteFill` mirrors `hasFill` for
  // non-free nodes (tree pills keep full swatch behaviour) but is
  // always false for free notes, which also normalizes the derived
  // text/opacity treatments a few lines down.
  const noteFill = isFreeNote ? false : hasFill;
  // 自由笔记转蓝案 (2026-07-05): free notes switched amber → blue. No dedicated
  // "note blue" token exists in packages/ui/tokens/*.css (only
  // --ls-hyp-tint / --ls-grn-tint have companions; structure/risk don't),
  // so this reuses --ls-structure — the app's one existing blue, already
  // the note pill's own `selected` border colour below. Same token at
  // three mix stops (22% tint / 55% border / 100% selected) is the
  // single source of truth the color-token post-mortem asked for — no new token,
  // no raw hex, nothing left for a light/dark pair to drift out of sync.
  const noteAccent = 'var(--ls-structure)';

  // Draft is local state (the input's value); editing lifecycle is
  // controlled by the parent via `editing` + `editSeed` props.
  const [draft, setDraft] = useState(node.title);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea height to match content. Runs on every draft
  // change so the box wraps and expands in real time (实机反馈: "输入过程
  // 中文字总是只显示一行"). Reset to 'auto' first, then set to
  // scrollHeight — the canonical trick.
  useEffect(() => {
    if (editing && inputRef.current) {
      const el = inputRef.current;
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  }, [draft, editing]);

  // Init draft when we enter edit mode. `seed` starts the title if it's
  // a typed character (type-to-edit); empty seed = double-click/Enter
  // and we pre-fill with the existing title (select-all for easy overwrite).
  useEffect(() => {
    if (editing) {
      const initial = editSeed || node.title;
      setDraft(initial);
    } else {
      setDraft(node.title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Focus + cursor placement when edit mode starts.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      const el = inputRef.current;
      if (editSeed) {
        // Typed seed → cursor at end so next keystrokes append.
        const len = el.value.length;
        try { el.setSelectionRange(len, len); } catch { /* ignore */ }
      } else {
        // Double-click / Enter → select all so typing overwrites.
        try { el.select(); } catch { /* ignore */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== node.title) onCommitTitle(trimmed);
    onStopEditing();
  };

  const cancel = () => {
    setDraft(node.title);
    onStopEditing();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (editing) return; // let input handle its own events
    e.stopPropagation();
    onSelect();
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    onNodePointerDown(e.clientX, e.clientY);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    onNodePointerMove(e.clientX, e.clientY);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    onNodePointerUp();
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  // Font sizes bumped +2px across the board (实机反馈: "字太小了").
  const fontSize = isRoot ? '16px' : isBranch ? '15px' : '14px';
  const padding = isRoot ? '9px 16px' : isFreeNote ? '11px 14px' : '6px 12px';
  // Free notes render as sticky-notes: wider card, tag+headline+content
  // structure inside, no line-clamp (full content visible), no chevron.
  const pillWidth = isFreeNote ? NOTE_WIDTH : PILL_WIDTH;
  const pillRadius = isFreeNote ? '10px' : '9999px';

  return (
    <div
      data-node="1"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartEditing();
      }}
      className="absolute inline-flex items-center border"
      style={{
        left: x,
        top: y,
        transform: 'translate(-50%, -50%)',
        padding,
        borderRadius: pillRadius,
        // Free notes tint uses noteAccent (--ls-structure blue, 自由笔记转蓝案),
        // saturated 22% mix — the 2026-07-02 "previous 14% was too
        // muted on dark bg" call still holds at the new hue. Border kicked
        // up to 55% so it reads clearly at the pill edge as well. Uses
        // `noteFill` (not `hasFill`) so free notes never fall through to
        // a raw stored hex — see the noteFill comment above.
        background: noteFill
          ? node.color
          : isFreeNote
            ? `color-mix(in srgb, ${noteAccent} 22%, var(--ls-bg))`
            : 'var(--ls-bg)',
        borderColor: noteFill
          ? node.color
          : selected
            ? 'var(--ls-structure)'
            : isFreeNote
              ? `color-mix(in srgb, ${noteAccent} 55%, var(--ls-border))`
              : isRoot
                ? 'var(--ls-text)'
                : isBranch
                  ? 'var(--ls-border-strong)'
                  : 'var(--ls-border)',
        borderWidth: selected ? '2px' : '1px',
        fontSize,
        lineHeight: '1.4',
        fontWeight: isRoot ? 600 : isBranch ? 500 : 400,
        color: noteFill ? '#fff' : 'var(--ls-text)',
        width: `${pillWidth}px`,
        gap: '10px',
        // Free notes and multi-line editing both need top-alignment;
        // pill grows vertically while textarea auto-resizes.
        alignItems: isFreeNote || editing ? 'flex-start' : 'center',
        cursor: editing ? 'text' : 'grab',
        // 2026-07-02 实机反馈: "把底下的 Shadow 去掉，我不喜欢下面有那种 Glow
        // 的感觉" — free notes no longer carry a resting-state drop
        // shadow/glow. selected ring stays: active-state feedback, not the
        // ambient glow flagged there.
        // 2026-07-07 (自由笔记转蓝案 收尾): link-source 不再借任何色相——画布五色
        // 全是分类色，琥珀/绿都会撞衫。功能改用形状信号：中性虚线外环。
        // 分类用颜色、功能用形状，两套语言正交。
        boxShadow: selected && !isLinkSource
          ? '0 0 0 3px color-mix(in srgb, var(--ls-structure) 22%, transparent)'
          : 'none',
        outline: isLinkSource ? '3px dashed var(--ls-border-strong)' : undefined,
        outlineOffset: isLinkSource ? '2px' : undefined,
        zIndex: isLinkSource || selected ? 10 : 2,
        // Fold/unfold flips opacity — hard cut, matches the rest of the
        // UI's snap-in/out affordances (2026-07-02 反馈 "利索"). Layout
        // positions stay fixed so nothing else shifts. Position transition
        // still smooth for add/delete/pin drag; suppressed tree-wide
        // during any drag so pills and SVG bracket lines stay in lockstep.
        opacity: laid.isVisible ? 1 : 0,
        pointerEvents: laid.isVisible ? 'auto' : 'none',
        transition: suppressTransition
          ? 'none'
          : 'left 180ms cubic-bezier(0.4, 0, 0.2, 1), top 180ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 120ms ease-out',
      }}
      title={editing ? undefined : node.title}
    >
      {editing ? (
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            // IME 组字守卫（IME 组字守卫 同族）：选词 Enter 不提交
            if (e.nativeEvent.isComposing) return;
            // Enter commits; Shift+Enter inserts a newline so notes
            // can have deliberate line breaks. Escape reverts.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          rows={1}
          className="bg-transparent focus:outline-none"
          style={{
            fontSize,
            lineHeight: '1.4',
            fontWeight: 'inherit',
            color: 'inherit',
            border: 'none',
            padding: 0,
            width: '100%',
            minWidth: 0,
            resize: 'none',
            overflow: 'hidden',
            fontFamily: 'inherit',
            display: 'block',
          }}
        />
      ) : isFreeNote ? (
        // Free-floating note card: source tag (if present) + headline
        // title + content body. Only the title becomes the input in
        // edit mode. Content editing is TODO (Inspector textarea).
        <div
          className="flex flex-col"
          style={{ gap: '5px', flex: '1 1 auto', minWidth: 0, width: '100%' }}
        >
          {node.source_title && (
            <div
              style={{
                fontSize: '10px',
                lineHeight: '14px',
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                opacity: noteFill ? 0.75 : 0.55,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                whiteSpace: 'normal',
                wordBreak: 'break-word',
              }}
            >
              {node.source_title}
            </div>
          )}
          <div
            style={{
              fontSize: '13px',
              lineHeight: '1.4',
              fontWeight: 600,
              whiteSpace: 'normal',
              wordBreak: 'break-word',
            }}
          >
            {node.title || 'Untitled'}
          </div>
          {node.content && node.content.trim() && (
            <div
              style={{
                fontSize: '12px',
                lineHeight: '1.5',
                opacity: noteFill ? 0.9 : 0.75,
                whiteSpace: 'normal',
                wordBreak: 'break-word',
              }}
            >
              {node.content}
            </div>
          )}
        </div>
      ) : (
        <span
          style={{
            whiteSpace: 'normal',
            wordBreak: 'break-word',
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical' as const,
            WebkitLineClamp: 3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flex: '1 1 auto',
            minWidth: 0,
          }}
        >
          {node.title || 'Untitled'}
        </span>
      )}
      {hasChildren && (
        <button
          type="button"
          onPointerDown={(e) => {
            // Otherwise the pill's pointerdown fires setPointerCapture
            // on itself and steals the subsequent click from the button.
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
          className="flex-none inline-flex items-center justify-center border rounded-[3px] font-normal transition-colors duration-[var(--ls-duration-fast)]"
          style={{
            width: '16px',
            height: '16px',
            fontSize: '12px',
            lineHeight: '1',
            borderColor: noteFill ? 'rgba(255,255,255,0.4)' : 'var(--ls-border)',
            color: noteFill ? '#fff' : 'var(--ls-text-secondary)',
            background: noteFill ? 'rgba(255,255,255,0.15)' : 'var(--ls-bg)',
          }}
          title={expanded ? t('mindmap.collapseSubtreeTitle') : t('mindmap.expandSubtreeTitle')}
        >
          {expanded ? '−' : '+'}
        </button>
      )}
    </div>
  );
}

/* --------- PendingPool --------- */
//
// Right-column panel above Inspector. Lists PendingMindmapCards that
// haven't been placed anywhere yet (FSRS-hard flashcards, lesson
// highlights, exercise misses etc). Each card is HTML5-draggable — drop
// on the canvas creates a note node at the drop position (see
// EditorCanvas.onDrop). Dismissing a card removes it from the pool.

// Floating popover that hangs off the toolbar Pending trigger button.
// Not a permanent panel — user opens, drags cards to canvas, closes.
// Positioned absolute inside the trigger's relative wrapper so it aligns
// under the button (top-left of viewport regardless of scroll).
function PendingPoolPopover({
  cards,
  pairId,
  qc,
  repo,
}: {
  cards: PendingMindmapCard[];
  pairId: PairId | null;
  qc: ReturnType<typeof useQueryClient>;
  repo: ReturnType<typeof useRepository>;
}) {
  const { t } = useT();
  const dismissMut = useMutation({
    mutationFn: (id: PendingCardId) => {
      if (!repo) throw new Error('no repo');
      return repo.dismissPendingCard(id);
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['pending-cards', pairId] }),
  });

  return (
    <aside
      className="flex flex-col border border-[var(--ls-border)] bg-[var(--ls-bg)]"
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        marginTop: '8px',
        width: 320,
        borderRadius: '10px',
        padding: '14px 14px 12px',
        gap: '10px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.16)',
        zIndex: 40,
      }}
    >
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium leading-4 tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)]">
          {t('mindmap.pendingPoolPrefix')}{cards.length}
        </div>
      </div>
      {true && (
        <>
          <p className="text-[10px] leading-4 text-[var(--ls-text-tertiary)]">
            {t('mindmap.dragCardHint')}
          </p>
          <ul
            className="flex flex-col overflow-y-auto"
            style={{ gap: '8px', maxHeight: '260px' }}
          >
            {cards.map((p) => (
              <li
                key={p.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    'application/x-ls-pending',
                    String(p.id)
                  );
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                className="border border-[var(--ls-border)] bg-[var(--ls-bg-subtle)] hover:border-[var(--ls-border-strong)] transition-colors"
                style={{
                  padding: '10px 12px',
                  borderRadius: '8px',
                  cursor: 'grab',
                }}
              >
                <div
                  className="flex items-start justify-between"
                  style={{ gap: '6px' }}
                >
                  <span
                    className="border tracking-[0.04em] uppercase text-[var(--ls-text-tertiary)]"
                    style={{
                      padding: '1px 6px',
                      borderRadius: '4px',
                      fontSize: '9px',
                      lineHeight: '12px',
                      borderColor: 'var(--ls-border)',
                    }}
                  >
                    {t(PENDING_SOURCE_LABEL_KEY[p.source_type] ?? 'pool.source.manual')}
                  </span>
                  <button
                    type="button"
                    onClick={() => dismissMut.mutate(p.id)}
                    className="text-[var(--ls-text-tertiary)] hover:text-[var(--ls-risk)]"
                    style={{ fontSize: '14px', lineHeight: 1 }}
                    title={t('mindmap.dismissTitle')}
                  >
                    ×
                  </button>
                </div>
                <div
                  className="font-medium text-[12px] leading-4"
                  style={{ marginTop: '6px' }}
                >
                  {p.title}
                </div>
                <p
                  className="text-[11px] leading-[16px] text-[var(--ls-text-secondary)]"
                  style={{ marginTop: '4px' }}
                >
                  {p.content}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

/* --------- Inspector --------- */

function Inspector({
  node,
  connectedLinks,
  allNodes,
  collapsed,
  onToggleCollapse,
  onUpdate,
  onDelete,
  pinned,
  onUnpin,
  onRestoreToPool,
  onRemoveLink,
}: {
  node: MindmapNode | null;
  connectedLinks: Array<{ id: string; from_node_id: string; to_node_id: string; label?: string }>;
  allNodes: MindmapNode[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onUpdate: (patch: Partial<MindmapNode>) => void;
  onDelete: () => void;
  // Whether the SELECTED node currently has a manual position override —
  // node.is_pinned in Tree mode, a local radialPins entry in Radial mode
  // (see computeRadialLaidOut's doc comment for why they're separate).
  pinned: boolean;
  onUnpin: () => void;
  onRestoreToPool: () => void;
  onRemoveLink: (linkId: string) => void;
}) {
  const { t } = useT();
  const width = 320;
  const wrapCls =
    'flex-none border border-[var(--ls-border)] bg-[var(--ls-bg)] flex flex-col';
  const wrapStyle: React.CSSProperties = {
    width,
    borderRadius: '10px',
    padding: '16px',
    gap: '14px',
  };

  // Rail mode — click anywhere on the 40px column to expand.
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex-none flex items-center justify-center border border-[var(--ls-border)] bg-[var(--ls-bg)] hover:bg-[var(--ls-panel)] transition-colors"
        style={{
          width: 40,
          minHeight: 160,
          borderRadius: '10px',
          padding: '12px 0',
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          fontSize: '11px',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--ls-text-secondary)',
          gap: '10px',
        }}
        title={t('mindmap.expandInspectorTitle')}
      >
        <span>{t('mindmap.inspectorLabel')}{node ? `${t('mindmap.inspectorNodeLevelSuffix')}${node.level}` : ''}</span>
      </button>
    );
  }

  if (!node) {
    return (
      <aside className={wrapCls} style={wrapStyle}>
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium leading-4 tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)]">
            {t('mindmap.inspectorLabel')}
          </div>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="text-[13px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors"
            style={{ padding: '2px 6px', lineHeight: '1' }}
            title={t('mindmap.collapseToRailTitle')}
          >
            ›
          </button>
        </div>
        <p className="text-[12px] leading-[18px] text-[var(--ls-text-tertiary)]">
          {t('mindmap.clickNodeHintFull')}<Kbd>Tab</Kbd>{t('mindmap.clickNodeHintSuffix')}
        </p>
      </aside>
    );
  }

  // Free notes render their fill unconditionally as the token blue (see
  // the noteFill comment on the Pill component) — the swatch picker below
  // would be inert for them, so it's hidden rather than shown-but-dead.
  const isFreeNoteNode = node.level === 'note' && !node.parent_id;

  return (
    <aside className={wrapCls} style={wrapStyle}>
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium leading-4 tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)]">
          {t('mindmap.nodeLevelPrefix')}{node.level}
        </div>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="text-[13px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors"
          style={{ padding: '2px 6px', lineHeight: '1' }}
          title={t('mindmap.collapseToRailTitle')}
        >
          ›
        </button>
      </div>

      <label className="flex flex-col" style={{ gap: '4px' }}>
        <span className="text-[10px] font-medium leading-3 tracking-[0.06em] uppercase text-[var(--ls-text-tertiary)]">
          {t('mindmap.titleLabel')}
        </span>
        <input
          type="text"
          value={node.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          className="w-full border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[13px] leading-5 focus:outline-none focus:border-[var(--ls-border-strong)]"
          style={{ padding: '7px 10px', borderRadius: '6px' }}
        />
      </label>

      {/* No Content field — 2026-07-01 定向: 思维导图就该层级展开, 不藏 content.
          Any sub-thought becomes a child node instead. */}

      <label className="flex flex-col" style={{ gap: '4px' }}>
        <span className="text-[10px] font-medium leading-3 tracking-[0.06em] uppercase text-[var(--ls-text-tertiary)]">
          {t('mindmap.levelLabel')}
        </span>
        <select
          value={node.level}
          onChange={(e) => onUpdate({ level: e.target.value as NodeLevel })}
          className="w-full border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[13px] leading-5 focus:outline-none focus:border-[var(--ls-border-strong)]"
          style={{ padding: '7px 10px', borderRadius: '6px' }}
        >
          <option value="root">{t('mindmap.rootOption')}</option>
          <option value="branch">{t('mindmap.branchOption')}</option>
          <option value="detail">{t('mindmap.detailOption')}</option>
          <option value="note">{t('mindmap.noteOption')}</option>
        </select>
      </label>

      {!isFreeNoteNode && (
        <div className="flex flex-col" style={{ gap: '4px' }}>
          <span className="text-[10px] font-medium leading-3 tracking-[0.06em] uppercase text-[var(--ls-text-tertiary)]">
            {t('mindmap.fillHighlightLabel')}
          </span>
          <div className="flex flex-wrap items-center" style={{ gap: '6px' }}>
            {NODE_COLORS.map((c) => {
              const active = (node.color ?? '') === c.hex;
              return (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => onUpdate({ color: c.hex || undefined })}
                  title={t(NODE_COLOR_LABEL_KEY[c.name] ?? 'mindmap.color.default')}
                  className="border transition-transform duration-[var(--ls-duration-fast)] hover:scale-110"
                  style={{
                    width: '22px',
                    height: '22px',
                    borderRadius: '50%',
                    background: c.hex || 'var(--ls-bg)',
                    borderColor: active ? 'var(--ls-text)' : 'var(--ls-border)',
                    borderWidth: active ? '2px' : '1px',
                  }}
                />
              );
            })}
          </div>
        </div>
      )}

      {connectedLinks.length > 0 && (
        <div className="flex flex-col" style={{ gap: '4px' }}>
          <span className="text-[10px] font-medium leading-3 tracking-[0.06em] uppercase text-[var(--ls-text-tertiary)]">
            {t('mindmap.connectionsPrefix')}{connectedLinks.length}
          </span>
          <ul className="flex flex-col" style={{ gap: '4px' }}>
            {connectedLinks.map((link) => {
              const otherId =
                link.from_node_id === node.id
                  ? link.to_node_id
                  : link.from_node_id;
              const other = allNodes.find((n) => n.id === otherId);
              const otherTitle =
                other?.title?.trim() || t('mindmap.missingNodeFallback');
              return (
                <li
                  key={link.id}
                  className="flex items-center border border-[var(--ls-border)] bg-[var(--ls-bg-subtle)]"
                  style={{
                    padding: '5px 8px',
                    borderRadius: '5px',
                    gap: '6px',
                  }}
                >
                  <span
                    className="text-[var(--ls-text-tertiary)] tabular-nums"
                    style={{ fontSize: '11px', flex: '0 0 auto' }}
                    title={t('mindmap.freeLinkTitle')}
                  >
                    ↔
                  </span>
                  <span
                    className="truncate"
                    style={{ fontSize: '12px', flex: '1 1 auto', minWidth: 0 }}
                  >
                    {otherTitle}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemoveLink(link.id)}
                    className="flex-none text-[var(--ls-text-tertiary)] hover:text-[var(--ls-risk)] transition-colors"
                    style={{
                      fontSize: '14px',
                      lineHeight: 1,
                      padding: '0 4px',
                    }}
                    title={t('mindmap.unlinkTitle')}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div style={{ flex: 1 }} />

      <button
        type="button"
        onClick={onDelete}
        className="inline-flex items-center justify-center border text-[12px] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
        style={{
          height: '32px',
          padding: '0 12px',
          borderRadius: '6px',
          color: 'var(--ls-risk)',
          borderColor: 'color-mix(in srgb, var(--ls-risk) 30%, var(--ls-border))',
        }}
      >
        {t('mindmap.deleteNodeButton')}
      </button>
      {pinned && (
        <button
          type="button"
          onClick={onUnpin}
          className="inline-flex items-center justify-center border text-[11px] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
          style={{
            marginTop: '6px',
            height: '28px',
            padding: '0 12px',
            borderRadius: '6px',
            color: 'var(--ls-text-secondary)',
            borderColor: 'var(--ls-border)',
          }}
          title={t('mindmap.returnAutoLayoutTitle')}
        >
          {t('mindmap.restoreAutoPosition')}
        </button>
      )}
      {node.level === 'note' && node.source_type && (
        <button
          type="button"
          onClick={onRestoreToPool}
          className="inline-flex items-center justify-center border text-[11px] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
          style={{
            marginTop: '6px',
            height: '28px',
            padding: '0 12px',
            borderRadius: '6px',
            color: 'var(--ls-text-secondary)',
            borderColor: 'var(--ls-border)',
          }}
          title={t('mindmap.moveNoteToPoolTitle')}
        >
          {t('mindmap.restoreToPendingPool')}
        </button>
      )}
    </aside>
  );
}

