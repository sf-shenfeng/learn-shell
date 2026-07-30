// DocumentReader — 批G 阅读页.
//
// Continuous scroll (documents don't page — lessons do, "两种节奏是设计而非
// 缺口", brief §4), MD 渲染贴 PagedLesson 的排版语言 (PROSE_CLS, exported for
// exactly this reuse). wikilink 一期按纯文本渲 — no plugin parses `[[...]]`,
// standard commonmark already renders it as literal text, so there is
// nothing to add for that. No progress %, no dwell-time tracking (画像军规:
// documents 不是评估表面, brief §4) — contrast with PagedLesson's own
// lesson.viewed recordLearningEvent effect, deliberately NOT ported here.
// (2026-07-30) 例外一枚: `document.viewed`, 只为 Recents 的"最近接触"排序,
// payload 仅 document_id, 无进度/停留时长——上面那条军规不变。
//
// 学习机器换宿主 (brief §5): reuses useAnnotations/AnnotationPill/
// AnnotationOverlay/AnnotationNotesPanel exactly as PagedLesson does, just
// with `host: { kind: 'document', id }` instead of `{ kind: 'lesson', id }`.
// No new highlight/overlay/notes-panel component was written for this batch.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AnnotationId } from '@learn-shell/contracts';
import { useDocumentRepo } from './useDocumentRepo';
import type { DocumentId } from './types';
import { DocRail } from './DocRail';
import { usePair } from '../shell/PairProvider';
import { useT } from '../i18n';
import { useAnnotations } from '../annotation/useAnnotations';
import AnnotationPill from '../annotation/AnnotationPill';
import AnnotationOverlay from '../annotation/AnnotationOverlay';
import AnnotationNotesPanel from '../annotation/AnnotationNotesPanel';
import type { AnnotationHost } from '../annotation/host';
import { PROSE_CLS } from '../lesson/PagedLesson';
import { extractHeadings } from './headings';
import { remarkHeadingIds } from './remarkHeadingIds';
// remarkMark — same inline `==mark==` syntax lessons support
// (apps/web/src/lesson/remarkLsBlocks.ts's remarkMark), reused as-is;
// documents get the same content-author-emphasis affordance without
// pulling in remarkDirective/remarkLsBlocks (the pedagogy-specific
// `:::trial`/`:::cfa-note` directive parsing a pasted research report has
// no use for — brief §4 deviation, noted in the batch report).
import { remarkMark } from '../lesson/remarkLsBlocks';

const MD_COMPONENTS = {
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

/** document.viewed 的防抖窗口 (最近接触, 2026-07-30) — 与 pages/Mindmap.tsx
 *  的同名常量同值同理由, 见下方 effect 的注释。 */
const VIEWED_DEBOUNCE_MS = 700;

const SOURCE_LABEL_KEY = {
  paste: 'document.source.paste',
  upload: 'document.source.upload',
  mcp: 'document.source.mcp',
} as const;

// DocRail collapse — persisted, same precedent as Review.tsx's
// DECK_RAIL_COLLAPSED_KEY (plain read-on-mount + write-on-change; see
// DocRail.tsx / review/DeckRail.tsx for why the *visual* language comes
// from Inspector while the *persistence* mechanic comes from Review).
// Default is collapsed (unlike Review's DeckRail, which defaults expanded)
// — a deliberate reading-measure call: this rail shares the reader's fixed
// 1040px row budget with the existing H2/H3 TOC nav (see the layout comment
// on the return below), so an unvisited-preference reader starts out
// spending none of that budget on it. Only an explicit '0' (user expanded
// it at least once) overrides the collapsed default.
const DOC_RAIL_COLLAPSED_KEY = 'learn-shell:reading-doc-rail-collapsed';
function readDocRailCollapsed(): boolean {
  try {
    return localStorage.getItem(DOC_RAIL_COLLAPSED_KEY) !== '0';
  } catch {
    return true;
  }
}

export default function DocumentReader() {
  const { documentId } = useParams<{ documentId: string }>();
  const repo = useDocumentRepo();
  const { pairId } = usePair();
  const { t } = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const docQ = useQuery({
    queryKey: ['document', documentId],
    queryFn: () =>
      repo && documentId ? repo.getDocument(documentId as DocumentId) : Promise.resolve(null),
    enabled: !!repo && !!documentId,
  });

  // Same query + key DocumentsPage.tsx's list page uses (docsQ there) —
  // reused as-is rather than a new fetch, so the rail's data is already
  // warm from cache when navigating in from the list, and any create/
  // delete elsewhere that invalidates ['documents', pairId] refreshes
  // this rail too for free.
  const docsQ = useQuery({
    queryKey: ['documents', pairId],
    queryFn: () => (repo && pairId ? repo.getDocuments(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });

  const [editing, setEditing] = useState(false);
  const [contentDraft, setContentDraft] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [docRailCollapsed, setDocRailCollapsed] = useState<boolean>(() =>
    readDocRailCollapsed()
  );
  useEffect(() => {
    try {
      localStorage.setItem(DOC_RAIL_COLLAPSED_KEY, docRailCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [docRailCollapsed]);

  const doc = docQ.data;
  const documents = docsQ.data ?? [];

  const updateMut = useMutation({
    mutationFn: (content_md: string) => {
      if (!repo || !doc) throw new Error('no repo/document');
      return repo.updateDocument(doc.id, { content_md });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document', documentId] });
      // 批G resweep (brief §3 item 3): a content change re-anchors this
      // document's annotations server-side — refresh the reader's own
      // annotation query (host-scoped key, see useAnnotations.ts's
      // annotationsQueryKey) plus the journal fan-out that also reads them,
      // so both surfaces show the post-sweep orphan/resolved state.
      if (doc) {
        qc.invalidateQueries({ queryKey: ['annotations', 'document', doc.id] });
        qc.invalidateQueries({ queryKey: ['journal-doc-annotations', doc.id] });
      }
      // Keeps the list page's updated_at / sort order fresh too.
      qc.invalidateQueries({ queryKey: ['documents', pairId] });
      qc.invalidateQueries({ queryKey: ['recent-rail', 'documents', pairId] });
      setEditing(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => {
      if (!repo || !doc) throw new Error('no repo/document');
      return repo.deleteDocument(doc.id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['documents', pairId] });
      qc.invalidateQueries({ queryKey: ['journal-documents', pairId] });
      qc.invalidateQueries({ queryKey: ['recent-rail', 'documents', pairId] });
      navigate('/documents');
    },
  });

  // document.viewed 已读信号 (Recents 最近接触, 2026-07-30) — 文档取到之后
  // fire 一次, 每次进入这份文档只发一枚 (ref 按 document_id 去重, StrictMode
  // 的双跑挡在同一个 ref 上; 换文档/再次导航进来会重新发, 因为"又读了一次"
  // 本来就该把它顶到最前)。fire-and-forget: 失败只吞不弹, 阅读不被埋点打扰。
  // 头注那句"不记进度%/停留时长"依然成立——这枚事件只回答"最近读的是哪一
  // 份", 不带任何阅读深度字段, documents 仍不是评估表面。
  // 防抖 VIEWED_DEBOUNCE_MS: 也是等 PairProvider 把 pair 解析完 —— 它开机先
  // 给一个占位 pair (SEEDED_PAIR_ID), 抢在解析前发会打到一个本机不存在的
  // pair。发失败把去重标记退回去, 下一次依赖变化(pair 落定)自己重试。
  const viewedFiredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!repo || !pairId || !doc) return;
    if (viewedFiredForRef.current === doc.id) return;
    const documentId = doc.id;
    const timer = window.setTimeout(() => {
      viewedFiredForRef.current = documentId;
      repo
        .recordLearningEvent({
          pair_id: pairId,
          event_type: 'document.viewed',
          mode: 'self_study',
          payload: { document_id: documentId },
        })
        .then(() => {
          qc.invalidateQueries({ queryKey: ['recent-rail', 'documents', pairId] });
        })
        .catch(() => {
          if (viewedFiredForRef.current === documentId) viewedFiredForRef.current = null;
        });
    }, VIEWED_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [repo, pairId, doc, qc]);

  const headings = useMemo(() => (doc ? extractHeadings(doc.content_md) : []), [doc]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-markdown
  // doesn't re-export unified's PluggableList type (same call PagedLesson.tsx's
  // own remarkPlugins useMemo makes for its [plugin, options] tuple form).
  const remarkPlugins = useMemo(
    () => [remarkGfm, [remarkHeadingIds, headings], remarkMark] as any[],
    [headings]
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const host = useMemo<AnnotationHost | null>(
    () => (doc ? { kind: 'document', id: doc.id } : null),
    [doc]
  );
  const annotations = useAnnotations(
    containerRef,
    host ?? { kind: 'document', id: '' as DocumentId },
    0,
    pairId
  );

  const [activeAnnotationId, setActiveAnnotationId] = useState<AnnotationId | null>(null);
  const [overlayPos, setOverlayPos] = useState<{ left: number; top: number } | null>(null);
  // 批注计数同步案②: bottom "My notes/highlights" list → scroll-to-highlight
  // return path. `scrollToAnnotation` returns false when the anchor didn't
  // resolve (orphaned — the document was edited since) — graceful
  // degradation per brief: scroll to top + a brief inline notice, never a
  // silent no-op. Same toast dialect as pages/Cards.tsx's import summary
  // (role="status", fixed bottom-center pill), shorter-lived since this is
  // a lighter-weight notice than an import report.
  const [jumpOrphanHint, setJumpOrphanHint] = useState(false);
  useEffect(() => {
    if (!jumpOrphanHint) return;
    const id = window.setTimeout(() => setJumpOrphanHint(false), 3000);
    return () => window.clearTimeout(id);
  }, [jumpOrphanHint]);
  const activeAnnotation =
    activeAnnotationId != null
      ? (annotations.allAnnotations.find((a) => a.id === activeAnnotationId) ?? null)
      : null;

  useEffect(() => {
    setActiveAnnotationId(null);
  }, [doc?.id]);

  useEffect(() => {
    if (!activeAnnotationId) return;
    const onMouseDown = () => setActiveAnnotationId(null);
    const onKeyDown = (e: KeyboardEvent) => {
      const t2 = e.target as HTMLElement | null;
      if (t2 && (t2.tagName === 'INPUT' || t2.tagName === 'TEXTAREA' || t2.isContentEditable)) return;
      if (e.key === 'Escape') setActiveAnnotationId(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activeAnnotationId]);

  if (!repo) {
    return <p className="text-sm text-[var(--ls-text-secondary)]">{t('document.emptyMode')}</p>;
  }
  if (docQ.isLoading) {
    return <p className="text-sm text-[var(--ls-text-tertiary)]">{t('document.loading')}</p>;
  }
  if (!doc || !host) {
    return <p className="text-sm text-[var(--ls-text-secondary)]">{t('document.notFound')}</p>;
  }

  return (
    // Page-level row: prose column (flex-1 min-w-0, PROSE_CLS's own 65ch
    // measure still caps the running text — see PagedLesson.tsx's PROSE_CLS
    // comment) beside the sticky DocRail, same "content column + flex-none
    // sticky rail" shape Review.tsx's outer flex row uses for DeckRail.
    // DocRail collapses to a 40px rail (default state, see
    // readDocRailCollapsed) precisely so this new column doesn't steal
    // reading measure from the existing H2/H3 TOC nav further in — both
    // rails share the row's fixed 1040px budget (AppShell's
    // isDocumentReaderRoute widening), and 40px really does leave the TOC +
    // prose comfortably as-is; only an explicit expand click trades some of
    // that measure for the document list.
    <div className="flex" style={{ gap: '20px', alignItems: 'flex-start' }}>
    <article className="flex-1 min-w-0">
      <header
        className="flex items-start justify-between flex-wrap"
        style={{ marginBottom: '24px', gap: '14px' }}
      >
        <div>
          <div className="text-[11px] tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)] font-medium">
            {t(SOURCE_LABEL_KEY[doc.source])}
          </div>
          <h1
            className="font-bold text-[26px] leading-[34px] tracking-[-0.02em]"
            style={{ marginTop: '4px' }}
          >
            {doc.title}
          </h1>
        </div>
        <div className="flex items-center" style={{ gap: '8px', marginTop: '4px' }}>
          <button
            type="button"
            onClick={() => {
              setContentDraft(doc.content_md);
              setEditing((v) => !v);
            }}
            className="inline-flex items-center border border-[var(--ls-border-strong)] text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)] font-medium transition-colors duration-[var(--ls-duration-fast)]"
            style={{ height: '30px', padding: '0 14px', borderRadius: '999px', fontSize: '12px' }}
          >
            {editing ? t('document.cancelEdit') : t('document.editContent')}
          </button>
          {confirmingDelete ? (
            <span className="inline-flex items-center" style={{ gap: '8px' }}>
              <button
                type="button"
                onClick={() => deleteMut.mutate()}
                disabled={deleteMut.isPending}
                className="text-[12px] font-medium disabled:opacity-40"
                style={{ color: 'var(--ls-risk)' }}
              >
                {t('annotation.confirmDelete')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="text-[12px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
              >
                {t('annotation.cancel')}
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="text-[12px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-risk)]"
            >
              {t('document.delete')}
            </button>
          )}
        </div>
      </header>

      {editing ? (
        <div className="flex flex-col" style={{ gap: '10px' }}>
          <textarea
            autoFocus
            value={contentDraft}
            onChange={(e) => setContentDraft(e.target.value)}
            rows={20}
            className="w-full font-mono text-[13px] leading-6 border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] focus:outline-none focus:border-[var(--ls-border-strong)] resize-y"
            style={{ padding: '14px 16px', borderRadius: '10px' }}
          />
          <div className="text-[11px] text-[var(--ls-text-tertiary)]">
            {t('document.resweepHint')}
          </div>
          <div className="flex items-center" style={{ gap: '10px' }}>
            <button
              type="button"
              onClick={() => updateMut.mutate(contentDraft)}
              disabled={!contentDraft.trim() || updateMut.isPending}
              className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium disabled:opacity-40"
              style={{ height: '32px', padding: '0 16px', borderRadius: '6px', fontSize: '12px' }}
            >
              {updateMut.isPending ? t('document.saving') : t('document.saveContent')}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-[12px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
            >
              {t('annotation.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start" style={{ gap: '32px' }}>
          <div className="flex-1 min-w-0">
            {/* AnnotationPill/Overlay are siblings of containerRef, NOT
                descendants — same tree shape PagedLesson's Pager uses (its
                own pill/overlay sit beside pageBodyRef, not inside it).
                Both float via position:fixed so this doesn't move them
                visually, but it matters functionally: useAnnotations'
                mouseup capture and this div's own onClick hit-test both key
                off "is this inside containerRef" — a click/selection made
                *inside* the pill's textarea or the overlay's buttons must
                never register as a fresh capture or a stray dismiss. */}
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
                host={host}
                pairId={pairId}
                hostTitle={doc.title}
                onClose={() => setActiveAnnotationId(null)}
              />
            )}
            <style>{`
              .ls-doc-content :is(h2, h3) { scroll-margin-top: 88px; }
              /* Theme-aware link color — react-markdown's plain <a> only gets
               * Tailwind Typography's default --tw-prose-links (a fixed dark
               * slate, same value regardless of [data-theme]), which reads as
               * near-invisible dark blue against the dark theme's black
               * --ls-bg. --ls-link is tuned per-theme (light.css/dark.css)
               * for ≥4.5:1 against --ls-bg in both modes. Scoped to reader
               * content only — not a global <a> restyle. */
              .ls-doc-content a {
                color: var(--ls-link);
                transition: opacity var(--ls-duration-fast) var(--ls-easing);
              }
              .ls-doc-content a:hover { opacity: 0.8; }
              /* Fenced + inline code: Typography's defaults hardcode
               * slate-800 bg / slate-200 text for <pre> (and inherit for
               * <pre code>) regardless of theme — a saturated dark-blue slab
               * that clashes with both themes. Rebuilt on the panel/border
               * token pair so it reads as "one layer up" from the reading
               * background, same language as textarea/panel surfaces
               * elsewhere in the app. Inline <code> already sits on
               * --ls-panel via PROSE_CLS's prose-code utilities (PagedLesson
               * .tsx); this only adds the matching border so both forms look
               * like one family. pre code's own Typography rule
               * (background-color: transparent; border-width: 0) has higher
               * selector specificity than this plain "code", so the border
               * added here cleanly no-ops for code nested in pre. */
              .ls-doc-content code {
                border: 1px solid var(--ls-border);
              }
              .ls-doc-content pre {
                background: var(--ls-panel);
                border: 1px solid var(--ls-border);
                border-radius: var(--ls-radius-panel);
                color: var(--ls-text);
              }
            `}</style>
            <div
              ref={containerRef}
              onClick={(e) => {
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
              <div className={`${PROSE_CLS} ls-doc-content mx-auto`}>
                <ReactMarkdown remarkPlugins={remarkPlugins} components={MD_COMPONENTS}>
                  {doc.content_md}
                </ReactMarkdown>
              </div>
            </div>
          </div>

          {headings.length > 0 && (
            <nav
              className="hidden lg:flex flex-col flex-none sticky"
              style={{
                top: '20px',
                width: '190px',
                gap: '2px',
                maxHeight: 'calc(100vh - 60px)',
                overflowY: 'auto',
              }}
            >
              <div
                className="text-[11px] font-medium tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)]"
                style={{ marginBottom: '6px' }}
              >
                {t('document.toc.heading')}
              </div>
              {headings.map((h) => (
                <a
                  key={h.slug}
                  href={`#${h.slug}`}
                  className="text-[12px] leading-5 text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)] truncate"
                  style={{ paddingLeft: h.level === 3 ? '12px' : '0' }}
                >
                  {h.text}
                </a>
              ))}
            </nav>
          )}
        </div>
      )}

      {!editing && (
        <AnnotationNotesPanel
          annotations={annotations.allAnnotations}
          orphanIds={annotations.orphanIds}
          onJumpToPage={(_pageIndex, annotationId) => {
            // Documents don't page (brief §4) — the return path is a scroll
            // to the resolved highlight, not a page flip.
            const scrolled = annotations.scrollToAnnotation(annotationId);
            if (!scrolled) {
              window.scrollTo({ top: 0, behavior: 'smooth' });
              setJumpOrphanHint(true);
            }
          }}
          showPageLabel={false}
        />
      )}
    </article>
    <DocRail
      documents={documents}
      currentId={doc.id}
      collapsed={docRailCollapsed}
      onToggleCollapse={() => setDocRailCollapsed((v) => !v)}
      onSelect={(id) => navigate(`/documents/${id}`)}
    />
    {jumpOrphanHint && (
      <div
        role="status"
        style={{
          position: 'fixed',
          bottom: '24px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'var(--ls-text)',
          color: 'var(--ls-bg)',
          padding: '10px 18px',
          borderRadius: '8px',
          fontSize: '13px',
          fontWeight: 500,
          zIndex: 60,
          boxShadow: '0 12px 28px -8px rgba(0,0,0,0.35)',
          maxWidth: '440px',
          textAlign: 'center',
        }}
      >
        {t('document.jumpOrphanHint')}
      </div>
    )}
    </div>
  );
}
