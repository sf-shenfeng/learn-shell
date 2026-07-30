// The confirm pill for a pending selection (2026-07-06 定的交互:
// 选中 → 药丸/H 确认, 不劫持右键). Fixed-positioned at the selection's top
// center.
//
// Batch B (交付物 1): the single
// "划线·H" pill grows into a row of Mindmap-palette color dots (click a dot
// → commit instantly in that color) plus a "写笔记" entry (opens an inline
// textarea, commits with note text + whichever color is selected). `H`
// still confirms with the default color (amber) with no dot click needed —
// that shortcut lives in useAnnotations' own document keydown listener,
// untouched by anything here, so the keyboard path never regresses.
//
// onMouseDown preventDefault+stopPropagation on the root is load-bearing:
// without it, pressing the mouse anywhere in the pill (a dot, the note
// button, the textarea) collapses the selection and fires the
// document-level dismiss before click/submit can register.

import { useState } from 'react';
import { useT } from '../i18n';
import Kbd from '../shell/Kbd';
import type { PendingSelection } from './useAnnotations';
import { ANNOTATION_COLORS, DEFAULT_ANNOTATION_COLOR } from './palette';

export default function AnnotationPill({
  pending,
  onConfirmColor,
  onConfirmNote,
}: {
  pending: PendingSelection;
  /** Dot click — commit immediately, pure highlight in that color. */
  onConfirmColor: (color: string) => void;
  /** Note-mode save — commit with both the chosen color and note text. */
  onConfirmNote: (color: string, note: string) => void;
}) {
  const { t } = useT();
  const [noteMode, setNoteMode] = useState(false);
  const [color, setColor] = useState(DEFAULT_ANNOTATION_COLOR);
  const [draft, setDraft] = useState('');

  return (
    <div
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className="fixed z-50 flex flex-col"
      style={{
        left: pending.left,
        top: Math.max(8, pending.top - 8),
        transform: 'translate(-50%, -100%)',
        gap: '8px',
        width: noteMode ? '240px' : undefined,
        padding: noteMode ? '10px 12px' : '5px 10px',
        borderRadius: noteMode ? '10px' : '999px',
        border: '1px solid var(--ls-border-strong)',
        background: 'var(--ls-panel)',
        color: 'var(--ls-text)',
        boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
      }}
    >
      {!noteMode ? (
        <div className="flex items-center" style={{ gap: '7px' }}>
          {ANNOTATION_COLORS.map((c) => (
            <button
              key={c.key}
              type="button"
              title={c.key === DEFAULT_ANNOTATION_COLOR ? `${c.key} · H` : c.key}
              onClick={() => onConfirmColor(c.key)}
              className="hover:scale-110 transition-transform duration-[var(--ls-duration-fast)]"
              style={{
                width: '15px',
                height: '15px',
                borderRadius: '50%',
                background: c.hex,
                border:
                  c.key === DEFAULT_ANNOTATION_COLOR
                    ? '2px solid var(--ls-text)'
                    : '1px solid var(--ls-border)',
                cursor: 'pointer',
                padding: 0,
              }}
            />
          ))}
          <span
            aria-hidden
            style={{ width: '1px', height: '14px', background: 'var(--ls-border)' }}
          />
          <button
            type="button"
            onClick={() => setNoteMode(true)}
            className="text-[12px] hover:opacity-80"
            style={{ whiteSpace: 'nowrap', cursor: 'pointer' }}
          >
            {t('annotation.note')}
          </button>
          <Kbd>H</Kbd>
        </div>
      ) : (
        <>
          <div className="flex items-center" style={{ gap: '6px' }}>
            {ANNOTATION_COLORS.map((c) => (
              <button
                key={c.key}
                type="button"
                title={c.key}
                onClick={() => setColor(c.key)}
                style={{
                  width: '14px',
                  height: '14px',
                  borderRadius: '50%',
                  background: c.hex,
                  border: color === c.key ? '2px solid var(--ls-text)' : '1px solid var(--ls-border)',
                  cursor: 'pointer',
                  padding: 0,
                }}
              />
            ))}
          </div>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // Cancel note-mode, not the whole pending selection — the
                // dot row is still one click away. Stop propagation so the
                // document-level Escape-dismiss (which the hook's textarea
                // guard already skips) doesn't also fire redundantly.
                e.stopPropagation();
                setNoteMode(false);
                setDraft('');
              }
            }}
            placeholder={t('annotation.notePlaceholder')}
            rows={3}
            className="w-full text-[13px] leading-5 border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] placeholder:text-[var(--ls-text-tertiary)] focus:outline-none focus:border-[var(--ls-border-strong)] resize-y"
            style={{ padding: '8px 10px', borderRadius: '6px' }}
          />
          <div className="flex items-center justify-end" style={{ gap: '10px' }}>
            <button
              type="button"
              onClick={() => {
                setNoteMode(false);
                setDraft('');
              }}
              className="text-[12px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
            >
              {t('annotation.cancel')}
            </button>
            <button
              type="button"
              disabled={!draft.trim()}
              onClick={() => onConfirmNote(color, draft.trim())}
              className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium disabled:opacity-40"
              style={{ height: '26px', padding: '0 12px', borderRadius: '6px', fontSize: '12px' }}
            >
              {t('annotation.save')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
