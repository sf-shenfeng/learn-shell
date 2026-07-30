// PoolDrawer — 待整理池的家, now a summon-able drawer (卡池抽屉化 二期).
//
// The call: nav shouldn't give "a permanently-empty inbox" a top-level
// seat — Pool demotes from a page to a component you call up when you need
// it. This file is `pages/Pool.tsx` moved wholesale: six source groups,
// upgrade-to-flashcard panel, go-to-mindmap, inline dismiss-confirm, empty
// states — "功能和升级逻辑做得特别好" (验收评语), so only the container changed,
// not the content. Two summon points wire into this: RecentRail's "待整理"
// row (opens) and the global G P shortcut (toggles) — both live in
// AppShell/RecentRail/Shortcuts, `open`/`onClose` are plain props threaded
// from state lifted in AppShell, mirroring the existing paletteOpen/
// CommandPalette wiring (no new Context needed — every call site is a
// direct child of AppShell already, same shape as the palette).
//
// 军规 (unchanged from the page): all reads/writes go through existing
// repository methods (getPendingCards / createFlashcard / dismissPendingCard)
// — no new endpoints, no repository changes. React Query key sticks to
// ['pending-cards', pairId], shared with Cards/Mindmap/RecentRail; deck
// derivation shares Cards.tsx's ['flashcards-all', pairId] key + "New deck…"
// sentinel semantics, read-only reference, Cards.tsx itself untouched.
//
// Drawer mechanics:
//   - Right-edge slide-over, translateX + backdrop-opacity transition on
//     --ls-easing (design token, not a one-off curve) with a direction-aware
//     duration — DRAWER_COLLAPSE_MS / DRAWER_EXPAND_MS below, same split as
//     AppShell's sidebar collapse (手感调优, 实机反馈: 偏硬).
//   - Always mounted (not conditionally rendered) so the close transition
//     actually plays — same trick AppShell's own sidebar collapse uses
//     (translateX + overflow, never unmounts). One consequence, called out
//     per the brief's "偏差说明" ask: a row's transient UI (open upgrade
//     panel, an armed dismiss-confirm) survives a close→reopen cycle since
//     the tree doesn't remount; the queries also keep quietly polling while
//     closed, same as RecentRail already does sitting in the sidebar. Not
//     fixed further — brief says move it, not redesign it.
//   - Esc closes, guarded against input/textarea/contenteditable focus —
//     the exact guard Lesson.tsx's Focus-mode Esc handler uses (comment
//     there: "guarded... the same way Mindmap guards its own Escape
//     handling"). No cross-feature coordination: this listener only
//     attaches while `open`, so it composes with Focus mode's independent
//     Esc listener (and annotation's, and Mindmap's) exactly like those
//     already coexist — each feature checks "is this even mine to handle"
//     and no-ops otherwise.
//   - Header (title + close button) renders even in the `!repo` ("Empty"
//     data mode) branch, where the original page rendered *only* the bare
//     "Empty mode…" sentence with no header at all. A drawer needs a
//     visible close affordance in every state; that's new chrome required
//     by turning this into an overlay, not a change to the moved content
//     itself. Flagged in the final report per 偏差说明.
//   - "去落图" also closes the drawer on click (`onNavigate`) — judgment
//     call, not in the original page (which had nothing to close): the
//     drawer would otherwise float on top of the Mindmap canvas you just
//     asked to go edit.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Flashcard,
  PendingCardId,
  PendingCardSourceType,
  PendingMindmapCard,
} from '@learn-shell/contracts';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';
import { usePrefersReducedMotion } from '../shell/FlipCard';
import Kbd from '../shell/Kbd';
import { useT } from '../i18n';
import type { DictKey } from '../i18n/dict';

// 手感调优（实机反馈: 收起偏硬）: same collapse/expand split as AppShell's
// sidebar (see AppShell.tsx SIDEBAR_COLLAPSE_MS/SIDEBAR_EXPAND_MS) — closing
// a beat quicker than opening gives the slide a direction instead of reading
// like the same clip played backwards. Kept in the brief's 180–220 /
// 220–280ms windows. --ls-easing (cubic-bezier(0.16,1,0.3,1)) already is the
// house ease-out curve (same one FlipCard uses); this drawer already used it
// via --ls-duration-base, just without the directional split.
const DRAWER_COLLAPSE_MS = 200; // closing
const DRAWER_EXPAND_MS = 240; // opening

// Sentinel option value for "New deck…" in the deck select — same semantics
// as Cards.tsx's NEW_DECK_SENTINEL (decks are derived entities, born with
// their first card; "creating" one is just typing a fresh deck_id here).
const NEW_DECK_SENTINEL = '__new_deck__';

const fieldInputStyle: React.CSSProperties = {
  height: '30px',
  padding: '0 10px',
  border: '1px solid var(--ls-border)',
  borderRadius: '6px',
  fontSize: '12px',
  lineHeight: '1',
  width: '170px',
};

// Group order + display label key. Brief's four named groups keep their
// given Chinese label; agent_seed / lesson_highlight get a matching label
// in the same voice (brief listed them by source_type only, no gloss
// given). Labels resolved via t() at the component call site (this array
// is module-level, no hook access here).
const SOURCE_GROUPS: { type: PendingCardSourceType; labelKey: DictKey }[] = [
  { type: 'flashcard', labelKey: 'pool.source.flashcard' },
  { type: 'annotation', labelKey: 'pool.source.annotation' },
  { type: 'exercise', labelKey: 'pool.source.exercise' },
  { type: 'manual', labelKey: 'pool.source.manual' },
  { type: 'agent_seed', labelKey: 'pool.source.agentSeed' },
  { type: 'lesson_highlight', labelKey: 'pool.source.lessonHighlight' },
];

function truncate(s: string, n: number): string {
  const trimmed = s.trim();
  return trimmed.length > n ? `${trimmed.slice(0, n).trimEnd()}…` : trimmed;
}

function timeAgo(iso: string, nowMs: number, t: (key: DictKey) => string): string {
  const ms = nowMs - new Date(iso).getTime();
  if (ms < 60_000) return t('pool.time.justNow');
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}${t('pool.time.minAgo')}`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}${t('pool.time.hourAgo')}`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}${t('pool.time.dayAgo')}`;
  return new Date(iso).toLocaleDateString();
}

export default function PoolDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const repo = useRepository();
  const { pairId } = usePair();
  const qc = useQueryClient();
  const { t } = useT();
  const prefersReducedMotion = usePrefersReducedMotion();

  const drawerMs = open ? DRAWER_EXPAND_MS : DRAWER_COLLAPSE_MS;
  const backdropTransition = prefersReducedMotion
    ? 'none'
    : `opacity ${drawerMs}ms var(--ls-easing)`;
  const panelTransition = prefersReducedMotion
    ? 'none'
    : `transform ${drawerMs}ms var(--ls-easing)`;

  const pendingQ = useQuery({
    queryKey: ['pending-cards', pairId],
    queryFn: () => (repo && pairId ? repo.getPendingCards(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });

  // Deck options for the "upgrade to flashcard" select — shares Cards.tsx's
  // exact query key so both pages read the same cache, no duplicate fetch.
  const flashcardsQ = useQuery({
    queryKey: ['flashcards-all', pairId],
    queryFn: () => (repo && pairId ? repo.getAllFlashcards(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });
  const deckOptions = useMemo(
    () =>
      Array.from(
        new Set((flashcardsQ.data ?? []).map((c) => c.deck_id as unknown as string))
      ).sort(),
    [flashcardsQ.data]
  );

  function invalidatePending() {
    qc.invalidateQueries({ queryKey: ['pending-cards', pairId] });
  }

  const upgradeMut = useMutation({
    mutationFn: async ({ card, deck }: { card: PendingMindmapCard; deck: string }) => {
      await repo!.createFlashcard({
        pair_id: pairId!,
        deck_id: deck as Flashcard['deck_id'],
        concept_id: null,
        front: card.title,
        back: card.content,
        tags: [],
        source_refs: [],
      });
      await repo!.dismissPendingCard(card.id);
    },
    onSuccess: () => {
      invalidatePending();
      qc.invalidateQueries({ queryKey: ['flashcards-all'] });
    },
  });

  const dismissMut = useMutation({
    mutationFn: (id: PendingCardId) => repo!.dismissPendingCard(id),
    onSuccess: invalidatePending,
  });

  // Esc closes — only listens while open, guarded against form controls.
  // See file-header note: composes independently with Focus mode's own
  // Esc handler (and annotation's, and Mindmap's) with no shared state.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const pending = (pendingQ.data ?? []).filter((p) => !p.placed_in_mindmap_id);
  const groups = SOURCE_GROUPS.map((g) => ({
    type: g.type,
    label: t(g.labelKey),
    cards: pending.filter((p) => p.source_type === g.type),
  })).filter((g) => g.cards.length > 0);

  return (
    <>
      {/* =================== Backdrop =================== */}
      <div
        onClick={onClose}
        aria-hidden={!open}
        className="fixed inset-0"
        style={{
          zIndex: 50,
          background: 'rgba(0,0,0,0.3)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: backdropTransition,
        }}
      />

      {/* =================== Panel =================== */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.pool')}
        aria-hidden={!open}
        className="fixed top-0 right-0 bottom-0 flex flex-col bg-[var(--ls-bg)]"
        style={{
          zIndex: 50,
          width: 'min(440px, 92vw)',
          borderLeft: '1px solid var(--ls-border)',
          boxShadow: '-24px 0 56px -12px rgba(0,0,0,0.25)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: panelTransition,
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        {/* Header — drawer chrome, present in every data-mode branch (see
            file-header deviation note). */}
        <div
          className="flex-none flex items-start justify-between"
          style={{ padding: '20px 20px 14px' }}
        >
          <div>
            <div className="flex items-baseline" style={{ gap: '8px' }}>
              <h1
                className="font-bold"
                style={{
                  margin: 0,
                  fontSize: '20px',
                  lineHeight: '28px',
                  letterSpacing: '-0.02em',
                }}
              >
                {t('nav.pool')}
              </h1>
              {/* 卡池常驻行案: 同款 kbd 提示，跟 RecentRail 的召唤入口对上号 —
                  小、tertiary，不抢标题。 */}
              <Kbd>G P</Kbd>
            </div>
            <div
              className="text-[var(--ls-text-tertiary)]"
              style={{ fontSize: '13px', lineHeight: '20px', marginTop: '2px' }}
            >
              {pending.length === 0
                ? t('pool.waystation')
                : `${pending.length}${t('pool.pendingSuffix')}`}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('pool.closeAriaLabel')}
            title={t('pool.closeTitle')}
            className="flex-none text-[16px] text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)] leading-none w-7 h-7 flex items-center justify-center rounded-md hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto" style={{ padding: '0 20px 20px' }}>
          {!repo ? (
            <p className="text-sm text-[var(--ls-text-secondary)]">
              Empty mode · no pending cards yet.
            </p>
          ) : (
            <>
              {/* =================== Loading / Empty =================== */}
              {pendingQ.isLoading && (
                <p className="text-sm text-[var(--ls-text-tertiary)]">Loading…</p>
              )}
              {!pendingQ.isLoading && pending.length === 0 && (
                <div
                  className="text-center text-[var(--ls-text-tertiary)]"
                  style={{
                    border: '1px solid var(--ls-border)',
                    borderRadius: '8px',
                    padding: '40px 16px',
                    fontSize: '13px',
                    lineHeight: '20px',
                  }}
                >
                  {t('pool.emptyState')}
                </div>
              )}

              {/* =================== Groups =================== */}
              {groups.map((g) => (
                <div key={g.type} style={{ marginBottom: '22px' }}>
                  <div
                    className="flex items-center"
                    style={{ gap: '10px', marginBottom: '10px' }}
                  >
                    <span
                      className="font-semibold"
                      style={{ fontSize: '14px', lineHeight: '20px' }}
                    >
                      {g.label}
                    </span>
                    <span
                      className="text-[var(--ls-text-tertiary)] tabular-nums"
                      style={{ fontSize: '12px', lineHeight: '16px' }}
                    >
                      {g.cards.length}
                    </span>
                  </div>
                  <div
                    style={{
                      border: '1px solid var(--ls-border)',
                      borderRadius: '8px',
                      overflow: 'hidden',
                    }}
                  >
                    {g.cards.map((c) => (
                      <PoolCardRow
                        key={c.id}
                        card={c}
                        deckOptions={deckOptions}
                        upgrading={
                          upgradeMut.isPending && upgradeMut.variables?.card.id === c.id
                        }
                        dismissing={dismissMut.isPending && dismissMut.variables === c.id}
                        onUpgrade={(deck) => upgradeMut.mutate({ card: c, deck })}
                        onDismiss={() => dismissMut.mutate(c.id)}
                        onNavigateAway={onClose}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PoolCardRow({
  card,
  deckOptions,
  upgrading,
  dismissing,
  onUpgrade,
  onDismiss,
  onNavigateAway,
}: {
  card: PendingMindmapCard;
  deckOptions: string[];
  upgrading: boolean;
  dismissing: boolean;
  onUpgrade: (deck: string) => void;
  onDismiss: () => void;
  onNavigateAway: () => void;
}) {
  const { t } = useT();
  const [panel, setPanel] = useState<'upgrade' | null>(null);
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);
  const nowMs = Date.now();

  // Close the dismiss confirm if the row starts an upgrade, and vice versa —
  // only one inline affordance open at a time keeps the row calm.
  const openUpgrade = () => {
    setConfirmingDismiss(false);
    setPanel((p) => (p === 'upgrade' ? null : 'upgrade'));
  };
  const openDismissConfirm = () => {
    setPanel(null);
    setConfirmingDismiss(true);
  };

  return (
    <div style={{ borderBottom: '1px solid var(--ls-border)' }}>
      <div
        className="flex items-center flex-wrap"
        style={{ gap: '14px', padding: '13px 16px' }}
      >
        <div className="flex-1 min-w-0" style={{ minWidth: '220px' }}>
          <div
            className="truncate"
            style={{ fontSize: '14px', lineHeight: '20px' }}
          >
            {card.title}
          </div>
          {card.content && (
            <div
              className="text-[var(--ls-text-secondary)] truncate"
              style={{ fontSize: '12px', lineHeight: '18px', marginTop: '2px' }}
            >
              {truncate(card.content, 140)}
            </div>
          )}
          <div
            className="flex items-center flex-wrap text-[var(--ls-text-tertiary)]"
            style={{ gap: '8px', fontSize: '11px', lineHeight: '16px', marginTop: '4px' }}
          >
            {card.source_title && (
              <span
                style={{
                  padding: '1px 7px',
                  border: '1px solid var(--ls-border)',
                  borderRadius: '999px',
                }}
              >
                {card.source_title}
              </span>
            )}
            <span>{timeAgo(card.created_at, nowMs, t)}</span>
          </div>
        </div>

        <div className="flex items-center flex-none" style={{ gap: '8px' }}>
          <RowButton onClick={openUpgrade} disabled={upgrading}>
            {upgrading ? t('pool.upgrading') : t('pool.upgradeToFlashcard')}
          </RowButton>
          <RowLinkButton to="/mindmap" onNavigate={onNavigateAway}>
            {t('pool.goToMindmap')}
          </RowLinkButton>
          {!confirmingDismiss ? (
            <RowButton onClick={openDismissConfirm} danger>
              {t('pool.dismiss')}
            </RowButton>
          ) : (
            <>
              <RowButton onClick={onDismiss} disabled={dismissing} danger>
                {dismissing ? t('pool.dismissing') : t('pool.confirmDismiss')}
              </RowButton>
              <RowButton onClick={() => setConfirmingDismiss(false)}>{t('pool.cancel')}</RowButton>
            </>
          )}
        </div>
      </div>

      {panel === 'upgrade' && (
        <UpgradePanel
          deckOptions={deckOptions}
          pending={upgrading}
          onCancel={() => setPanel(null)}
          onConfirm={(deck) => onUpgrade(deck)}
        />
      )}
    </div>
  );
}

// Deck select for "升级成闪卡" — mirrors Cards.tsx's deck derivation +
// "New deck…" sentinel interaction (read-only reference; not imported from
// Cards.tsx, which stays untouched).
function UpgradePanel({
  deckOptions,
  pending,
  onCancel,
  onConfirm,
}: {
  deckOptions: string[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: (deck: string) => void;
}) {
  const { t } = useT();
  const [deck, setDeck] = useState('');
  const [newDeckMode, setNewDeckMode] = useState(deckOptions.length === 0);

  useEffect(() => {
    if (newDeckMode || deck || deckOptions.length === 0) return;
    setDeck(deckOptions[0]!);
  }, [newDeckMode, deck, deckOptions]);

  const canConfirm = deck.trim().length > 0 && !pending;

  return (
    <div
      className="flex items-center flex-wrap"
      style={{
        gap: '10px',
        padding: '0 16px 14px 16px',
        borderTop: '1px dashed var(--ls-border)',
        marginTop: '-1px',
        paddingTop: '12px',
      }}
    >
      <span
        className="text-[var(--ls-text-tertiary)]"
        style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}
      >
        {t('cards.deck')}
      </span>
      {deckOptions.length === 0 || newDeckMode ? (
        <div className="flex items-center" style={{ gap: '6px' }}>
          <input
            type="text"
            value={deck}
            onChange={(e) => setDeck(e.target.value)}
            placeholder={t('journal.notes.deckPlaceholder')}
            className="bg-[var(--ls-bg)] text-[var(--ls-text)] focus:outline-none"
            style={fieldInputStyle}
          />
          {deckOptions.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setNewDeckMode(false);
                setDeck(deckOptions[0]!);
              }}
              className="text-[10px] uppercase tracking-[0.08em] font-medium text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] leading-none"
            >
              {t('cards.existingButton')}
            </button>
          )}
        </div>
      ) : (
        <select
          value={deck}
          onChange={(e) => {
            if (e.target.value === NEW_DECK_SENTINEL) {
              setNewDeckMode(true);
              setDeck('');
            } else {
              setDeck(e.target.value);
            }
          }}
          className="bg-[var(--ls-bg)] text-[var(--ls-text)] focus:outline-none"
          style={fieldInputStyle}
        >
          {deckOptions.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
          <option value={NEW_DECK_SENTINEL}>{t('journal.notes.newDeckOption')}</option>
        </select>
      )}
      <RowButton onClick={() => onConfirm(deck.trim())} disabled={!canConfirm} primary>
        {pending ? t('pool.upgrading') : t('pool.confirmUpgrade')}
      </RowButton>
      <RowButton onClick={onCancel}>{t('pool.cancel')}</RowButton>
    </div>
  );
}

function RowButton({
  children,
  onClick,
  danger,
  primary,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      style={{
        height: '30px',
        padding: '0 12px',
        border: primary ? 'none' : '1px solid var(--ls-border-strong)',
        borderRadius: '6px',
        fontWeight: 500,
        fontSize: '12px',
        lineHeight: '1',
        background: primary ? 'var(--ls-text)' : undefined,
        color: primary ? 'var(--ls-bg)' : danger ? 'var(--ls-risk)' : undefined,
        cursor: disabled ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

function RowLinkButton({
  to,
  children,
  onNavigate,
}: {
  to: string;
  children: React.ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      className="inline-flex items-center hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
      style={{
        height: '30px',
        padding: '0 12px',
        border: '1px solid var(--ls-border-strong)',
        borderRadius: '6px',
        fontWeight: 500,
        fontSize: '12px',
        lineHeight: '1',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Link>
  );
}
