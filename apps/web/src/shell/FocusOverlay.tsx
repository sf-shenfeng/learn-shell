import type { CSSProperties } from 'react';
import { useT } from '../i18n';

/**
 * Focus mode — shared "true fullscreen" escape hatch for Mind Map and
 * Review. 2026-07-02 实机反馈: "我希望 Focus 时能直接进入全屏，让 [canvas]
 * 占据整个页面" — a `position: fixed; inset: 0` overlay ignores AppShell's
 * centred maxWidth:880px column, the sidebar, and the top bar all in one
 * move, regardless of where in the DOM it's mounted (fixed positioning
 * escapes normal layout/scroll ancestors as long as no ancestor sets a
 * `transform`, which AppShell's page column doesn't).
 *
 * zIndex 45 sits above FloatingAskAgent's fixed z-40 corner button (so
 * focus mode is truly the only thing on screen) but below
 * CommandPalette's z-50 (so ⌘K still opens on top while focused).
 *
 * Each page keeps its own `focusMode` boolean — this module only shares
 * the resulting style + the toggle button's visual language, so Mind Map
 * and Review read identically without forcing a shared state machine
 * neither of them needs.
 */
export const FOCUS_Z_INDEX = 45;

export function focusOverlayStyle(focusMode: boolean): CSSProperties | undefined {
  if (!focusMode) return undefined;
  return {
    position: 'fixed',
    inset: 0,
    zIndex: FOCUS_Z_INDEX,
    background: 'var(--ls-bg)',
    display: 'flex',
    flexDirection: 'column',
    padding: '20px 24px 16px',
    overflow: 'hidden',
  };
}

export function FocusToggleButton({
  active,
  onClick,
  activeTitle,
  inactiveTitle,
}: {
  active: boolean;
  onClick: () => void;
  activeTitle: string;
  inactiveTitle: string;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center border font-medium transition-colors duration-[var(--ls-duration-fast)]"
      style={{
        height: '30px',
        padding: '0 12px',
        borderRadius: '6px',
        fontSize: '12px',
        lineHeight: '1',
        background: active ? 'var(--ls-text)' : 'transparent',
        color: active ? 'var(--ls-bg)' : 'var(--ls-text-secondary)',
        borderColor: active ? 'var(--ls-text)' : 'var(--ls-border)',
      }}
      title={active ? activeTitle : inactiveTitle}
    >
      {active ? t('shell.focus.exitLabel') : t('shell.focus.label')}
    </button>
  );
}
