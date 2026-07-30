// AdHoc Thread (Stage 7d-fix, 2026-06-30).
//
// Sister to LiveSession but with a completely different shape:
//
//   - LiveSession is STRUCTURED teaching: agent-driven turn loop, move
//     types, response_kind validation, REFLECT triple at close.
//   - AdHocThread is FREE conversation: cross-page floating panel,
//     user-driven Q&A, no move taxonomy, no awaiting state machine,
//     no formal "complete" event.
//
// One learner = one long-living AdHocThread (created lazily on first
// open of the floating panel). Threads follow the user across pages,
// across lessons, across days. Per-message context_snapshot pins the
// page-of-origin for that turn so agent can answer with awareness.
//
// LS only persists learning-related messages into SessionEvent (flagged
// by frontend at send time). Chitchat stays in AdHocMessage but does
// not become a session event. See ADHOC-INTERACTION-BRIEF.md §3.

import type { PairId } from './pair';

export type AdHocThreadId = string & { readonly __brand: 'AdHocThreadId' };
export type AdHocMessageId = string & { readonly __brand: 'AdHocMessageId' };

/**
 * Where the learner was when this message was sent. Pinned per-message
 * (not per-thread) because the same thread spans many pages.
 */
export interface AdHocContextSnapshot {
  page:
    | 'lesson'
    | 'card'
    | 'mindmap'
    | 'quiz'
    | 'dashboard'
    | 'review'
    | 'sessions'
    | 'settings'
    | 'contract';
  entity_type?:
    | 'lesson'
    | 'flashcard'
    | 'mindmap'
    | 'mindmap_node'
    | 'quiz_question'
    | 'concept';
  entity_id?: string;
  /** Optional short label for UI ("Equity Risk Premium node", "Card #42"). */
  entity_label?: string;
}

/**
 * Rich-content payload optionally attached to an agent message.
 * Brief §"Ad Hoc 能投递什么": agent can deliver beyond plain text:
 *   - interactive_html : sandboxed inline HTML widget
 *   - whiteboard_svg   : agent-drawn diagram
 *   - tts_audio        : voice playback (future, lang-course case)
 *
 * Frontend MUST badge any rich payload as "实时生成 · 未经验证" —
 * Ad Hoc content has not gone through the verify-skill pipeline.
 */
export type AdHocPayloadType = 'interactive_html' | 'whiteboard_svg' | 'tts_audio';

export interface AdHocPayload {
  component_type: AdHocPayloadType;
  /** Raw body — HTML / SVG / audio URL etc. Renderer interprets by type. */
  body: string;
  /** Optional renderer hints (width, sandbox flags, caption…). */
  hints?: Record<string, unknown>;
}

export interface AdHocThread {
  id: AdHocThreadId;
  pair_id: PairId;
  /** Total message count for cheap UI badging / health hints. */
  message_count: number;
  created_at: string;
  last_activity_at: string;
  /**
   * Set when the learner archives the thread (privacy cleanup).
   * Archived threads are excluded from get-or-create's lookup — the next
   * message starts a fresh thread. Optional/absent on rows written before
   * this field existed.
   */
  archived_at?: string | null;
  /**
   * 消账游标 (AdHoc 三票并一之二, 2026-07-19) — set via MCP tool `adhoc_ack`.
   * Any message at or before this id no longer counts as outstanding in
   * pending/bridge-event scans; the message itself is never deleted.
   * Optional/absent (or null) on rows written before this field existed —
   * behaves identically to "never acked".
   */
  acked_message_id?: AdHocMessageId | null;
}

export interface AdHocMessage {
  id: AdHocMessageId;
  thread_id: AdHocThreadId;
  /** Just who said it; no move-type taxonomy. */
  role: 'user' | 'agent';
  /** Markdown body. Empty allowed when payload carries the content. */
  content: string;
  /** Optional rich-content delivery (agent only — users send text/voice). */
  payload?: AdHocPayload;
  /** Frontend pins this at send time so agent sees where user was. */
  context_snapshot: AdHocContextSnapshot;
  /**
   * Frontend decides at send time (typically by page route): is this
   * message learning-related (writes a SessionEvent for replay/recall)
   * or just chitchat (stays in the thread, never indexed)?
   * Default true for messages from lesson/mindmap/card/review/quiz; default
   * false for messages from settings/dashboard/sessions/contract.
   */
  is_learning_related: boolean;
  /** Client-supplied uuid for idempotency on retries. */
  client_message_id: string;
  created_at: string;
}

/** Combined read used by floating-panel UI + agent pull. */
export interface AdHocThreadFullView {
  thread: AdHocThread;
  messages: AdHocMessage[];
  /**
   * 增量读取游标 (值更契约·低损耗, 2026-07-19) — present when the caller
   * passed `after_message_id` (MCP `adhoc_thread_get` / REST
   * `GET /adhoc/threads/:id?after_message_id=`). `returned_count` = number
   * of messages in this response; `has_earlier` = true when history exists
   * before the cursor that this response omitted (always false on a full,
   * uncursored read).
   */
  returned_count?: number;
  has_earlier?: boolean;
}
