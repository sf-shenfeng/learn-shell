// StatusPill — shared box model for the app's "status/flag" pill family
// (border + colored dot + uppercase label). Single source of truth so the
// three call sites (LessonStatusBadge's 已学完/已回课, Lesson.tsx's
// RevisionPill "已修订 vN", Courses.tsx's RevisedFlag) physically cannot
// drift apart in padding/font-size/line-height/border/dot-size again.
//
// 2026-07-29 header-pill misalignment post-mortem: padding/fontSize/
// lineHeight/border were already byte-identical between RevisionPill and
// LessonStatusBadge, yet the two still sat ~2.5px apart on screen. Root
// cause wasn't the pill's own box model — it was RevisionPill's anchor
// wrapper (`<div className="relative inline-block">`, needed to position
// the revision-history popover). That div is itself a flex item of the
// header row, and per the CSS blockification rule, a flex item's specified
// *inline-level* display (inline-block) computes to its block equivalent
// (`display: block`) — the wrapper stops being "inline-block" the moment
// it's a flex child, full stop, regardless of the className still saying
// so. A plain `display:block` box containing one inline-flex child builds
// an ordinary line box around that child, and line boxes get a "strut" —
// an invisible zero-width inline box using the *block's own* font/
// line-height (inherited body defaults, ~16px/24px here) — that strut is
// taller than the pill (20px) and the pill's default vertical-align:
// baseline then aligns to the strut's baseline, not to the row's flex
// centering. LessonStatusBadge has no such wrapper (it *is* the flex
// item), so it never hit this — hence the visible offset.
//
// Fix: callers that need a position:relative anchor (e.g. for a popover)
// must use `relative inline-flex items-center`, never `inline-block`.
// `inline-flex` blockifies to `flex` (not `block`) as a flex item — a flex
// container lays out its child via flex algorithm, which has no line-box/
// strut concept at all, so the wrapped button ends up pixel-identical to a
// bare span in the same row. `StatusPillButton` below is the button itself
// only (no anchor) so it can sit inside such a wrapper alongside sibling
// popover markup — see Lesson.tsx's RevisionPill for the pattern.

import type { CSSProperties, ReactNode } from 'react';

/** Shared inline styles for every pill in this family — border color/text
 *  color are the only per-instance values (each pill's semantic color). */
export const PILL_STYLE_BASE: CSSProperties = {
  padding: '2px 8px',
  borderRadius: '999px',
  fontSize: '10px',
  lineHeight: '14px',
  gap: '6px',
};

export const PILL_CLASSNAME =
  'inline-flex items-center border tracking-[0.04em] uppercase font-medium';

/** Same dot markup/size every pill in the family uses (w-1.5 h-1.5 = 6px). */
function PillDot({ color }: { color: string }) {
  return (
    <span
      className="w-1.5 h-1.5 rounded-full"
      style={{ background: color, flexShrink: 0 }}
    />
  );
}

/** Non-interactive pill — LessonStatusBadge, RevisedFlag. */
export function StatusPill({
  color,
  children,
  title,
}: {
  color: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      className={PILL_CLASSNAME}
      style={{ ...PILL_STYLE_BASE, borderColor: color, color }}
      title={title}
    >
      <PillDot color={color} />
      {children}
    </span>
  );
}

/** Interactive pill button — RevisionPill. Just the button (no position
 *  anchor) so a caller that needs to anchor a popover next to it can wrap
 *  it in `<span className="relative inline-flex items-center">` alongside
 *  the popover markup as a sibling — see the header comment above for why
 *  `inline-flex items-center` is load-bearing there and must never be
 *  swapped back to `inline-block`. */
export function StatusPillButton({
  color,
  children,
  onClick,
}: {
  color: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={PILL_CLASSNAME}
      style={{ ...PILL_STYLE_BASE, borderColor: color, color }}
    >
      <PillDot color={color} />
      {children}
    </button>
  );
}
