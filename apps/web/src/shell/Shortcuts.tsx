import { useEffect } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useNavigate } from 'react-router-dom';

/**
 * Global keyboard shortcuts (design pattern: G+key for jumps, ⌘K for palette).
 *
 *   G L → /lesson
 *   G R → /review
 *   G C → /cards
 *   G D → /documents (批G Reading — 门牌;
 *         reuses the 'd' slot freed by Dashboard's own nav-entry removal,
 *         Dashboard 裁撤案)
 *   G P → toggle Pool drawer (卡池抽屉化 二期: was /pool, now a summon-able
 *         drawer — see apps/web/src/pool/PoolDrawer.tsx)
 *   G N → toggle Notes drawer (批F: "我的笔记" 抽屉化, 与 Pool 同级同逻辑 —
 *         见 apps/web/src/journal/NotesDrawer.tsx)
 *   G J → /sessions (Documents 改名案: was G S — "Sessions" mnemonic is a leftover
 *         from before this route became Journal; pages/Sessions.tsx now just
 *         re-exports JournalPage. G S has no live claimant, retired clean.)
 *   G Q → /quiz
 *   G M → /mindmap
 *   G , → /settings
 *   ⌘K / Ctrl+K → toggle command palette (handled in CommandPalette.tsx)
 *
 * react-hotkeys-hook handles sequence-style chords with our own debounce.
 */

interface ShortcutsProps {
  onTogglePalette: () => void;
  onTogglePool: () => void;
  onToggleNotes: () => void;
}

export default function Shortcuts({ onTogglePalette, onTogglePool, onToggleNotes }: ShortcutsProps) {
  const navigate = useNavigate();

  // Cmd/Ctrl + K — palette toggle.
  useHotkeys(
    'meta+k, ctrl+k',
    (e) => {
      e.preventDefault();
      onTogglePalette();
    },
    { enableOnFormTags: true }
  );

  // ? — show shortcut cheatsheet (W2 will land overlay; W1 stub palette)
  useHotkeys('shift+/', () => {
    onTogglePalette();
  });

  // G+key sequences. Use a small reducer instead of hotkeys-hook's sequence
  // (which has poor reset semantics in our test).
  useEffect(() => {
    let pendingG = false;
    let pendingTimer: number | null = null;

    const reset = () => {
      pendingG = false;
      if (pendingTimer !== null) {
        window.clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    };

    const onKey = (e: KeyboardEvent) => {
      // Don't hijack typing in inputs/textareas/contenteditable.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (pendingG) {
        const key = e.key.toLowerCase();

        // P is special-cased: it toggles the Pool drawer in place rather
        // than navigating (卡池抽屉化 二期 — Pool is no longer a route).
        if (key === 'p') {
          e.preventDefault();
          onTogglePool();
          reset();
          return;
        }

        // N likewise toggles the Notes drawer in place (批F — notes never
        // had a route of their own to begin with, same "not a navigation
        // target" reasoning as Pool above).
        if (key === 'n') {
          e.preventDefault();
          onToggleNotes();
          reset();
          return;
        }

        // 证书化 (2026-07-08): 'G T' → /contract 摘掉 — 页面不再是常驻导航
        // 目的地 (Contract 页职能死了，签好的合同活在 Settings
        // 的证书区块)。/contract/:id 只从"待签之约"入口点进，不需要一个
        // 盲打的全局快捷键。
        const map: Record<string, string> = {
          l: '/lesson',
          r: '/review',
          c: '/cards',
          d: '/documents',
          j: '/sessions',
          q: '/quiz',
          m: '/mindmap',
          ',': '/settings',
        };
        const dest = map[key];
        if (dest) {
          e.preventDefault();
          navigate(dest);
        }
        reset();
        return;
      }

      if (e.key.toLowerCase() === 'g') {
        pendingG = true;
        pendingTimer = window.setTimeout(reset, 1500);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      reset();
    };
  }, [navigate, onTogglePool, onToggleNotes]);

  return null;
}
