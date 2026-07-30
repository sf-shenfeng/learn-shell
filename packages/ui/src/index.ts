// @learn-shell/ui
//
// Design tokens + base components.
// Token values per design ARCHITECTURE.md (2026-06-28 first pass).
// Components land progressively in Phase C as page-by-page visual swap proceeds.

export const UI_VERSION = '0.1.0';

// Theme management — apps/web wires this to a Settings panel.
export type Theme = 'light' | 'dark' | 'system';

export function applyTheme(next: Theme, doc: Document = document): void {
  const root = doc.documentElement;
  if (next === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = prefersDark ? 'dark' : 'light';
    root.dataset.themeMode = 'system';
  } else {
    root.dataset.theme = next;
    root.dataset.themeMode = next;
  }
}

export function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem('ls-theme');
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

export function setStoredTheme(next: Theme): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem('ls-theme', next);
}
