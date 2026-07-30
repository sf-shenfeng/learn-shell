// Stage 7e: AdHoc panel — reusable in both 'floating' (fixed bubble on
// AppShell) and 'popup' (its own browser window) modes.
//
// Brief alignment (ADHOC-INTERACTION-BRIEF):
//   - One pair = one long-living thread, get-or-create lazily
//   - Per-message context_snapshot inferred from current pathname
//   - is_learning_related decided by page route
//   - Rich payload rendered sandboxed + "实时生成 · 未经验证" badge

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AdHocContextSnapshot,
  AdHocMessage,
  AdHocPayload,
  AdHocThread,
  AdHocThreadFullView,
} from '@learn-shell/contracts';
import { useRepository } from '../repository';
import { usePair } from './PairProvider';
import { useT } from '../i18n';
import { useIdentity, cleanAgentName } from '../lib/identity';
import { useAgentBridge } from './useAgentBridge';

const LEARNING_PAGES = new Set([
  'lesson',
  'card',
  'cards',
  'mindmap',
  'review',
  'quiz',
]);

function inferContext(pathname: string): {
  page: AdHocContextSnapshot['page'];
  is_learning_related: boolean;
} {
  const seg = pathname.split('/').filter(Boolean)[0] ?? 'dashboard';
  const normalized = seg === 'courses' ? 'lesson' : seg;
  const page = (
    [
      'lesson',
      'card',
      'mindmap',
      'quiz',
      'dashboard',
      'review',
      'sessions',
      'settings',
      'contract',
    ] as const
  ).includes(normalized as never)
    ? (normalized as AdHocContextSnapshot['page'])
    : 'dashboard';
  return { page, is_learning_related: LEARNING_PAGES.has(page) };
}

function genClientId() {
  return `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---- floating-mode position (persisted + draggable) -----------------------

const PANEL_W = 380;
const PANEL_H = 520;
const POS_KEY = 'learn-shell:adhoc:panel-pos';
const DEFAULT_OFFSET = { right: 24, bottom: 96 };

function readStoredPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v.x === 'number' && typeof v.y === 'number') return v;
  } catch {
    /* ignore */
  }
  return null;
}

function clampToViewport(x: number, y: number) {
  const maxX = Math.max(8, window.innerWidth - PANEL_W - 8);
  const maxY = Math.max(8, window.innerHeight - PANEL_H - 8);
  return {
    x: Math.min(Math.max(8, x), maxX),
    y: Math.min(Math.max(8, y), maxY),
  };
}

function defaultPos(): { x: number; y: number } {
  return clampToViewport(
    window.innerWidth - PANEL_W - DEFAULT_OFFSET.right,
    window.innerHeight - PANEL_H - DEFAULT_OFFSET.bottom
  );
}

// ---- component -------------------------------------------------------------

export type AdHocPanelMode = 'floating' | 'popup';

export interface AdHocPanelProps {
  mode: AdHocPanelMode;
  /** Pathname used to infer context_snapshot. */
  pathname: string;
  /** Floating: collapse the bubble. Popup: window.close() the window. */
  onClose: () => void;
  /** Floating-only: pop out to its own browser window. */
  onDetach?: () => void;
}

export default function AdHocPanel({ mode, pathname, onClose, onDetach }: AdHocPanelProps) {
  const { pairId } = usePair();
  const repo = useRepository();
  const qc = useQueryClient();
  const { t } = useT();
  // 称谓体系收尾：面板标题带教师名（"问〈教师名〉"/"Ask 〈教师名〉"），identity 未载入时回退泛称。
  const { identity } = useIdentity();
  const agentName = identity?.agent ? cleanAgentName(identity.agent.display_name) : null;
  const panelTitle = agentName ? `${t('adhoc.titlePrefix')}${agentName}` : t('adhoc.title');

  // Thread.
  const threadQuery = useQuery<AdHocThread | null>({
    queryKey: ['adhoc', 'thread', pairId],
    queryFn: () =>
      pairId && repo ? repo.getOrCreateAdHocThread(pairId) : Promise.resolve(null),
    enabled: !!pairId && !!repo,
    staleTime: 30_000,
  });
  // Messages.
  const fullView = useQuery<AdHocThreadFullView | null>({
    queryKey: ['adhoc', 'fullView', threadQuery.data?.id],
    queryFn: () =>
      threadQuery.data && repo
        ? repo.getAdHocThreadFullView(threadQuery.data.id)
        : Promise.resolve(null),
    enabled: !!threadQuery.data && !!repo,
    refetchInterval: 1500,
  });
  const messages = fullView.data?.messages ?? [];
  // Waiting-for-reply indicator (待回复指示案): purely derived from the message
  // list — no new API, no fake "typing" event. True whenever the thread's
  // trailing message is from the user and no agent reply has landed yet,
  // regardless of whether that's because the POST is in flight or because
  // the agent just hasn't answered yet (including across remounts/reloads).
  const awaitingReply = messages.length > 0 && messages[messages.length - 1]!.role === 'user';
  // Async awareness (2026-07-12): while the agent bridge is offline, the
  // "thinking" animation is a lie — nobody's turn loop is running. Swap it
  // for a flat, one-time delivery receipt instead.
  const { online: agentOnline } = useAgentBridge();

  const sendMut = useMutation({
    mutationFn: async (content: string) => {
      if (!threadQuery.data || !repo) throw new Error('no thread');
      const ctx = inferContext(pathname);
      return repo.appendAdHocMessage({
        thread_id: threadQuery.data.id,
        role: 'user',
        content,
        context_snapshot: { page: ctx.page },
        is_learning_related: ctx.is_learning_related,
        client_message_id: genClientId(),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['adhoc', 'fullView'] });
    },
  });

  // Archive thread (隐私清理案 privacy cleanup). On success, both the thread
  // and full-view queries are invalidated — get-or-create then lazily opens
  // a brand-new thread (archived ones are excluded from that lookup), so
  // the panel naturally lands back on an empty "还没说过话" state.
  const archiveMut = useMutation({
    mutationFn: async () => {
      if (!threadQuery.data || !repo) throw new Error('no thread');
      return repo.archiveAdHocThread(threadQuery.data.id);
    },
    onSuccess: () => {
      setManageOpen(false);
      setArchiveConfirming(false);
      qc.invalidateQueries({ queryKey: ['adhoc', 'thread', pairId] });
      qc.invalidateQueries({ queryKey: ['adhoc', 'fullView'] });
    },
  });

  const [manageOpen, setManageOpen] = useState(false);
  const [archiveConfirming, setArchiveConfirming] = useState(false);
  const manageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!manageOpen) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (manageRef.current && !manageRef.current.contains(e.target as Node)) {
        setManageOpen(false);
        setArchiveConfirming(false);
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [manageOpen]);

  const [draft, setDraft] = useState('');
  const ctx = useMemo(() => inferContext(pathname), [pathname]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Stick-to-bottom tracking: only auto-scroll when the user was already
  // near the bottom (or just sent a message themselves). A manual scroll-up
  // flips this to false and stays false through subsequent poll refreshes,
  // so the view no longer fights the user's own scrolling (滚动不抢权案).
  const isNearBottomRef = useRef(true);
  const BOTTOM_THRESHOLD_PX = 40;
  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
  };

  // Floating-only: draggable + persisted position.
  const [pos, setPos] = useState<{ x: number; y: number }>(() =>
    mode === 'floating'
      ? readStoredPos()
        ? clampToViewport(readStoredPos()!.x, readStoredPos()!.y)
        : defaultPos()
      : { x: 0, y: 0 }
  );
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    pointerId: number;
  } | null>(null);

  useEffect(() => {
    if (mode !== 'floating') return;
    const onResize = () => setPos((p) => clampToViewport(p.x, p.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mode]);

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode !== 'floating') return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: pos.x,
      originY: pos.y,
      pointerId: e.pointerId,
    };
  };
  const onHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const next = clampToViewport(
      d.originX + (e.clientX - d.startX),
      d.originY + (e.clientY - d.startY)
    );
    setPos(next);
  };
  const onHeaderPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {
      /* ignore quota/privacy */
    }
  };

  // Stick to bottom on new messages — but only if the user was already
  // near the bottom. If they've scrolled up to read history, leave their
  // scroll position alone (滚动不抢权案).
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && isNearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, fullView.isFetching]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sendMut.isPending) return;
    setDraft('');
    // Sending a message always returns focus to the bottom, even if the
    // user had scrolled up.
    isNearBottomRef.current = true;
    sendMut.mutate(text);
  };

  // Container layout depends on mode.
  const wrapperClass =
    mode === 'floating'
      ? 'fixed z-40 w-[380px] h-[520px] flex flex-col rounded-xl border border-[var(--ls-border-strong)] bg-[var(--ls-bg)] shadow-2xl overflow-hidden'
      : 'fixed inset-0 flex flex-col bg-[var(--ls-bg)] overflow-hidden';
  const wrapperStyle = mode === 'floating' ? { left: pos.x, top: pos.y } : undefined;
  const headerClass =
    mode === 'floating'
      ? 'flex-none flex items-center justify-between px-3.5 py-2.5 border-b border-[var(--ls-border)] bg-[var(--ls-panel)] cursor-grab active:cursor-grabbing select-none touch-none'
      : 'flex-none flex items-center justify-between px-4 py-3 border-b border-[var(--ls-border)] bg-[var(--ls-panel)]';

  return (
    <div role="dialog" aria-label={panelTitle} className={wrapperClass} style={wrapperStyle}>
      {/* Header — drag in floating mode only */}
      <div
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
        className={headerClass}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--ls-corroborated)]" />
          <span className="text-[13px] font-medium leading-5">{panelTitle}</span>
          <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)] truncate">
            {mode === 'popup' ? (
              t('adhoc.detached')
            ) : (
              <>
                {t('adhoc.contextPrefix')}
                <code className="font-mono">{ctx.page}</code>
                {!ctx.is_learning_related && t('adhoc.offTopicSuffix')}
              </>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <div ref={manageRef} className="relative" onPointerDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => {
                setManageOpen((v) => !v);
                setArchiveConfirming(false);
              }}
              className="text-[13px] text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)] leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--ls-panel-strong)]"
              aria-label={t('adhoc.manageThread')}
              aria-haspopup="menu"
              aria-expanded={manageOpen}
              title={t('adhoc.manageThread')}
            >
              ⋯
            </button>
            {manageOpen && (
              <div
                role="menu"
                className="absolute right-0 top-8 z-50 w-44 rounded-md border border-[var(--ls-border-strong)] bg-[var(--ls-panel)] shadow-2xl py-1"
              >
                {!archiveConfirming ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setArchiveConfirming(true)}
                    disabled={!threadQuery.data}
                    className="w-full text-left px-3 py-1.5 text-[12px] text-[var(--ls-text)] hover:bg-[var(--ls-panel-strong)] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {t('adhoc.archiveThread')}
                  </button>
                ) : (
                  <div className="px-3 py-1.5 space-y-1.5">
                    <div className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]">
                      {t('adhoc.archiveConfirmBody')}
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => archiveMut.mutate()}
                        disabled={archiveMut.isPending}
                        className="text-[11px] uppercase tracking-[0.06em] font-medium disabled:opacity-40"
                        style={{ color: 'var(--ls-risk)' }}
                      >
                        {t('adhoc.confirmArchive')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setArchiveConfirming(false)}
                        className="text-[11px] uppercase tracking-[0.06em] text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)]"
                      >
                        {t('adhoc.cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          {mode === 'floating' && onDetach && (
            <button
              type="button"
              onClick={onDetach}
              className="text-[13px] text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)] leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--ls-panel-strong)]"
              aria-label={t('adhoc.detachAriaLabel')}
              title={t('adhoc.detachTitle')}
            >
              ⇱
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-[16px] text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)] leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--ls-panel-strong)]"
            aria-label={mode === 'popup' ? t('adhoc.closeWindow') : t('adhoc.closePanel')}
            title={mode === 'popup' ? t('adhoc.closeWindow') : t('adhoc.closePanel')}
          >
            ×
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className={
          mode === 'floating'
            ? 'flex-1 overflow-y-auto px-3.5 py-3 space-y-3 bg-[var(--ls-bg)]'
            : 'flex-1 overflow-y-auto px-6 py-6 space-y-3 bg-[var(--ls-bg)] mx-auto w-full max-w-[760px]'
        }
      >
        {threadQuery.isLoading && (
          <div className="text-[12px] text-[var(--ls-text-tertiary)]">{t('adhoc.loadingThread')}</div>
        )}
        {!threadQuery.isLoading && messages.length === 0 && (
          <div className="text-[12px] text-[var(--ls-text-tertiary)]">
            {t('adhoc.empty')}
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {awaitingReply && agentOnline && (
          <div className="flex items-center" style={{ gap: '8px', paddingLeft: '2px' }}>
            <span className="inline-flex items-center" style={{ gap: '4px' }}>
              <AdHocDot delay="0ms" />
              <AdHocDot delay="180ms" />
              <AdHocDot delay="360ms" />
            </span>
            <span className="text-[11px] text-[var(--ls-text-tertiary)]">{t('adhoc.thinking')}</span>
          </div>
        )}
        {awaitingReply && !agentOnline && (
          <div className="text-[11px] text-[var(--ls-text-tertiary)]" style={{ paddingLeft: '2px' }}>
            {t('adhoc.deliveredAsync')}
          </div>
        )}
      </div>

      {/* Input */}
      <form
        onSubmit={onSubmit}
        className={
          mode === 'floating'
            ? 'flex-none flex items-end gap-2 px-3 py-2.5 border-t border-[var(--ls-border)] bg-[var(--ls-panel)]'
            : 'flex-none flex items-end gap-2 px-6 py-4 border-t border-[var(--ls-border)] bg-[var(--ls-panel)]'
        }
      >
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            const el = e.target;
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 320) + 'px';
          }}
          onKeyDown={(e) => {
            // IME composition guard: don't let Enter-to-confirm-candidate
            // (pinyin, etc.) fall through and trigger a send.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSubmit(e as unknown as React.FormEvent);
            }
          }}
          rows={mode === 'popup' ? 2 : 1}
          placeholder={t('adhoc.inputPlaceholder')}
          className={
            mode === 'floating'
              ? 'flex-1 resize-none bg-[var(--ls-bg)] border border-[var(--ls-border)] rounded-md px-2.5 py-1.5 text-[13px] leading-5 focus:outline-none focus:border-[var(--ls-border-strong)] max-h-[320px] overflow-y-auto'
              : 'flex-1 resize-none bg-[var(--ls-bg)] border border-[var(--ls-border)] rounded-md px-3 py-2 text-[14px] leading-6 focus:outline-none focus:border-[var(--ls-border-strong)] max-h-[320px] overflow-y-auto mx-auto max-w-[700px]'
          }
        />
        <button
          type="submit"
          disabled={!draft.trim() || sendMut.isPending}
          className="flex-none px-3 py-1.5 rounded-md bg-[var(--ls-text)] text-[var(--ls-bg)] text-[12px] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t('adhoc.send')}
        </button>
      </form>
    </div>
  );
}

// Live Teaching's awaiting=agent footer (Lesson.tsx `LiveDot`) uses this
// same three-dot staggered-pulse language — reproduced here (not imported;
// Lesson/Live components are read-only reference per the AdHoc build brief)
// so the floating panel's waiting indicator stays visually consistent
// app-wide (待回复指示案).
function AdHocDot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block animate-pulse"
      style={{
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: 'var(--ls-text-tertiary)',
        animationDelay: delay,
      }}
    />
  );
}

function MessageBubble({ message }: { message: AdHocMessage }) {
  const repo = useRepository();
  const qc = useQueryClient();
  const { t } = useT();
  const isUser = message.role === 'user';
  const align = isUser ? 'justify-end' : 'justify-start';
  const bubbleColor = isUser
    ? 'bg-[var(--ls-text)] text-[var(--ls-bg)]'
    : 'bg-[var(--ls-panel)] text-[var(--ls-text)] border border-[var(--ls-border)]';

  // Rich-content expand (消息展开案): default compact, toggle to a much
  // larger in-panel render area. State lives here (not in RichPayload)
  // because expanding also needs to widen the bubble past its normal
  // max-w-[85%] cap.
  const [payloadExpanded, setPayloadExpanded] = useState(false);
  const canExpandPayload = !!message.payload && message.payload.component_type !== 'tts_audio';

  // Per-message delete (隐私清理案). Inline confirm — no window.confirm.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteMut = useMutation({
    mutationFn: async () => {
      if (!repo) throw new Error('no repo');
      await repo.deleteAdHocMessage(message.id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['adhoc', 'fullView'] });
    },
  });

  const deleteControl = (
    <MessageDeleteControl
      confirming={confirmingDelete}
      pending={deleteMut.isPending}
      onRequest={() => setConfirmingDelete(true)}
      onCancel={() => setConfirmingDelete(false)}
      onConfirm={() => deleteMut.mutate()}
    />
  );

  return (
    <div className={`group/msg flex items-start gap-1 ${align}`}>
      {!isUser && deleteControl}
      <div
        className={`rounded-2xl px-3 py-2 ${bubbleColor} space-y-2 ${
          canExpandPayload && payloadExpanded ? 'w-full max-w-full' : 'max-w-[85%]'
        }`}
      >
        {message.content && (
          <div className="text-[13px] leading-5 whitespace-pre-wrap break-words">
            {message.content}
          </div>
        )}
        {message.payload && (
          <RichPayload
            payload={message.payload}
            expanded={payloadExpanded}
            onToggleExpanded={() => setPayloadExpanded((v) => !v)}
          />
        )}
        <div className="flex items-center gap-1.5 text-[10px] leading-3 opacity-60">
          {message.role === 'agent' && message.payload && (
            <span className="px-1.5 py-[1px] rounded border border-current">
              {t('adhoc.liveUnverified')}
            </span>
          )}
          {!message.is_learning_related && (
            <span className="px-1.5 py-[1px] rounded">{t('adhoc.notRecorded')}</span>
          )}
        </div>
      </div>
      {isUser && deleteControl}
    </div>
  );
}

function MessageDeleteControl({
  confirming,
  pending,
  onRequest,
  onCancel,
  onConfirm,
}: {
  confirming: boolean;
  pending: boolean;
  onRequest: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useT();
  if (confirming) {
    return (
      <div className="flex-none flex items-center gap-1.5 pt-1.5 text-[10px] uppercase tracking-[0.06em] whitespace-nowrap">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="font-medium disabled:opacity-40"
          style={{ color: 'var(--ls-risk)' }}
        >
          {t('adhoc.delete')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
        >
          {t('adhoc.cancel')}
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onRequest}
      aria-label={t('adhoc.deleteMessage')}
      title={t('adhoc.deleteMessage')}
      className="flex-none mt-1.5 opacity-0 group-hover/msg:opacity-100 transition-opacity text-[13px] leading-none w-5 h-5 flex items-center justify-center rounded text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] hover:bg-[var(--ls-panel-strong)]"
    >
      ×
    </button>
  );
}

function RichPayload({
  payload,
  expanded,
  onToggleExpanded,
}: {
  payload: AdHocPayload;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { t } = useT();
  // Expand/collapse control (消息展开案): small uppercase-label button,
  // matching the panel's existing chrome (see header buttons above).
  // Not offered for tts_audio — the audio bar is already full-size.
  const expandToggle =
    payload.component_type === 'tts_audio' ? null : (
      <button
        type="button"
        onClick={onToggleExpanded}
        className="text-[10px] uppercase tracking-[0.08em] font-medium text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] leading-none"
      >
        {expanded ? t('adhoc.collapse') : t('adhoc.expand')}
      </button>
    );

  switch (payload.component_type) {
    case 'interactive_html':
      return (
        <div className="space-y-1">
          <iframe
            srcDoc={payload.body}
            sandbox="allow-scripts"
            className={
              expanded
                ? 'w-full h-[420px] rounded border border-current bg-white'
                : 'w-full h-48 rounded border border-current bg-white'
            }
            title={t('adhoc.interactiveWidgetTitle')}
          />
          {expandToggle}
        </div>
      );
    case 'whiteboard_svg':
      return (
        <div className="space-y-1">
          <div
            className={
              expanded
                ? 'w-full max-h-[420px] overflow-auto rounded border border-current bg-white text-black'
                : 'w-full max-h-64 overflow-hidden rounded border border-current bg-white text-black'
            }
            dangerouslySetInnerHTML={{ __html: payload.body }}
          />
          {expandToggle}
        </div>
      );
    case 'tts_audio':
      return (
        <audio controls className="w-full">
          <source src={payload.body} />
        </audio>
      );
    default:
      return null;
  }
}
