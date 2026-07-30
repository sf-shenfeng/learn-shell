// Stage 7e-detach: the route the detached AdHoc panel popup window loads.
//
// Lives at `/adhoc-popup` (hoisted ABOVE AppShell — no sidebar / topnav).
// Heartbeats into localStorage so the main window's FAB stays hidden;
// clears the heartbeat on unload so the main FAB reappears.
//
// Cross-window state sync: free. Mock backend persists to localStorage
// (same origin), HTTP backend hits the same /api endpoints. React Query
// 1.5s refetch in AdHocPanel surfaces messages typed in either window
// without extra wiring.

import { useEffect } from 'react';
import PairProvider from '../shell/PairProvider';
import AdHocPanel from '../shell/AdHocPanel';

const POPUP_HEARTBEAT_KEY = 'learn-shell:adhoc:popup-alive';

function usePopupHeartbeat() {
  useEffect(() => {
    const beat = () => {
      try {
        localStorage.setItem(POPUP_HEARTBEAT_KEY, String(Date.now()));
      } catch {
        /* ignore quota/privacy */
      }
    };
    const clear = () => {
      try {
        localStorage.removeItem(POPUP_HEARTBEAT_KEY);
      } catch {
        /* ignore */
      }
    };
    beat();
    const id = setInterval(beat, 3_000);
    window.addEventListener('beforeunload', clear);
    window.addEventListener('pagehide', clear);
    return () => {
      clearInterval(id);
      window.removeEventListener('beforeunload', clear);
      window.removeEventListener('pagehide', clear);
      clear();
    };
  }, []);
}

export default function AdHocPopupPage() {
  usePopupHeartbeat();

  return (
    <PairProvider>
      {/* Popup mode: no AppShell, no router context tied to a learning page.
          context_snapshot.page defaults to 'dashboard' (= chitchat mode);
          user can switch to a learning page in the main window if they want
          the message indexed. */}
      <AdHocPanel
        mode="popup"
        pathname="/adhoc-popup"
        onClose={() => window.close()}
      />
    </PairProvider>
  );
}
