// AnnotationNotesPanel — 课内笔记栏
// (呈现面 2, batch B 交付物 4). Every annotation for this lesson (all pages),
// in a collapsible section — reuses Cards.tsx's existing group-header
// dialect (▾/▸ chevron + label + count, apps/web/src/pages/Cards.tsx
// ~line 667) rather than inventing a new one.
//
// Orphan flag (待重新安放, 永不丢行原则):
// only trustworthy for whichever page is *currently mounted* — PagedLesson
// renders one page at a time, so useAnnotations can only resolve-against-
// DOM the page that's actually on screen right now. Annotations belonging
// to other pages show here with no verdict until you visit that page and
// its resolve pass runs. A full cross-page orphan census (so this panel
// could flag *every* orphan without visiting every page first) is Journal's
// 孤儿区 job (batch D, brief §4) — 服从现实条款: half-solving it here with a
// text-only heuristic (matching selected_text against raw page markdown,
// skipping real DOM resolution) would risk false positives against
// rendered-vs-source text differences (markdown syntax vs. rendered
// prose), which is worse than an honest "not checked yet". Flagged in the
// batch B report for 发包人 to weigh against batch D's scope.

import { useState } from 'react';
import type { AnnotationId } from '@learn-shell/contracts';
import { useT } from '../i18n';
import { annotationColorHex } from './palette';
import type { LessonAnnotationWithOrphan } from './orphan';

export default function AnnotationNotesPanel({
  annotations,
  orphanIds,
  onJumpToPage,
  showPageLabel = true,
}: {
  annotations: LessonAnnotationWithOrphan[];
  orphanIds: Set<AnnotationId>;
  /** 批注计数同步案②: now also passes the clicked row's own annotation id — the
   *  bottom "My notes/highlights" list's return path to the actual painted
   *  highlight in the prose (documents: `useAnnotations().scrollToAnnotation`,
   *  brief §4 continuous scroll has no real "page" to jump to; lessons keep
   *  using only the first arg to flip pages, unchanged from before this
   *  change — a callback that reads fewer params than declared is a valid
   *  JS/TS call, no lesson-side edit needed). */
  onJumpToPage: (pageIndex: number, annotationId: AnnotationId) => void;
  /** 批G: documents don't page (continuous scroll, brief §4) — document
   *  hosts pass false to hide the "Page N" line, since every row's
   *  page_index is a meaningless always-0 there. Default true keeps the
   *  lesson call site unchanged. */
  showPageLabel?: boolean;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);

  if (annotations.length === 0) return null;

  return (
    <div
      className="border border-[var(--ls-border)] bg-[var(--ls-bg)]"
      style={{ borderRadius: '10px', marginTop: '16px' }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center w-full text-left cursor-pointer"
        style={{ gap: '10px', padding: '12px 16px' }}
      >
        <span className="text-[var(--ls-text-tertiary)]" style={{ fontSize: '11px', width: '10px' }}>
          {expanded ? '▾' : '▸'}
        </span>
        <span className="font-semibold" style={{ fontSize: '13px' }}>
          {t('annotation.myHighlights')}
        </span>
        <span className="text-[var(--ls-text-tertiary)]" style={{ fontSize: '12px' }}>
          {annotations.length}
        </span>
      </button>

      {expanded && (
        <div
          className="border-t border-[var(--ls-border)]"
          style={{ padding: '6px 8px 8px', display: 'flex', flexDirection: 'column', gap: '2px' }}
        >
          {annotations.map((a) => {
            const isOrphan = orphanIds.has(a.id);
            const excerpt =
              a.selected_text.length > 80 ? a.selected_text.slice(0, 77) + '…' : a.selected_text;
            const noteFirstLine = a.note?.split('\n')[0]?.trim();
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onJumpToPage(a.page_index, a.id)}
                className="flex items-start w-full text-left hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
                style={{ gap: '10px', padding: '8px', borderRadius: '6px' }}
              >
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    marginTop: '5px',
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: annotationColorHex(a.color),
                  }}
                />
                <span className="flex flex-col" style={{ gap: '2px', minWidth: 0 }}>
                  <span
                    className="text-[13px] leading-[19px] text-[var(--ls-text)]"
                    style={{ overflowWrap: 'break-word' }}
                  >
                    “{excerpt}”
                  </span>
                  {noteFirstLine && (
                    <span
                      className="text-[12px] leading-[17px] text-[var(--ls-text-secondary)]"
                      style={{ overflowWrap: 'break-word' }}
                    >
                      {noteFirstLine}
                    </span>
                  )}
                  <span
                    className="text-[10px] uppercase tracking-[0.05em] text-[var(--ls-text-tertiary)]"
                    style={{ marginTop: '2px' }}
                  >
                    {showPageLabel && `Page ${a.page_index + 1}`}
                    {isOrphan && (
                      <span style={{ color: 'var(--ls-risk)', marginLeft: showPageLabel ? '8px' : '0' }}>
                        {t('annotation.awaitingReanchor')}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
