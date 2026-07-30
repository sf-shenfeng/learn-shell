// PagedLesson — PPT-style paged lesson renderer (docs/LESSON-BLOCKS-v1.md).
//
// One page, one point: kicker eyebrow + single h2 + body + ≤1 interactive
// block. `---` splits pages; ::kicker[...] is chrome, not content.
// Lessons authored before paging (no kicker anywhere) fall back to the
// legacy single-scroll prose view so fixture content keeps working.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkDirective from 'remark-directive';
import type { AnnotationId, Lesson as LessonModel, LessonPatch } from '@learn-shell/contracts';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';
import { getDisplayPages, countTrialBlocks, type LessonPage } from './paging';
import { remarkLsBlocks, remarkMark } from './remarkLsBlocks';
import { LessonContextProvider } from './LessonContext';
import PageDots from './PageDots';
import { useT } from '../i18n';
// Annotation — mouseup capture → serialize → persist; GET annotations
// resolved + painted via CSS Custom Highlight API (batch A, replaces the
// spike). Batch B (brief
// 交付物 1/2/4): grown pill (color + note), click-to-open overlay on
// existing highlights, and the in-lesson notes panel.
import { useAnnotations } from '../annotation/useAnnotations';
import AnnotationPill from '../annotation/AnnotationPill';
import AnnotationOverlay from '../annotation/AnnotationOverlay';
import AnnotationNotesPanel from '../annotation/AnnotationNotesPanel';
import type { AnnotationHost } from '../annotation/host';
import {
  ConceptFlip,
  FormulaPanel,
  TrialBlock,
  Callout,
  CfaNote,
  UnknownBlock,
} from './blocks';

const MD_COMPONENTS = {
  'ls-concept-flip': ConceptFlip,
  'ls-formula': FormulaPanel,
  'ls-trial': TrialBlock,
  'ls-callout': Callout,
  'ls-cfa-note': CfaNote,
  'ls-unknown': UnknownBlock,
  mark: ({ children }: { children?: React.ReactNode }) => (
    <mark
      style={{
        background: 'var(--ls-hyp-tint)',
        color: 'var(--ls-text)',
        padding: '0 3px',
        borderRadius: '3px',
      }}
    >
      {children}
    </mark>
  ),
} as unknown as Components;

// No max-w-none override: Tailwind Typography's default 65ch prose measure
// is exactly the reading-width cap the design asked for (阅读留白案 — "宽裕感来自
// 留白与模块呼吸，不来自把字拉宽"). The page card itself (and, upstream, the
// AppShell column) can be as wide as it likes; only the running text caps.
// Exported (批G, "MD 渲染贴现有课文排版语言")
// — apps/web/src/document/DocumentReader.tsx reuses this exact class string
// rather than re-tuning its own prose measure/type scale from scratch.
export const PROSE_CLS = `prose prose-sm
  prose-headings:font-semibold prose-headings:tracking-tight
  prose-headings:text-[var(--ls-text)]
  prose-h2:text-[22px] prose-h2:leading-[30px] prose-h2:mt-0 prose-h2:mb-4
  prose-li:text-[var(--ls-text)] prose-td:text-[var(--ls-text)]
  prose-th:text-[var(--ls-text-secondary)]
  prose-p:text-[15px] prose-p:leading-7
  prose-p:text-[var(--ls-text)]
  prose-strong:text-[var(--ls-text)]
  prose-code:text-[var(--ls-text)] prose-code:bg-[var(--ls-panel)]
  prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[13px]`;

const KICKER_COLOR: Record<string, string> = {
  HOOK: 'var(--ls-text-tertiary)',
  FABLE: 'var(--ls-hypothesis)',
  NAME: 'var(--ls-structure)',
  FORMULA: 'var(--ls-structure)',
  EXAMPLE: 'var(--ls-corroborated)',
  TRIAL: 'var(--ls-structure)',
  TRAPS: 'var(--ls-risk)',
  EXAM: 'var(--ls-text-secondary)',
  NEXT: 'var(--ls-corroborated)',
};

function LessonMarkdown({
  markdown,
  lessonId,
  trialIndexStart = 0,
  plainMarkdown = false,
}: {
  markdown: string;
  lessonId: string;
  /** Whole-lesson-order starting index for `:::trial` blocks on this page
   *  (PagedLesson renders each page through its own ReactMarkdown pass, so
   *  this plugin instance otherwise has no idea how many trial blocks came
   *  before it). */
  trialIndexStart?: number;
  /** 自动分页兜底案 病一 — true for auto-paginated pages (paging.ts's
   *  getDisplayPages autoPaged flag): content that never passed the paging
   *  contract (no ::kicker/---) shouldn't have its prose interpreted as the
   *  ::: / :: block dialect either. remark-directive's bare textDirective
   *  syntax is just "`:` + non-punctuation/non-whitespace run" — no brackets
   *  required — so ordinary `**Label**:值` prose (colon directly against
   *  CJK text, no space) parses as a directive whose name is the first run
   *  of characters up to the next bit of punctuation, and remarkLsBlocks
   *  then renders that as an UNREGISTERED BLOCK, eating the matched prose.
   *  Loosening the regex only narrows the collision; the actual fix is mode
   *  isolation — skip remarkDirective/remarkLsBlocks entirely for content
   *  that isn't playing the directive-block game, and render it as plain
   *  markdown (still with GFM tables/etc + the ==mark== dialect, neither of
   *  which touch `:`). Legally paged pages (autoPaged: false) are
   *  unaffected — this only ever flips for the auto-pagination fallback. */
  plainMarkdown?: boolean;
}) {
  // New plugin instance per (markdown, offset) — remarkLsBlocks closes over
  // a trialCounter that must start fresh for each page's independent parse.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-markdown
  // doesn't re-export unified's PluggableList type; [plugin, options] tuple
  // form is standard unified but not worth adding a direct `unified` dep for.
  const remarkPlugins = useMemo(
    () =>
      plainMarkdown
        ? ([remarkGfm, remarkMark] as any[])
        : ([remarkGfm, remarkDirective, [remarkLsBlocks, trialIndexStart], remarkMark] as any[]),
    [trialIndexStart, plainMarkdown]
  );
  return (
    // mx-auto: prose's own 65ch max-width caps the reading measure but
    // doesn't center itself — without this the text hugs the left edge and
    // the released width just becomes lopsided right-side padding instead
    // of the "left+right breathing room" 阅读留白案 asked for.
    <div className={`${PROSE_CLS} mx-auto`}>
      <LessonContextProvider value={{ lessonId }}>
        <ReactMarkdown remarkPlugins={remarkPlugins} components={MD_COMPONENTS}>
          {markdown}
        </ReactMarkdown>
      </LessonContextProvider>
    </div>
  );
}

// §4 改课三律落点渲染 (2026-07-11 施工批) — teacher_note (学习中的课, 追加注) / erratum (已学完的
// 课, 原文并列勘误). Visual language borrows blocks.tsx's Callout idiom
// verbatim (border-l-2 + color-coded eyebrow label) — brief's own instruction
// ("现有 callout/注释语言里选最贴的") is satisfied literally, not a new
// component family.
const LABEL_CLS = 'text-[10px] uppercase tracking-[0.08em] font-medium';

function LessonPatchNote({ patch }: { patch: LessonPatch }) {
  const { t } = useT();
  const isErratum = patch.kind === 'erratum';
  const color = isErratum ? 'var(--ls-risk)' : 'var(--ls-structure)';
  const label = isErratum ? t('lesson.patch.erratumLabel') : t('lesson.patch.teacherNoteLabel');
  return (
    <div
      className="border-l-2"
      style={{ borderColor: color, paddingLeft: '16px', marginTop: '18px', paddingTop: '2px', paddingBottom: '2px' }}
    >
      <div className={LABEL_CLS} style={{ color, marginBottom: '4px' }}>
        {label}
        {isErratum ? ` · ${new Date(patch.created_at).toLocaleDateString()}` : ''}
      </div>
      <div className="text-[14px] leading-[23px] text-[var(--ls-text)]" style={{ whiteSpace: 'pre-wrap' }}>
        {patch.body}
      </div>
      {patch.source_attribution && (
        <div className="text-[12px] leading-[18px] text-[var(--ls-text-tertiary)]" style={{ marginTop: '4px' }}>
          {patch.source_attribution}
        </div>
      )}
    </div>
  );
}

/** anchor is free text (§4 data model comment: "锚定页码或引用原文片段, 自由
 *  文本, 不强制结构") — this pass only resolves the common case (anchor is a
 *  bare 1-based page number) to an actual position; anything else (a text
 *  fragment, or no anchor at all) reads as "挂课末" and surfaces once on the
 *  last page instead of silently vanishing. */
function splitPatchesByPage(
  patches: LessonPatch[],
  pageCount: number
): { byPage: Map<number, LessonPatch[]>; unanchored: LessonPatch[] } {
  const byPage = new Map<number, LessonPatch[]>();
  const unanchored: LessonPatch[] = [];
  for (const p of patches) {
    const n = p.anchor != null ? Number(p.anchor) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= pageCount) {
      const list = byPage.get(n - 1) ?? [];
      list.push(p);
      byPage.set(n - 1, list);
    } else {
      unanchored.push(p);
    }
  }
  return { byPage, unanchored };
}

export default function PagedLesson({
  lesson,
  fillHeight = false,
  initialPageIndex,
  patches = [],
  onPagesRead,
}: {
  lesson: LessonModel;
  /** Classroom (Focus) mode: stretch to fill the flex column that hosts it
   *  instead of the viewport-relative minHeight clamp, so the pager scrolls
   *  internally rather than producing an outer page scrollbar. Old
   *  (pre-paging) lessons get the same treatment via a scrollable wrapper
   *  so the legacy fallback path also works inside the classroom split. */
  fillHeight?: boolean;
  /** ?page= deep link (batch D) — Journal's
   *  "我的笔记"/孤儿区 jump back to the lesson at this page. One-way (URL→state,
   *  same as Mindmap's ?map=): only consulted on mount / when it changes,
   *  never written back as the pager is navigated in-place. */
  initialPageIndex?: number;
  /** §4 改课三律落点 (teacher_note/erratum) — Lesson.tsx fetches once per
   *  lesson and passes down; empty by default so any other caller keeps
   *  working unchanged. */
  patches?: LessonPatch[];
  /** Furthest page reached this mount, lifted for the §6 完成核对单预览
   *  (declare-completed checklist) — same "furthest, not current" semantics
   *  as the existing lesson.viewed progressRef below, just exposed outward.
   *  Third arg `currentPageIndex` (迁移 0037, 学习者裁决第三针) is the raw
   *  0-based page index currently on screen — Lesson.tsx forwards it as
   *  `current_page_index` on declare-completed, unioned server-side with the
   *  persisted pages_visited footprint (see routes/write.ts). `read`/`total`
   *  above stay a same-mount preview number only; the authoritative count
   *  written to the checklist snapshot is computed server-side, not from
   *  these two. */
  onPagesRead?: (read: number, total: number, currentPageIndex: number) => void;
}) {
  const content = lesson.content_markdown ?? '';
  // 自动分页兜底案 — legally paged content passes through unchanged; anything
  // without a legal paging structure (free markdown, a partial/broken paging
  // attempt, whatever slipped past write-time validation before it existed)
  // gets auto-split into synthetic pages instead of the old single-scroll
  // fallback (see paging.ts's getDisplayPages doc comment).
  const { pages, autoPaged } = useMemo(() => getDisplayPages(content), [content]);

  // lesson.viewed learning evidence — recorded on unmount with how far the
  // learner actually got. Dwell < 3s is dropped (StrictMode remounts, misclicks).
  const repo = useRepository();
  const { pairId } = usePair();
  const qc = useQueryClient();
  const progressRef = useRef(0);
  useEffect(() => {
    const mountedAt = Date.now();
    const lessonId = lesson.id;
    // 最近接触二期 (2026-07-30): payload 多带一枚 course_id。Recents 的 Lesson
    // 行原本认活跃契约的课程 (契约没换课, 行就永远指着同一门), 现在改认"最近
    // 一条带 course_id 的 lesson.viewed", 那个字段就是这里写出去的。课程 id
    // 直接取自 lesson 自己 (lesson.course_id), 不需要从路由再穿一层 prop。
    const courseId = lesson.course_id;
    return () => {
      if (Date.now() - mountedAt < 3000) return;
      if (!repo || !pairId) return;
      repo
        .recordLearningEvent({
          pair_id: pairId,
          event_type: 'lesson.viewed',
          mode: 'self_study',
          payload: {
            lesson_id: lessonId,
            position_at_close: progressRef.current,
            course_id: courseId,
          },
        })
        // 最近接触 (2026-07-30): 这枚事件正是 Recents"继续学习"行的排序依据,
        // 而那条边栏常驻不卸载——不主动作废它就要等下一次窗口聚焦才刷新,
        // 于是"刚读完这节课, 回头 Recents 还指着上一节"。同 DocumentReader /
        // Mindmap 两行的 fire → invalidate 同一手法。lesson_progress 那半
        // (翻页 touch 写的) 一并作废, 两根信号都新鲜。
        .then(() => {
          // sessions 一起作废: 隔了 30 分钟再看课, 这枚事件会开一场新
          // session, 边栏手里那份"最近场次"名单已经过期了。
          qc.invalidateQueries({ queryKey: ['recent-rail', 'sessions', pairId] });
          qc.invalidateQueries({ queryKey: ['recent-rail', 'session-events'] });
          qc.invalidateQueries({ queryKey: ['course-progress', pairId] });
        })
        .catch((e) => console.error('[lesson.viewed]', e));
    };
  }, [repo, pairId, lesson.id, lesson.course_id, qc]);

  return (
    <Pager
      lesson={lesson}
      pages={pages}
      autoPaged={autoPaged}
      fillHeight={fillHeight}
      initialPageIndex={initialPageIndex}
      patches={patches}
      onProgress={(frac, index) => {
        // 学习者裁决第三针 (2026-07-20): 这个数字之前直接喂 `frac`(当前页的
        // 瞬时分数), 跟头顶的 doc comment 承诺的"furthest, not current"语义
        // 对不上——学完全部翻回第 4 页复习, 这里就会把 4 报出去。改用
        // progressRef.current(本来就在维护的本挂载期最远高水位)——这只是这
        // 个组件内、本次挂载的预览数字; declare-completed 实际写盘的
        // pages_read 走服务端 pages_visited 足迹集合, 更权威(见 Pager 内的
        // touchLessonProgress 埋点 effect 与 Lesson.tsx 的 declare-completed
        // 调用点)。
        progressRef.current = Math.max(progressRef.current, frac);
        onPagesRead?.(Math.round(progressRef.current * pages.length), pages.length, index);
      }}
    />
  );
}

function Pager({
  lesson,
  pages,
  autoPaged = false,
  fillHeight = false,
  initialPageIndex,
  patches = [],
  onProgress,
}: {
  lesson: LessonModel;
  pages: LessonPage[];
  /** 自动分页兜底案 — true when `pages` came from paging.ts's auto-pagination
   *  fallback (no legal `::kicker`/`---` structure found) rather than the
   *  lesson's own authored page breaks. Surfaced as a low-key notice in the
   *  page chrome, same register as blocks.tsx's UnknownBlock. */
  autoPaged?: boolean;
  fillHeight?: boolean;
  initialPageIndex?: number;
  patches?: LessonPatch[];
  /** Second arg is the raw 0-based page index (迁移 0037) — passed straight
   *  through from the `index` state below, alongside the existing frac. */
  onProgress?: (frac: number, index: number) => void;
}) {
  const { t } = useT();
  const [index, setIndex] = useState(initialPageIndex ?? 0);
  const count = pages.length;
  const repo = useRepository();

  // §4 改课三律落点 — resolve once per (patches, pageCount) change, not per
  // render/page-flip.
  const { byPage: patchesByPage, unanchored: unanchoredPatches } = useMemo(
    () => splitPatchesByPage(patches, count),
    [patches, count]
  );

  // Whole-lesson-order trialIndex offset per page —
  // each page is its own ReactMarkdown pass, so remarkLsBlocks can't
  // see trial blocks on earlier pages on its own. §1.2 caps pages at one
  // interactive block, so offsets[i] is just "how many earlier pages had one".
  const trialOffsets = useMemo(() => {
    const offsets: number[] = [];
    let running = 0;
    for (const p of pages) {
      offsets.push(running);
      running += countTrialBlocks(p.markdown);
    }
    return offsets;
  }, [pages]);

  useEffect(() => {
    onProgress?.((index + 1) / count, index);
  }, [index, count, onProgress]);
  const clampedIndex = Math.min(index, count - 1);
  const page = pages[clampedIndex]!;

  // 足迹埋点 (迁移 0037, 学习者裁决第三针, 2026-07-20) — 每次落到一页(含
  // 初始页)静默 touch 一次, 把这页的 0-based 索引并入服务端的
  // lesson_progress.pages_visited 集合; declare-completed 的核对单页数从这
  // 个集合算, 不再相信"当前页"这个瞬时数字。本地 Set 只是"这次挂载已经打过
  // 点的页"防重复发射(同一页反复触发这条 effect 时不必重复打点), 不是足迹
  // 本身——真正的足迹活在服务端, 换设备/清缓存都在。失败静默, 同
  // touchLessonProgress 既有的"只是个 ping, 不打扰学习者"纪律。
  const touchedPagesRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    touchedPagesRef.current = new Set();
  }, [lesson.id]);
  useEffect(() => {
    if (!repo || touchedPagesRef.current.has(clampedIndex)) return;
    touchedPagesRef.current.add(clampedIndex);
    repo.touchLessonProgress(lesson.id, clampedIndex).catch(() => {
      // 静默失败 — 只是足迹 ping, 不该弹错误打断阅读。
    });
  }, [repo, lesson.id, clampedIndex]);
  const isLast = index >= count - 1;

  // Annotation — see import above. 批G: host generalized to
  // AnnotationHost — this call site is
  // still always 'lesson', the document/DocumentReader.tsx counterpart
  // passes { kind: 'document', id } instead.
  const pageBodyRef = useRef<HTMLDivElement>(null);
  const { pairId } = usePair();
  const lessonHost = useMemo<AnnotationHost>(() => ({ kind: 'lesson', id: lesson.id }), [lesson.id]);
  const annotations = useAnnotations(pageBodyRef, lessonHost, clampedIndex, pairId);

  // Overlay for an existing highlight (batch B 交付物 2) — Pager owns which
  // annotation is active + where to float the panel; the click-point coords
  // double as the fixed-position anchor (brief: "取实现简单可靠的").
  const [activeAnnotationId, setActiveAnnotationId] = useState<AnnotationId | null>(null);
  const [overlayPos, setOverlayPos] = useState<{ left: number; top: number } | null>(null);
  const activeAnnotation =
    activeAnnotationId != null
      ? (annotations.allAnnotations.find((a) => a.id === activeAnnotationId) ?? null)
      : null;

  // Reset to page 1 when switching lessons (or jump straight to a ?page=
  // deep link, batch D — Journal's notes/orphan rows link to a specific
  // page). Merged into one effect keyed on both deps rather than two
  // separate ones: a lesson-switch effect keyed only on [lesson.id] would
  // fire on the very same render as an initialPageIndex-keyed effect and
  // race it (mount counts as "changed" for both), stomping whichever ran
  // second back to page 1. Re-running this on mount with the same value
  // `useState` already initialized to is a harmless no-op.
  useEffect(() => {
    setIndex(initialPageIndex ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson.id, initialPageIndex]);

  // A stale overlay pointing at a previous page's (unmounted) DOM makes no
  // sense once the page changes — same "no stale pending" instinct as
  // useAnnotations' own pending-reset effect.
  useEffect(() => {
    setActiveAnnotationId(null);
  }, [lesson.id, clampedIndex]);

  // Dismiss the overlay on outside click / Escape. The overlay's own
  // onMouseDown stopPropagation keeps interacting with it (dots, textarea,
  // buttons) from reaching this document-level listener — same idiom as
  // useAnnotations' pending-dismiss effect.
  useEffect(() => {
    if (!activeAnnotationId) return;
    const onMouseDown = () => setActiveAnnotationId(null);
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') setActiveAnnotationId(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activeAnnotationId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, count - 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count]);

  const kickerColor = page.kicker
    ? (KICKER_COLOR[page.kicker] ?? 'var(--ls-text-tertiary)')
    : 'var(--ls-text-tertiary)';

  return (
    <>
      <section
        className="border border-[var(--ls-border)] bg-[var(--ls-bg)] flex flex-col"
        style={{
          borderRadius: '12px',
          minHeight: fillHeight ? 0 : 'min(680px, calc(100vh - 300px))',
          flex: fillHeight ? '1 1 auto' : undefined,
        }}
      >
        {/* Page chrome header */}
        <div
          className="flex items-center justify-between border-b border-[var(--ls-border)]"
          style={{ padding: '14px 24px', flexShrink: 0 }}
        >
          <span
            className="text-[11px] uppercase tracking-[0.14em] font-semibold"
            style={{ color: kickerColor }}
          >
            {page.kicker ?? '·'}
          </span>
          <span className="text-[11px] text-[var(--ls-text-tertiary)] tabular-nums">
            {index + 1} / {count}
          </span>
        </div>

        {autoPaged && (
          <div
            className="text-[11px] text-[var(--ls-text-tertiary)] border-b border-dashed border-[var(--ls-border)]"
            style={{ padding: '6px 24px', flexShrink: 0 }}
          >
            {t('lesson.autoPagedNotice')}
          </div>
        )}

        {annotations.pending && (
          <AnnotationPill
            pending={annotations.pending}
            onConfirmColor={(color) => annotations.confirm({ color })}
            onConfirmNote={(color, note) => annotations.confirm({ color, note })}
          />
        )}

        {activeAnnotation && overlayPos && (
          <AnnotationOverlay
            annotation={activeAnnotation}
            left={overlayPos.left}
            top={overlayPos.top}
            host={lessonHost}
            pairId={pairId}
            hostTitle={lesson.title}
            onClose={() => setActiveAnnotationId(null)}
          />
        )}

        {/* Page body */}
        <div
          key={index}
          ref={pageBodyRef}
          className="flex-1 flex flex-col ls-page-enter"
          style={{
            padding: '32px 40px',
            overflowY: 'auto',
            minHeight: 0,
            justifyContent: page.kicker === 'TRIAL' ? 'center' : 'flex-start',
          }}
          onClick={(e) => {
            // A drag-selection release also fires 'click' afterward — skip
            // hit-testing while a real (non-collapsed) selection is live so
            // this never fights with useAnnotations' own mouseup→pending
            // capture (batch A). Plain clicks always land with a collapsed
            // selection by the time 'click' fires (browsers collapse the
            // selection at mousedown for a simple click).
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) return;
            const hitId = annotations.hitTest(e.clientX, e.clientY);
            if (hitId) {
              setActiveAnnotationId(hitId);
              setOverlayPos({ left: e.clientX, top: e.clientY });
            } else {
              setActiveAnnotationId(null);
            }
          }}
        >
          <LessonMarkdown
            markdown={page.markdown}
            lessonId={lesson.id}
            trialIndexStart={trialOffsets[clampedIndex] ?? 0}
            plainMarkdown={autoPaged}
          />

          {(patchesByPage.get(clampedIndex) ?? []).map((p) => (
            <LessonPatchNote key={p.id} patch={p} />
          ))}

          {isLast && unanchoredPatches.length > 0 && (
            <div style={{ marginTop: '28px' }}>
              <div className={LABEL_CLS} style={{ color: 'var(--ls-text-tertiary)', marginBottom: '10px' }}>
                {t('lesson.patch.sectionHeading')}
              </div>
              <div className="flex flex-col" style={{ gap: '4px' }}>
                {unanchoredPatches.map((p) => (
                  <LessonPatchNote key={p.id} patch={p} />
                ))}
              </div>
            </div>
          )}

          {isLast && (
            <div
              className="border-t border-[var(--ls-border)] flex items-center justify-between flex-wrap"
              style={{ marginTop: '28px', paddingTop: '16px', gap: '10px' }}
            >
              <span className="text-[12px] text-[var(--ls-text-tertiary)]">
                {lesson.concept_ids.length} concept
                {lesson.concept_ids.length === 1 ? '' : 's'} covered ·{' '}
                {lesson.source_refs.length} source ref
                {lesson.source_refs.length === 1 ? '' : 's'}
              </span>
              {/* 课程深链案 → 课时深链扩展 — this used to be a bare `to="/review"`
                  (landing on All due), then a `?course=` deck preselect.
                  Now `?lesson=` carries the lesson's own id and Review.tsx
                  scopes the queue to exactly this lesson's cards (via
                  lesson.concept_ids → flashcard.concept_id), due first,
                  the rest after — so the jump works even when nothing is
                  due yet. `?course=` still rides along solely to seed the
                  DeckRail accordion open (课程深链案's surviving nicety; the
                  deck preselect itself is suppressed in lesson mode). Any
                  other entry into /review is untouched — All due stays
                  the default landing. */}
              <Link
                to={`/review?lesson=${encodeURIComponent(lesson.id)}&course=${encodeURIComponent(lesson.course_id)}`}
                className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 transition-opacity duration-[var(--ls-duration-fast)]"
                style={{
                  height: '32px',
                  padding: '0 16px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  lineHeight: '1',
                }}
              >
                Review flashcards →
              </Link>
            </div>
          )}
        </div>

        {/* Nav footer */}
        <div
          className="border-t border-[var(--ls-border)]"
          style={{ flexShrink: 0 }}
        >
          <div
            className="flex items-center justify-between"
            style={{ padding: '12px 24px' }}
          >
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(i - 1, 0))}
              disabled={index === 0}
              className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] font-medium hover:bg-[var(--ls-panel)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors duration-[var(--ls-duration-fast)]"
              style={{ height: '30px', padding: '0 14px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
            >
              ← Prev
            </button>
            <span className="text-[11px] text-[var(--ls-text-tertiary)]">
              ← → to navigate
            </span>
            <button
              type="button"
              onClick={() => setIndex((i) => Math.min(i + 1, count - 1))}
              disabled={isLast}
              className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity duration-[var(--ls-duration-fast)]"
              style={{ height: '30px', padding: '0 14px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
            >
              Next →
            </button>
          </div>
          {/* Page dots — direct jump, 页点速跳案 (brief: 想翻到特定页很麻烦) */}
          <PageDots pages={pages} index={clampedIndex} onJump={(i) => setIndex(i)} />
          {/* Progress bar */}
          <div
            style={{
              height: '2px',
              background: 'var(--ls-border)',
              borderBottomLeftRadius: '12px',
              borderBottomRightRadius: '12px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${((index + 1) / count) * 100}%`,
                background: 'var(--ls-text)',
                transition: 'width 180ms cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            />
          </div>
        </div>
      </section>

      {/* 课内笔记栏 (batch B 交付物 4) — only in the normal stacked layout.
          `fillHeight` (classroom/focus mode) promises the pager scrolls
          internally with no outer scrollbar (see PagedLesson's fillHeight
          doc comment); nothing calls PagedLesson with fillHeight today
          (only SelfStudy does, without it), but skip this here rather than
          risk breaking that contract if/when it is. */}
      {!fillHeight && (
        <AnnotationNotesPanel
          annotations={annotations.allAnnotations}
          orphanIds={annotations.orphanIds}
          onJumpToPage={(p) => setIndex(p)}
        />
      )}
    </>
  );
}
