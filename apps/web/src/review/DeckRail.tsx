import { useState } from 'react';
import { useT } from '../i18n';

/**
 * Sentinel course id for decks whose cards don't resolve to any course
 * (either the deck has no cards, or none of its cards' concept_id maps
 * to a course — see Review.tsx's deckCourseId majority-vote build). Not
 * a real CourseId, just a string DeckRail and Review.tsx both recognize
 * to mean "the Ungrouped bucket," always rendered last.
 */
export const UNGROUPED_COURSE_KEY = '__ungrouped__';

/**
 * DeckRail — Review page's deck filter, right-placed (DeckRail 右置案).
 *
 * Collapse/expand visual + interaction language is lifted from Mind Map's
 * Inspector (apps/web/src/pages/Mindmap.tsx — nicknamed "the
 * Indicator"): same position sense (right-hand sticky column), same
 * collapsed shape (40px rail, vertical uppercase label, click-anywhere-
 * to-expand), same "›" chevron to collapse from the expanded header, same
 * `transition-colors` hover token. Not a pixel copy — Inspector is a
 * 320px editor panel with a live node form; this is a ~220px read-only
 * filter list — but the same design vocabulary so the two right-hand
 * rails on Mind Map and Review read as one family.
 *
 * 卡组内浏览器案 (2026-07-09): each deck row grows a per-deck card browser — the
 * "▸" caret expands the deck to list *all* its cards (not just due; the
 * amber dot marks due ones). Clicking a card jumps the review stage to it:
 * due cards jump the queue, non-due cards open as a detour (see
 * Review.tsx). The rail now lists every deck that exists, not only decks
 * with due cards, so a fully-rested deck is still browsable; counts
 * remain *due* counts.
 *
 * 行体点击扩区案 (2026-07-09 pt2, 实机反馈: "▸ 太小不好点"): the row body itself
 * (name + count) now does double duty — clicking it both selects the deck
 * as the queue filter *and* expands its card list in one hit, since ▸ was
 * too small a target. Re-clicking an already-selected row toggles the
 * card list open/closed instead of re-selecting a no-op. ▸ still works
 * standalone as a pure open/close toggle (doesn't touch selection) and
 * still carries the rotate animation as the expand-state indicator.
 * "All due" is unaffected — it's a plain selection with no card list.
 *
 * Persistence of the collapsed flag is a separate concern (see Review.tsx
 * — it follows the Lesson page's LIVE_OPEN_KEY precedent, not Inspector,
 * which doesn't persist its own collapse state at all). Per-deck open
 * state is deliberately session-local (useState) — noise, not preference.
 *
 * Course-grouping ask (2026-07): the flat deck list got long enough
 * that opening the rail was "一眼到底" — no longer browsable at a glance.
 * A Course level now sits above deck: Course ▸ → deck ▸ → cards, three
 * levels deep. `courseGroups` is pre-bucketed by Review.tsx
 * (deck → course is a majority vote over each deck's cards' concept_id,
 * since there's no direct deck→course link in the data model — see
 * Review.tsx's deckCourseId comment). This component only renders the
 * grouping; it doesn't compute it. Course accordion reuses the exact same
 * ▸ + Set open/close vocabulary as the per-deck card browser below
 * (openCourses is just another instance of the openDecks pattern), and
 * defaults to all-collapsed — that collapse-by-default *is* the fix for
 * "太长" (Review.tsx doesn't persist this like it does the rail's own
 * collapse; per-course open state is session noise same as per-deck).
 */
export function DeckRail({
  courseGroups,
  totalAll,
  selected,
  onSelect,
  collapsed,
  onToggleCollapse,
  deckCards,
  dueIds,
  currentCardId,
  onSelectCard,
  initialOpenCourseId,
}: {
  /** Pre-grouped by Review.tsx; one entry per course plus (if non-empty)
   * a trailing Ungrouped bucket keyed `UNGROUPED_COURSE_KEY`. */
  courseGroups: Array<{
    courseId: string;
    topic: string;
    decks: Array<{ deck_id: string; count: number }>;
  }>;
  totalAll: number;
  selected: string | 'all';
  onSelect: (v: string | 'all') => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  deckCards: ReadonlyMap<string, ReadonlyArray<{ id: string; front: string }>>;
  dueIds: ReadonlySet<string>;
  currentCardId?: string;
  onSelectCard: (cardId: string) => void;
  /** 课程深链案 — Review.tsx's ?course= deep link (from a lesson-end "Review
   * flashcards" jump). Seeds this one course's accordion open on first
   * mount only, same as pre-selecting the deck was — the "打开 rail 不再是
   * 一眼到底" default-collapsed behavior below is otherwise untouched. */
  initialOpenCourseId?: string;
}) {
  const { t, lang } = useT();
  const [openDecks, setOpenDecks] = useState<ReadonlySet<string>>(new Set());
  // Course accordion — same Set-of-open-keys pattern as openDecks, just one
  // level up. Starts empty (all collapsed) every mount unless a deep link
  // (课程深链案's initialOpenCourseId) names one to seed open — that's still the
  // fix for "打开 rail 不再是一眼到底", it just isn't unconditional anymore.
  // Session-local, not persisted, same as openDecks.
  const [openCourses, setOpenCourses] = useState<ReadonlySet<string>>(
    () => new Set(initialOpenCourseId ? [initialOpenCourseId] : [])
  );
  const toggleCourseOpen = (courseId: string) =>
    setOpenCourses((prev) => {
      const next = new Set(prev);
      if (next.has(courseId)) next.delete(courseId);
      else next.add(courseId);
      return next;
    });
  const totalDeckCount = courseGroups.reduce((sum, g) => sum + g.decks.length, 0);
  if (totalDeckCount === 0) return null;

  const toggleDeckOpen = (deck_id: string) =>
    setOpenDecks((prev) => {
      const next = new Set(prev);
      if (next.has(deck_id)) next.delete(deck_id);
      else next.add(deck_id);
      return next;
    });

  // 行体点击扩区案 — row-body click now selects *and* expands in one hit (实机反馈:
  // "▸ 太小不好点"). Selecting a not-yet-selected deck opens its card list;
  // clicking an already-selected deck's row body instead toggles open/closed
  // (mirrors what the ▸ caret alone used to do), so re-clicking doesn't
  // force it back open. The ▸ caret itself is untouched — still a pure
  // open/close toggle that never changes selection.
  const selectDeckRow = (deck_id: string) => {
    const cards = deckCards.get(deck_id) ?? [];
    if (selected === deck_id) {
      if (cards.length > 0) toggleDeckOpen(deck_id);
      return;
    }
    onSelect(deck_id);
    if (cards.length > 0) {
      setOpenDecks((prev) => {
        if (prev.has(deck_id)) return prev;
        const next = new Set(prev);
        next.add(deck_id);
        return next;
      });
    }
  };

  // Rail mode — click anywhere on the 40px column to expand. Mirrors
  // Inspector's collapsed rail button in Mindmap.tsx exactly (same width,
  // same vertical-rl label treatment, same hover class).
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
          position: 'sticky',
          top: '12px',
          alignSelf: 'flex-start',
        }}
        title={t('review.deckRail.expandTitle')}
      >
        <span>{t('review.deckRail.heading')}{totalAll ? ` · ${totalAll}` : ''}</span>
      </button>
    );
  }

  return (
    <aside
      className="flex-none border border-[var(--ls-border)]"
      style={{
        width: '220px',
        padding: '14px 12px',
        borderRadius: '10px',
        position: 'sticky',
        top: '12px',
        alignSelf: 'flex-start',
        maxHeight: 'calc(100vh - 24px)',
        overflowY: 'auto',
      }}
    >
      <div
        className="flex items-center justify-between"
        style={{ marginBottom: '10px', padding: '0 6px' }}
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--ls-text-tertiary)]">
          {t('review.deckRail.heading')}
        </div>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="text-[13px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors"
          style={{ padding: '2px 6px', lineHeight: '1' }}
          title={t('review.deckRail.collapseTitle')}
        >
          ›
        </button>
      </div>
      <ul className="flex flex-col" style={{ gap: '2px' }}>
        <DeckRow
          label={t('review.deckRail.allDue')}
          count={totalAll}
          selected={selected === 'all'}
          onClick={() => onSelect('all')}
        />
        {courseGroups.map((group) => {
          const courseOpen = openCourses.has(group.courseId);
          const isUngrouped = group.courseId === UNGROUPED_COURSE_KEY;
          const courseLabel = isUngrouped
            ? lang === 'zh'
              ? '独立卡组'
              : 'Independent decks'
            : group.topic;
          const courseCardTotal = group.decks.reduce((sum, d) => sum + d.count, 0);
          return (
            <li key={group.courseId}>
              {/* Course header — same ▸ + row-body vocabulary as the deck
                  row below, one level up. Pure open/close toggle only (no
                  selection semantics at the course level — filtering still
                  happens per-deck, unchanged). font-semibold (vs. the deck
                  row's font-medium) is the only visual delta marking it as
                  the outer hierarchy level. */}
              <div
                className="w-full flex items-center rounded-[var(--ls-radius-control)] transition-colors duration-[var(--ls-duration-fast)] text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)]"
              >
                <button
                  type="button"
                  onClick={() => toggleCourseOpen(group.courseId)}
                  className="flex-none text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors"
                  style={{ padding: '7px 0 7px 6px', lineHeight: '1', fontSize: '10px' }}
                  title={
                    courseOpen ? t('review.deckRail.browseClose') : t('review.deckRail.browseOpen')
                  }
                >
                  <span
                    style={{
                      display: 'inline-block',
                      transform: courseOpen ? 'rotate(90deg)' : 'none',
                      transition: 'transform var(--ls-duration-fast)',
                    }}
                  >
                    ▸
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => toggleCourseOpen(group.courseId)}
                  className="flex items-center justify-between flex-1 min-w-0"
                  style={{ padding: '7px 10px 7px 6px', gap: '8px' }}
                >
                  <span
                    className="text-[13px] leading-5 font-semibold truncate text-left flex-1 min-w-0"
                    title={courseLabel}
                  >
                    {courseLabel}
                  </span>
                  <span className="flex-none text-[11px] leading-4 text-[var(--ls-text-tertiary)] tabular-nums">
                    {courseCardTotal}
                  </span>
                </button>
              </div>
              {courseOpen && (
                <ul
                  className="flex flex-col"
                  style={{ gap: '2px', margin: '2px 0 4px', paddingLeft: '10px' }}
                >
                  {group.decks.map((d) => {
                    const cards = deckCards.get(d.deck_id) ?? [];
                    const open = openDecks.has(d.deck_id);
                    return (
                      <li key={d.deck_id}>
                        <div
                          className={`w-full flex items-center rounded-[var(--ls-radius-control)] transition-colors duration-[var(--ls-duration-fast)] ${
                            selected === d.deck_id
                              ? 'bg-[var(--ls-panel)] text-[var(--ls-text)]'
                              : 'text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)]'
                          }`}
                        >
                          {cards.length > 0 && (
                            <button
                              type="button"
                              onClick={() => toggleDeckOpen(d.deck_id)}
                              className="flex-none text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors"
                              style={{ padding: '7px 0 7px 6px', lineHeight: '1', fontSize: '10px' }}
                              title={
                                open ? t('review.deckRail.browseClose') : t('review.deckRail.browseOpen')
                              }
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
                          )}
                          <button
                            type="button"
                            onClick={() => selectDeckRow(d.deck_id)}
                            className="flex items-center justify-between flex-1 min-w-0"
                            style={{ padding: cards.length > 0 ? '7px 10px 7px 6px' : '7px 10px', gap: '8px' }}
                          >
                            <span className="text-[13px] leading-5 font-medium truncate text-left flex-1 min-w-0">
                              {d.deck_id}
                            </span>
                            <span className="flex-none text-[11px] leading-4 text-[var(--ls-text-tertiary)] tabular-nums">
                              {d.count}
                            </span>
                          </button>
                        </div>
                        {open && cards.length > 0 && (
                          <ul className="flex flex-col" style={{ gap: '1px', margin: '2px 0 4px' }}>
                            {cards.map((c) => (
                              <li key={c.id}>
                                <button
                                  type="button"
                                  onClick={() => onSelectCard(c.id)}
                                  className={`w-full flex items-center rounded-[var(--ls-radius-control)] transition-colors duration-[var(--ls-duration-fast)] ${
                                    currentCardId === c.id
                                      ? 'bg-[var(--ls-panel)] text-[var(--ls-text)]'
                                      : 'text-[var(--ls-text-tertiary)] hover:bg-[var(--ls-panel)] hover:text-[var(--ls-text-secondary)]'
                                  }`}
                                  style={{ padding: '5px 10px 5px 20px', gap: '7px' }}
                                >
                                  <span
                                    className="flex-none"
                                    title={dueIds.has(c.id) ? t('review.deckRail.dueDot') : undefined}
                                    style={{
                                      width: 5,
                                      height: 5,
                                      borderRadius: '50%',
                                      background: dueIds.has(c.id)
                                        ? 'var(--ls-hypothesis)'
                                        : 'var(--ls-border)',
                                    }}
                                  />
                                  <span className="text-[12px] leading-[18px] truncate text-left flex-1 min-w-0">
                                    {c.front}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function DeckRow({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`w-full flex items-center justify-between rounded-[var(--ls-radius-control)] transition-colors duration-[var(--ls-duration-fast)] ${
          selected
            ? 'bg-[var(--ls-panel)] text-[var(--ls-text)]'
            : 'text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)]'
        }`}
        style={{ padding: '7px 10px', gap: '8px' }}
      >
        <span className="text-[13px] leading-5 font-medium truncate text-left flex-1 min-w-0">
          {label}
        </span>
        <span className="flex-none text-[11px] leading-4 text-[var(--ls-text-tertiary)] tabular-nums">
          {count}
        </span>
      </button>
    </li>
  );
}
