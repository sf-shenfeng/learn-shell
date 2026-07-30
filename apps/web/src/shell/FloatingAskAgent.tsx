// Stage 7e: AdHoc FAB + floating panel — global right-bottom entry point.
// Stage 7e-detach: floating panel can "detach" into its own popup window.
//
// Popup tracking: the popup window writes a timestamp into localStorage every
// ~3s while alive; main window polls (2s) and treats > 7s gap as "popup dead".
// While popup is alive, main window hides both FAB and panel — the floating
// entry should not coexist with its detached twin.

import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { usePair } from './PairProvider';
import { useT } from '../i18n';
import { useIdentity, cleanAgentName } from '../lib/identity';
import { useAgentBridge } from './useAgentBridge';
import AdHocPanel from './AdHocPanel';

const POPUP_HEARTBEAT_KEY = 'learn-shell:adhoc:popup-alive';
const POPUP_HEARTBEAT_STALE_MS = 7_000;

function isPopupAlive(): boolean {
  try {
    const raw = localStorage.getItem(POPUP_HEARTBEAT_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (Number.isNaN(ts)) return false;
    return Date.now() - ts < POPUP_HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

function openPopupWindow(): Window | null {
  // Centered ~420×580 popup. Browsers may apply min sizes; this is a hint.
  const w = 420;
  const h = 580;
  const left = (window.screenX || 0) + Math.max(0, window.outerWidth - w - 40);
  const top = (window.screenY || 0) + 80;
  const features = [
    `width=${w}`,
    `height=${h}`,
    `left=${left}`,
    `top=${top}`,
    'menubar=no',
    'toolbar=no',
    'location=no',
    'status=no',
    'noopener=no',
  ].join(',');
  return window.open('/adhoc-popup', 'learn-shell-adhoc', features);
}

const DETACH_NOTICE_TTL_MS = 5_000;

export default function FloatingAskAgent() {
  const [open, setOpen] = useState(false);
  const [popupAlive, setPopupAlive] = useState<boolean>(() => isPopupAlive());
  const [detachNotice, setDetachNotice] = useState<string | null>(null);
  const { pairId } = usePair();
  const location = useLocation();
  const { t } = useT();
  // 称谓体系收尾：角标按钮的提示带教师名，identity 未载入回退泛称。
  const { identity } = useIdentity();
  const askLabel = identity?.agent
    ? `${t('adhoc.titlePrefix')}${cleanAgentName(identity.agent.display_name)}`
    : t('floatingAsk.title');
  // Presence dot (2026-07-12): distinguishes agent-online from async on
  // the FAB icon itself, so a left message's fate is legible without opening
  // the panel. See useAgentBridge for the underlying signal.
  const { online } = useAgentBridge();
  const presenceHint = online ? t('floatingAsk.onlineHint') : t('floatingAsk.offlineHint');
  const closedTitle = `${askLabel} · ${presenceHint}`;

  // Poll popup heartbeat. 2s feels responsive without burning CPU.
  useEffect(() => {
    const id = setInterval(() => setPopupAlive(isPopupAlive()), 2_000);
    return () => clearInterval(id);
  }, []);

  // Detach-blocked notice is transient — auto-dismiss after a few seconds
  // (also cleared on next FAB interaction, see the button's onClick below).
  useEffect(() => {
    if (!detachNotice) return;
    const id = setTimeout(() => setDetachNotice(null), DETACH_NOTICE_TTL_MS);
    return () => clearTimeout(id);
  }, [detachNotice]);

  // NB (心跳不关面板守则): never force-close an OPEN panel on popup heartbeat.
  // Chrome throttles background-window timers to ~1/min, so a forgotten
  // popup's heartbeat arrives in pulses — force-closing here unmounted the
  // whole tree mid-typing and ate the learner's draft. The popup only takes
  // over the CLOSED state (FAB suppression below); an open panel is
  // considered actively in use and is left alone.

  const handleDetach = useCallback(() => {
    // Pre-mark "alive" so the FAB hides immediately even before the popup
    // boots and writes its first heartbeat (~500ms gap otherwise).
    try {
      localStorage.setItem(POPUP_HEARTBEAT_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    setPopupAlive(true);
    setOpen(false);
    const popup = openPopupWindow();
    if (!popup) {
      // Browser blocked it — roll back and tell the user via an inline
      // transient notice (native alert() blocks the browser event loop —
      // 违反军规, see 强关面板军规).
      localStorage.removeItem(POPUP_HEARTBEAT_KEY);
      setPopupAlive(false);
      setOpen(true);
      setDetachNotice(t('floatingAsk.detachBlocked'));
    }
  }, [t]);

  if (!pairId) return null;
  // While popup is alive AND the floating panel is closed, suppress the FAB —
  // popup is the canonical surface. An open panel always survives (see note).
  if (popupAlive && !open) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setDetachNotice(null);
        }}
        className="fixed bottom-6 right-6 z-40 w-12 h-12 rounded-full border border-[var(--ls-border-strong)] bg-[var(--ls-panel)] shadow-lg flex items-center justify-center text-[18px] text-[var(--ls-text)] hover:bg-[var(--ls-panel-strong)] transition-colors"
        title={open ? `× ${askLabel}` : closedTitle}
        aria-label={open ? askLabel : closedTitle}
      >
        {open ? '×' : '?'}
        {!open && online && (
          <span
            aria-hidden="true"
            className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full"
            style={{ background: 'var(--ls-corroborated)', boxShadow: '0 0 0 2px var(--ls-panel)' }}
          />
        )}
      </button>

      {detachNotice && (
        <div
          role="status"
          className="fixed bottom-20 right-6 z-50 max-w-[220px] rounded-md border border-[var(--ls-border-strong)] bg-[var(--ls-panel)] px-2.5 py-1.5 text-[11px] leading-4 text-[var(--ls-text-tertiary)] shadow-lg"
        >
          {detachNotice}
        </div>
      )}

      {open && (
        <AdHocPanel
          mode="floating"
          pathname={location.pathname}
          onClose={() => setOpen(false)}
          onDetach={handleDetach}
        />
      )}
    </>
  );
}
