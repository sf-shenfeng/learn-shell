// AnnotationOverlay — 已划高亮的浮层
// (呈现面 1, batch B 交付物 2). Opens when PagedLesson's Pager hit-tests a
// click against an existing highlight (useAnnotations().hitTest) — Pager
// owns which annotation id is active and where to float this (click
// coords), this component just renders the panel and does its own writes.
//
// Same "no native dialog" dialect as the rest of this batch: delete is a
// two-state inline confirm (mirrors shell/AdHocPanel.tsx's
// MessageDeleteControl — 隐私清理案, "Inline confirm — no window.confirm"),
// never window.confirm.

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PairId, Repository } from '@learn-shell/contracts';
import { useRepository } from '../repository';
import type { DocumentRepo } from '../repository/documentExt';
import { useT } from '../i18n';
import { ANNOTATION_COLORS } from './palette';
import { annotationsQueryKey } from './useAnnotations';
import { journalHostQueryKey, type AnnotationHost } from './host';
import type { LessonAnnotationWithOrphan } from './orphan';

// 保存文案修订's SAVED_COLLAPSE_MS dwell timer retired 2026-07-18 (学习者验收:
// save 成功即收) — see the updateNoteMut comment below.
const TITLE_MAX = 60;

export default function AnnotationOverlay({
  annotation,
  left,
  top,
  host,
  pairId,
  hostTitle,
  onClose,
}: {
  annotation: LessonAnnotationWithOrphan;
  /** Click-point viewport coords (fixed positioning, same simple dialect as
   *  AnnotationPill — brief 交付物 2 explicitly invites "取实现简单可靠的"). */
  left: number;
  top: number;
  /** 批G: generalized from a bare `lessonId` —
   *  same lesson-or-document discriminated union useAnnotations.ts
   *  takes. */
  host: AnnotationHost;
  pairId: PairId | null;
  /** For the pending-card's source_title (Cards.tsx's own "To pool" payload
   *  uses deck_id the same way — a human-readable provenance label). Lesson
   *  title or document title, whichever `host` names. */
  hostTitle: string;
  onClose: () => void;
}) {
  const repo = useRepository() as (Repository & DocumentRepo) | null;
  const qc = useQueryClient();
  const { t } = useT();
  const [noteDraft, setNoteDraft] = useState(annotation.note ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function invalidateAnnotations() {
    qc.invalidateQueries({ queryKey: annotationsQueryKey(host) });
    // 批注计数同步案①: keep the Journal drawer's own per-host key in sync too —
    // see host.ts's journalHostQueryKey doc comment. Covers color/note
    // edits and (via the delete branch below) deletes made from this
    // in-document overlay; NotesDrawer's own NoteCard edits already did
    // this symmetric invalidation (its local `invalidate()`), this file was
    // the missing half.
    qc.invalidateQueries({ queryKey: journalHostQueryKey(host) });
  }

  // Separate mutations for color vs. note — sharing one would make a color
  // click flash the note button's "已保存" label (both would share
  // isPending/isSuccess off the same mutation object).
  const updateColorMut = useMutation({
    mutationFn: (color: string) => {
      if (!repo) throw new Error('no repo');
      return repo.updateAnnotation(annotation.id, { color });
    },
    onSuccess: invalidateAnnotations,
  });

  // 保存文案修订 → 2026-07-18 学习者真机验收修订: "Save" originally showed
  // "Saved" and sat there forever; 保存文案修订 fixed that with a dwell-then-close
  // timer (Saved 显示 SAVED_COLLAPSE_MS 后自动收起). 验收 (live 教学记录挂
  // 批注) judged the dwell itself as "save 后框迟退" — and the codebase
  // already carries a second, faster house rhythm for this exact action:
  // NotesDrawer's NoteCard editor collapses the instant its own
  // updateNoteMut succeeds (setPanel('view') in onSuccess, zero dwell).
  // This overlay now follows that same "成功即收" rhythm: close directly in
  // onSuccess, no timer. Shared component, so lesson/document/live surfaces
  // stay identical by construction — no per-host divergence to drift. The
  // "已保存" label branch below is retained for the brief pending→close
  // frame but no longer rests on screen. onClose still read through a ref
  // (same reason 保存文案修订 introduced it): the caller passes a fresh inline
  // closure every render, and the ref guarantees the close call sees the
  // latest one.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const updateNoteMut = useMutation({
    mutationFn: (note: string | null) => {
      if (!repo) throw new Error('no repo');
      return repo.updateAnnotation(annotation.id, { note });
    },
    onSuccess: () => {
      invalidateAnnotations();
      onCloseRef.current();
    },
  });

  const deleteMut = useMutation({
    mutationFn: async () => {
      if (!repo) throw new Error('no repo');
      await repo.deleteAnnotation(annotation.id);
    },
    onSuccess: () => {
      invalidateAnnotations();
      // 轻量计数案: keep RecentRail's dedicated count query in sync with
      // deletes (its own key, no longer riding along on `invalidateAnnotations`).
      qc.invalidateQueries({ queryKey: ['notes-count', pairId] });
      onClose();
    },
  });

  // To pool (brief 交付物 2/3 批C 管道) — dedupe against the real pool the
  // same way Cards.tsx's "To pool" does (pages/Cards.tsx pooledFlashcardIds),
  // sharing its ['pending-cards', pairId] query key so both pages' caches
  // agree without a bespoke fetch.
  const pendingQ = useQuery({
    queryKey: ['pending-cards', pairId],
    queryFn: () => (repo && pairId ? repo.getPendingCards(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });
  const pooled = (pendingQ.data ?? []).some(
    (p) => p.source_type === 'annotation' && p.source_id === (annotation.id as unknown as string)
  );
  const toPoolMut = useMutation({
    mutationFn: () => {
      if (!repo || !pairId) throw new Error('no repo/pair');
      const raw = annotation.selected_text;
      const title = raw.length > TITLE_MAX ? raw.slice(0, TITLE_MAX - 1) + '…' : raw;
      return repo.addPendingCard(pairId, {
        title,
        content: annotation.note?.trim() || annotation.selected_text,
        source_type: 'annotation',
        source_id: annotation.id as unknown as string,
        source_title: hostTitle,
        reason: 'learner_highlight',
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pending-cards', pairId] });
    },
  });

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-50 flex flex-col"
      style={{
        left,
        top,
        transform: 'translate(-50%, 10px)',
        width: '280px',
        gap: '10px',
        padding: '14px',
        borderRadius: '10px',
        border: '1px solid var(--ls-border-strong)',
        background: 'var(--ls-panel)',
        color: 'var(--ls-text)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
      }}
    >
      <div className="flex items-center" style={{ gap: '6px' }}>
        {ANNOTATION_COLORS.map((c) => (
          <button
            key={c.key}
            type="button"
            title={c.key}
            onClick={() => updateColorMut.mutate(c.key)}
            style={{
              width: '16px',
              height: '16px',
              borderRadius: '50%',
              background: c.hex,
              border:
                annotation.color === c.key ? '2px solid var(--ls-text)' : '1px solid var(--ls-border)',
              cursor: 'pointer',
              padding: 0,
            }}
          />
        ))}
      </div>

      <textarea
        value={noteDraft}
        onChange={(e) => setNoteDraft(e.target.value)}
        placeholder={t('annotation.notePlaceholder')}
        rows={3}
        className="w-full text-[13px] leading-5 border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] placeholder:text-[var(--ls-text-tertiary)] focus:outline-none focus:border-[var(--ls-border-strong)] resize-y"
        style={{ padding: '8px 10px', borderRadius: '6px' }}
      />

      <div className="flex items-center justify-between flex-wrap" style={{ gap: '8px' }}>
        <button
          type="button"
          onClick={() => updateNoteMut.mutate(noteDraft.trim() || null)}
          disabled={updateNoteMut.isPending}
          className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium disabled:opacity-40"
          style={{ height: '26px', padding: '0 12px', borderRadius: '6px', fontSize: '12px' }}
        >
          {updateNoteMut.isPending
            ? t('annotation.saving')
            : updateNoteMut.isSuccess
              ? t('annotation.saved')
              : t('annotation.saveNoteIdle')}
        </button>

        <button
          type="button"
          onClick={() => toPoolMut.mutate()}
          disabled={pooled || toPoolMut.isPending}
          className="text-[12px] text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)] disabled:opacity-40"
        >
          {pooled
            ? t('annotation.pooled')
            : toPoolMut.isPending
              ? t('annotation.poolingInProgress')
              : t('annotation.toPool')}
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
            {t('annotation.delete')}
          </button>
        )}
      </div>
    </div>
  );
}
