/**
 * Kbd — shared keyboard-shortcut chip.
 *
 * Extracted from RecentRail.tsx's PoolRow `<kbd>` (卡池常驻行案), whose
 * bordered-chip look is the app-wide standard for shortcut
 * hints. Every other inline `<kbd>` across the shell (AppShell nav rows,
 * CommandPalette items, PoolDrawer/NotesDrawer headers, AnnotationPill's
 * `H` hint, Mindmap's hotkey cheat sheet + inspector hint) gets swapped to
 * this one component so the dialect can't drift again.
 *
 * Combo keys (e.g. "G C", "Shift+↵") render as a single chip holding the
 * whole label — that's how PoolRow/NotesRow ("G P"/"G N") and Mindmap's
 * "Shift+↵" already did it before this pass; kept as the one answer
 * site-wide rather than splitting into adjacent per-key chips.
 */

import type { ReactNode } from 'react';

export default function Kbd({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={className}
      style={{
        fontSize: '10px',
        lineHeight: '14px',
        padding: '0 4px',
        borderRadius: '4px',
        border: '1px solid var(--ls-border)',
        color: 'var(--ls-text-tertiary)',
      }}
    >
      {children}
    </kbd>
  );
}
