// Annotation — 正编 hook (batch A).
// Replaces the spike end to end:
// same anchor.ts serialize/resolve pure functions and CSS Custom Highlight
// API rendering, now backed by the real REST CRUD (`lesson_annotations` via
// the Repository) instead of localStorage. No flag guard — this is the
//正式功能, not a demo.
//
// Capture: mouseup inside the page container → serializeRange → createAnnotation
// (React Query mutation) → invalidate the host's annotation query.
// Render: GET annotations for the host (React Query), filtered to this
// page, resolved against the *current* DOM, painted via CSS.highlights.
// Anchors that fail to resolve are orphans (永不丢行原则 — brief §1): the record
// is never dropped, just not painted this render. The orphan count is
// console.warn'd; a proper 待重新安放 list is batch D's Journal page, not
// this hook's job.
//
// 批G ("学习机器换宿主"): generalized from
// a hardcoded `lessonId` param to `host: AnnotationHost` (./host.ts) —
// everything else (capture, paint, hit-test, pending lifecycle) is
// unchanged, only the two repo calls that need to know which table a row
// belongs to (list + create) branch on `host.kind`.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnnotationId, PairId, Repository } from '@learn-shell/contracts';
import { useRepository } from '../repository';
import type { DocumentRepo } from '../repository/documentExt';
import { serializeRange, resolveAnchor, type AnnotationAnchor } from './anchor';
import { ANNOTATION_COLORS, annotationHighlightName } from './palette';
import { journalHostQueryKey, type AnnotationHost } from './host';
import { withOrphanField, type LessonAnnotationWithOrphan } from './orphan';

/** React Query key for one host's annotation list — shared by every call
 *  site that reads or invalidates it (this hook, AnnotationOverlay.tsx). */
export function annotationsQueryKey(host: AnnotationHost): [string, string, string] {
  return ['annotations', host.kind, host.id];
}

let styleInjected = false;
function ensureHighlightStyle(): void {
  if (styleInjected || typeof document === 'undefined') return;
  styleInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-ls-annotation', '');
  // 隐身术红线 (brief §6, both batches): content-layer wash, not chrome. No
  // dedicated --ls annotation-highlight token exists — the closest
  // candidate, --ls-hyp-tint, is already claimed by the `==mark==`
  // content-author highlight semantic in PagedLesson's MD_COMPONENTS;
  // reusing it here would blur "content author's emphasis" with "learner's
  // highlight". Batch B (交付物 3): one ::highlight rule per Mindmap-palette
  // color, background derived as a color-mix wash off each hex — 45% mix
  // keeps continuity with the batch-A spike's own tuned single-color value
  // (rgba(255, 209, 92, 0.45) on amber) rather than inventing a fresh ratio,
  // just parameterized across all five keys instead of hardcoded to one.
  style.textContent = ANNOTATION_COLORS.map(
    ({ key, hex }) =>
      `::highlight(${annotationHighlightName(key)}) { background-color: color-mix(in srgb, ${hex} 45%, transparent); }`
  ).join('\n');
  document.head.appendChild(style);
}

const HIGHLIGHT_SUPPORTED =
  typeof window !== 'undefined' &&
  typeof Highlight !== 'undefined' &&
  typeof CSS !== 'undefined' &&
  !!CSS.highlights;

/** True when two same-document Ranges overlap (a.start < b.end && a.end >
 *  b.start — merely touching at a boundary doesn't count). Used to decline
 *  staging a selection over an already-painted annotation (既有批注上再选修复:
 *  overlapping records stack their translucent washes into mixed colors,
 *  so overlap is banned at the entrance — same semantics as the
 *  interactive-block exclusion: the pill simply never appears; edit the
 *  existing highlight by clicking it instead). try/catch because
 *  compareBoundaryPoints throws WrongDocumentError if a stored range's
 *  nodes were detached by a re-render between paint and mouseup — treat
 *  that as "no overlap", the stale range is no longer on screen. */
function rangesIntersect(a: Range, b: Range): boolean {
  try {
    return (
      a.compareBoundaryPoints(Range.END_TO_START, b) < 0 &&
      a.compareBoundaryPoints(Range.START_TO_END, b) > 0
    );
  } catch {
    return false;
  }
}

/** A captured-but-unconfirmed selection: the pill's reason to exist. */
export interface PendingSelection {
  anchor: AnnotationAnchor;
  /** Viewport coords for the pill (fixed positioning). */
  left: number;
  top: number;
}

export interface UseAnnotationsResult {
  /** Non-null while a selection awaits confirmation. */
  pending: PendingSelection | null;
  /** Persist the pending selection as an annotation. Bare `confirm()` (the
   *  `H` keyboard path) omits color/note — server/mock default to amber,
   *  pure highlight, unchanged from batch A. The pill's color dots and
   *  note-save button pass `color`/`note` explicitly (batch B 交付物 1). */
  confirm: (opts?: { color?: string; note?: string | null }) => void;
  /** Drop the pending selection without creating anything. */
  dismiss: () => void;
  /** All annotations for this host, every page, created_at asc — the
   *  Notes panel's data source (batch B 交付物 4). Reuses the same query
   *  this hook already runs to resolve+paint the current page, so exposing
   *  it here avoids a second fetch. */
  allAnnotations: LessonAnnotationWithOrphan[];
  /** IDs that failed to resolve against the *current* page's live DOM on
   *  this render. Only ever reflects the page actually mounted right now —
   *  PagedLesson renders one page at a time, so annotations on other pages
   *  have no verdict here (待重新安放 as a cross-page census belongs to
   *  Journal's 孤儿区, batch D, brief §4). */
  orphanIds: Set<AnnotationId>;
  /** Hit-test a viewport point (e.g. a click's clientX/clientY) against the
   *  current page's resolved annotation ranges. Bounding-rect containment;
   *  smallest-area rect wins when ranges overlap. Null when the point
   *  misses every highlight — batch B 交付物 2's "点击命中" (brief picks the
   *  simpler of the two suggested approaches: coordinate hit-testing over
   *  resolved Ranges, since CSS Custom Highlight API paints without giving
   *  per-highlight DOM nodes to attach click handlers to). */
  hitTest: (clientX: number, clientY: number) => AnnotationId | null;
  /** 批注计数同步案②: scroll the current page's DOM to a resolved annotation's
   *  Range and paint a brief flash emphasis on it — the return path for
   *  AnnotationNotesPanel's list (bottom-of-doc "My notes/highlights")
   *  entries, whose click previously only jumped `page_index` (a no-op
   *  for documents, brief §4 continuous scroll) with no actual scroll-to-
   *  highlight. Returns false when `id` isn't in this render's resolved
   *  set — orphaned, or (for lessons) on a page other than the one
   *  currently mounted — so the caller can degrade gracefully (brief:
   *  "滚到文档顶部并轻提示，不许静默无反应") instead of silently doing
   *  nothing. */
  scrollToAnnotation: (id: AnnotationId) => boolean;
}

/** Dedicated CSS Custom Highlight registration for scrollToAnnotation's
 *  momentary emphasis — separate from the ANNOTATION_COLORS washes
 *  (palette.ts/ensureHighlightStyle above) so the flash never collides with
 *  a learner's actual highlight color. Reuses `--ls-hyp-tint` rather than
 *  inventing a new token: that candidate was ruled out above (line ~48) for
 *  the *persistent* per-color washes specifically to avoid blurring
 *  "content author's ==mark==" with "learner's highlight" — neither
 *  objection applies to a ~1.5s one-shot "look here" flash, which is
 *  exactly the same transient "arrived here" role Settings.tsx's
 *  CertificateCard/ArchiveRow `highlighted` state already gives this same
 *  token (apps/web/src/pages/Settings.tsx's useHighlightScroll/HIGHLIGHT_MS).
 *  `priority` is bumped above the default (0) so the flash visibly wins over
 *  whichever persistent color wash already occupies the same Range while
 *  both are registered. */
const FLASH_HIGHLIGHT_NAME = 'ls-annotation-jump-flash';
const FLASH_MS = 1500; // same order as the house "copied/saved" flash timers
// (Settings.tsx SAVED_FLASH_MS/Shortcuts.tsx's 1500ms reset) — not a new cadence.
let flashStyleInjected = false;
function ensureFlashHighlightStyle(): void {
  if (flashStyleInjected || typeof document === 'undefined') return;
  flashStyleInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-ls-annotation-flash', '');
  style.textContent = `::highlight(${FLASH_HIGHLIGHT_NAME}) { background-color: var(--ls-hyp-tint); }`;
  document.head.appendChild(style);
}

/**
 * Wires one paged-lesson page's body container to the annotation system.
 *
 * Capture is deliberately two-step (2026-07-06 定案: "选中即划"会把每一次
 * 复制都变成永久划线): mouseup → anchor → `pending`; the caller renders a
 * small pill and only `confirm()` (click or `H`) actually persists. Escape,
 * clicking elsewhere, scrolling, or making a new selection dismisses.
 * Right-click is left alone on purpose — the native context menu's
 * copy/look-up/search matter in a reading surface.
 *
 * Render: GET annotations → resolve → CSS Highlight paint. `pairId` may be
 * null (no active pair resolved yet) — capture is a no-op until it's
 * available; render still proceeds off whatever the query already has
 * cached.
 */
export function useAnnotations(
  containerRef: RefObject<HTMLElement | null>,
  host: AnnotationHost,
  pageIndex: number,
  pairId: PairId | null
): UseAnnotationsResult {
  // Cast, not a new hook — 批G narrows the same way journal/useJournalNotes.ts's
  // useJournalRepo() does: concrete repos (Mock/Http) implement every
  // extension interface, this just names the slice this hook needs.
  const repo = useRepository() as (Repository & DocumentRepo) | null;
  const qc = useQueryClient();
  const lessonId = host.kind === 'lesson' ? host.id : null;
  const documentId = host.kind === 'document' ? host.id : null;
  const liveSessionId = host.kind === 'live' ? host.id : null;

  const annotationsQ = useQuery({
    queryKey: annotationsQueryKey(host),
    queryFn: async (): Promise<LessonAnnotationWithOrphan[]> => {
      if (!repo) return [];
      // withOrphanField: the lesson/live branches' static return type is
      // contracts' narrower `LessonAnnotation[]` (orphaned_at not in that
      // shape) — the wire payload carries it regardless (batch D), same cast
      // orphan.ts's own helper documents. Document branch is already typed
      // with orphan fields (DocumentRepo), no cast needed there.
      if (lessonId) return withOrphanField(await repo.getAnnotationsForLesson(lessonId));
      if (liveSessionId)
        return withOrphanField(await repo.getAnnotationsForLiveSession(liveSessionId));
      return await repo.getAnnotationsForDocument(documentId!);
    },
    // !!host.id guards the DocumentReader call site, which must call this
    // hook unconditionally (rules of hooks) even before its document has
    // loaded — it passes a placeholder host with an empty id in that gap;
    // this keeps that placeholder from firing a bogus fetch.
    enabled: !!repo && !!host.id,
  });

  const createMut = useMutation({
    mutationFn: async (input: {
      page_index: number;
      selected_text: string;
      prefix: string;
      suffix: string;
      color?: string;
      note?: string | null;
    }): Promise<LessonAnnotationWithOrphan> => {
      if (!repo || !pairId) throw new Error('no repo/pair');
      if (lessonId) {
        // Cast: same withOrphanField reasoning as the read side above —
        // contracts' createAnnotation return type is the narrower
        // LessonAnnotation, the wire payload has orphaned_at regardless.
        const row = await repo.createAnnotation({ pair_id: pairId, lesson_id: lessonId, ...input });
        return row as unknown as LessonAnnotationWithOrphan;
      }
      if (liveSessionId) {
        // Live host: page_index here is the anchored move's seq (set by the
        // capture branch below) — same narrow-return cast as the lesson path.
        const row = await repo.createLiveSessionAnnotation({
          pair_id: pairId,
          live_session_id: liveSessionId,
          ...input,
        });
        return row as unknown as LessonAnnotationWithOrphan;
      }
      // Documents don't page (brief §4) — page_index is captured by the
      // caller for parity with the lesson path but dropped here; the server
      // always writes 0 for document-hosted rows.
      const { page_index: _pageIndex, ...rest } = input;
      void _pageIndex;
      return repo.createDocumentAnnotation({ pair_id: pairId, document_id: documentId!, ...rest });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: annotationsQueryKey(host) });
      // 轻量计数案: RecentRail's "笔记" row now reads a dedicated count query
      // (['notes-count', pairId]) instead of piggybacking on this key.
      qc.invalidateQueries({ queryKey: ['notes-count', pairId] });
      // 批注计数同步案①: Journal drawer's own per-host key — see host.ts's
      // journalHostQueryKey doc comment for why this was missing and what it
      // broke (30s of stale drawer contents after a fresh highlight).
      qc.invalidateQueries({ queryKey: journalHostQueryKey(host) });
    },
    onError: (e) => console.error('[annotation.create]', e),
  });
  const { mutate: createAnnotation } = createMut;

  const [pending, setPending] = useState<PendingSelection | null>(null);

  // resolved: kept in a ref, not state — DOM-derived bookkeeping consumed at
  // event time (hitTest's click lookup, capture's overlap ban 既有批注上再选修复), never
  // rendered directly, so a ref avoids a render per resolve pass. Written by
  // the paint effect below; declared up here because the capture effect's
  // mouseup handler reads it.
  const resolvedRef = useRef<{ id: AnnotationId; range: Range }[]>([]);

  const dismiss = useCallback(() => setPending(null), []);

  // 笔记重复生成报障 (7/6 实机报障): this used to run
  // createAnnotation *inside* the setPending updater. React StrictMode (on
  // in main.tsx) double-invokes updater functions in dev to surface exactly
  // this impurity — so every confirm fired the POST twice, and the DB grew
  // twin records ~13ms apart (forensics: ann_mr8qykw5/ann_mr8qykwi created
  // 45.989/46.002, ann_mr8r0v81/ann_mr8r0v8e created 32.689/32.702). The
  // side effect now lives in the callback body, which runs once per call;
  // `pending` moves from updater argument to a plain dependency (the
  // keydown-listener effect below already re-subscribes on [pending, …], so
  // confirm's identity changing with pending costs nothing). Re-entry is
  // safe: the first call nulls `pending`, so a second call no-ops.
  const confirm = useCallback(
    (opts?: { color?: string; note?: string | null }) => {
      if (!pending) return;
      createAnnotation({
        page_index: pending.anchor.pageIndex,
        selected_text: pending.anchor.selectedText,
        prefix: pending.anchor.prefix,
        suffix: pending.anchor.suffix,
        color: opts?.color,
        note: opts?.note,
      });
      window.getSelection()?.removeAllRanges();
      setPending(null);
    },
    [pending, createAnnotation]
  );

  // Capture: mouseup inside the page container → serialize → stage as pending.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !repo || !pairId) return;

    const onMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return;
      // 既有批注上再选修复: a selection that overlaps any already-painted annotation
      // on this page is declined outright — no pill. Stacked 45% washes
      // blend into mud (and made the duplicate-record path attractive: the
      // natural "re-select the same text to annotate it again" gesture).
      // Editing an existing highlight is the click→overlay path instead.
      for (const { range: existing } of resolvedRef.current) {
        if (rangesIntersect(range, existing)) return;
      }
      // Live host (第三种宿主, 2026-07-18): anchors live inside ONE move's
      // prose — the serialize root is that move's `data-ls-live-move-seq`
      // element, and page_index becomes its seq (server-side 约定,
      // routes/annotations.ts). A selection outside any move's prose, or
      // spanning two moves (its common ancestor then sits ABOVE both marked
      // elements, so closest() finds none), is declined silently — same
      // "decline, don't guess" posture as every other capture gate here.
      let anchorRoot: Element = root;
      let anchorPageIndex = pageIndex;
      if (host.kind === 'live') {
        const cac = range.commonAncestorContainer;
        const cacEl =
          cac.nodeType === Node.ELEMENT_NODE ? (cac as Element) : cac.parentElement;
        const moveEl = cacEl?.closest('[data-ls-live-move-seq]') ?? null;
        if (!moveEl || !root.contains(moveEl)) return;
        const seq = Number(moveEl.getAttribute('data-ls-live-move-seq'));
        if (!Number.isFinite(seq)) return;
        anchorRoot = moveEl;
        anchorPageIndex = seq;
      }
      const anchor = serializeRange(range, anchorRoot, anchorPageIndex);
      if (!anchor) return; // empty / excluded-region selection — decline silently
      const rect = range.getBoundingClientRect();
      setPending({ anchor, left: rect.left + rect.width / 2, top: rect.top });
    };
    root.addEventListener('mouseup', onMouseUp);
    return () => root.removeEventListener('mouseup', onMouseUp);
  }, [containerRef, repo, pairId, host.kind, host.id, pageIndex]);

  // Pending lifecycle: H confirms, Escape dismisses, clicking elsewhere or
  // scrolling dismisses. The pill itself preventDefault+stopPropagation on
  // mousedown (see AnnotationPill) so it never triggers the dismiss path.
  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        confirm();
      } else if (e.key === 'Escape') {
        dismiss();
      }
    };
    const onMouseDown = () => dismiss();
    const onScroll = () => dismiss();
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [pending, confirm, dismiss]);

  // Page navigation / lesson (or document) switch: stale pending must not survive.
  useEffect(() => {
    setPending(null);
  }, [host.kind, host.id, pageIndex]);

  // Render: resolve every stored anchor for this page against the current
  // DOM and paint the survivors. Live host: the history stream mounts ALL
  // moves at once (no paging), so nothing is filtered out here — each
  // record instead resolves against its own move's element in the paint
  // pass below (page_index = move seq, see capture above).
  const isLiveHost = host.kind === 'live';
  const pageAnnotations = useMemo(
    () =>
      (annotationsQ.data ?? []).filter(
        (rec) => isLiveHost || rec.page_index === pageIndex
      ),
    [annotationsQ.data, pageIndex, isLiveHost]
  );

  const [orphanIds, setOrphanIds] = useState<Set<AnnotationId>>(() => new Set());

  useEffect(() => {
    const root = containerRef.current;
    if (!root || !HIGHLIGHT_SUPPORTED) {
      resolvedRef.current = [];
      return;
    }
    ensureHighlightStyle();

    const resolved: { id: AnnotationId; range: Range }[] = [];
    const orphans = new Set<AnnotationId>();
    // batch B 交付物 3: bucket resolved ranges by color so each Mindmap-
    // palette color paints through its own ::highlight registration.
    const byColor = new Map<string, Range[]>();

    for (const rec of pageAnnotations) {
      // Live host: resolve inside the record's own move element (scoping the
      // quote search to one move both honors the anchoring convention and
      // avoids cross-move false matches on short quotes). Missing move
      // element (seq not rendered — shouldn't happen for a completed
      // session's full stream) reads as an orphan, never a guess.
      const resolveRoot = isLiveHost
        ? root.querySelector(`[data-ls-live-move-seq="${rec.page_index}"]`)
        : root;
      if (!resolveRoot) {
        orphans.add(rec.id);
        continue;
      }
      const range = resolveAnchor(
        {
          pageIndex: rec.page_index,
          selectedText: rec.selected_text,
          prefix: rec.prefix,
          suffix: rec.suffix,
        },
        resolveRoot
      );
      if (!range) {
        orphans.add(rec.id);
        continue;
      }
      resolved.push({ id: rec.id, range });
      const bucket = byColor.get(rec.color);
      if (bucket) bucket.push(range);
      else byColor.set(rec.color, [range]);
    }

    resolvedRef.current = resolved;
    setOrphanIds(orphans);

    if (orphans.size > 0) {
      // Notes panel surfaces 待重新安放 for the current page (永不丢行原则);
      // still console.warn too since that's cheap and this pass runs
      // whether or not the panel is expanded.
      console.warn(`[annotation] ${orphans.size}/${pageAnnotations.length} orphaned on page ${pageIndex}`);
    }

    for (const { key } of ANNOTATION_COLORS) {
      const ranges = byColor.get(key);
      if (ranges && ranges.length > 0) {
        CSS.highlights.set(annotationHighlightName(key), new Highlight(...ranges));
      } else {
        CSS.highlights.delete(annotationHighlightName(key));
      }
    }

    return () => {
      for (const { key } of ANNOTATION_COLORS) {
        CSS.highlights.delete(annotationHighlightName(key));
      }
      resolvedRef.current = [];
    };
  }, [containerRef, pageAnnotations, pageIndex, isLiveHost]);

  // Click hit-test (batch B 交付物 2) — reads resolvedRef at call time, so
  // this stays one stable function identity across re-resolves.
  const hitTest = useCallback((clientX: number, clientY: number): AnnotationId | null => {
    let bestId: AnnotationId | null = null;
    let bestArea = Infinity;
    for (const { id, range } of resolvedRef.current) {
      for (const rect of range.getClientRects()) {
        if (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          const area = rect.width * rect.height;
          if (area < bestArea) {
            bestArea = area;
            bestId = id;
          }
          break;
        }
      }
    }
    return bestId;
  }, []);

  // scrollToAnnotation (批注计数同步案②) — timeout id kept in a ref so a second
  // click while one flash is still fading clears the earlier timer instead
  // of letting it delete the *new* flash out from under the fresh click.
  const flashTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current != null) window.clearTimeout(flashTimeoutRef.current);
    };
  }, []);

  const scrollToAnnotation = useCallback((id: AnnotationId): boolean => {
    const hit = resolvedRef.current.find((r) => r.id === id);
    if (!hit) return false; // orphaned, or not on the currently-mounted page — caller degrades
    const { range } = hit;
    const node = range.startContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });

    if (HIGHLIGHT_SUPPORTED) {
      ensureFlashHighlightStyle();
      if (flashTimeoutRef.current != null) window.clearTimeout(flashTimeoutRef.current);
      const flash = new Highlight(range);
      flash.priority = 1; // above the color washes' implicit 0, so the flash visibly wins
      CSS.highlights.set(FLASH_HIGHLIGHT_NAME, flash);
      flashTimeoutRef.current = window.setTimeout(() => {
        CSS.highlights.delete(FLASH_HIGHLIGHT_NAME);
        flashTimeoutRef.current = null;
      }, FLASH_MS);
    }
    return true;
  }, []);

  const allAnnotations = useMemo(() => annotationsQ.data ?? [], [annotationsQ.data]);

  return { pending, confirm, dismiss, allAnnotations, orphanIds, hitTest, scrollToAnnotation };
}
