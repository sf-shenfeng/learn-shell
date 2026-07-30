// get_teacher_inbox — Agent Surface Hardening 第一批
// (P1 "给 Agent
// 一条可消费的教师任务流").
//
// No new table, no server-held cursor: every item is derived on read from
// existing tables. `since` is an ISO timestamp the *caller* tracks as its
// own cursor ("消费后推进 cursor" happens client-side) — this
// module is stateless; the two callers (mcp/server.ts's get_teacher_inbox
// tool, routes/read.ts's GET /pairs/:pairId/teacher-inbox) just forward
// whatever `since` they were given, defaulting to the epoch (full backlog)
// when omitted so a first-ever call surfaces everything outstanding rather
// than an arbitrarily-recent empty window.
//
// item_id is deterministic per triggering row/event so re-polling with an
// unmoved (or lagging) cursor returns the *same* id for the *same*
// underlying fact — "同一 item 不会被重复处理" from the brief's acceptance
// bar — rather than minting a fresh id every call.

import { and, eq, gte, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import {
  exercise_submissions,
  exercises,
  lessons,
  courses,
  live_sessions,
  ad_hoc_threads,
  ad_hoc_messages,
  session_events,
  teaching_contracts,
} from '../db/schema';
import { isNewerEventId } from './live-wait';

export type InboxItemType =
  | 'exercise_submitted'
  | 'live_session_needs_reflection'
  | 'adhoc_message'
  | 'again_cluster'
  | 'contract_proposed';

export type InboxPriority = 'low' | 'normal' | 'high';

export interface TeacherInboxItem {
  item_id: string;
  type: InboxItemType;
  priority: InboxPriority;
  resource_refs: string[];
  recommended_tool: string;
  occurred_at: string; // ISO 8601
}

export interface TeacherInbox {
  pair_id: string;
  since: string;
  generated_at: string;
  items: TeacherInboxItem[];
}

const AGAIN_CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000;
const AGAIN_CLUSTER_THRESHOLD = 3;

const PRIORITY_RANK: Record<InboxPriority, number> = { high: 0, normal: 1, low: 2 };

/** Pure — sorts a merged item list by priority (high first), then by
 *  occurred_at ascending (oldest backlog first) within the same priority.
 *  Split out for testability, mirroring currentContract.ts's pure/DB split. */
export function sortInboxItems(items: TeacherInboxItem[]): TeacherInboxItem[] {
  return [...items].sort((a, b) => {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (pr !== 0) return pr;
    return a.occurred_at.localeCompare(b.occurred_at);
  });
}

async function pendingSubmissionItems(pairId: string, since: Date): Promise<TeacherInboxItem[]> {
  const rows = await db
    .select({
      submission_id: exercise_submissions.id,
      exercise_id: exercise_submissions.exercise_id,
      submitted_at: exercise_submissions.submitted_at,
    })
    .from(exercise_submissions)
    .innerJoin(exercises, eq(exercise_submissions.exercise_id, exercises.id))
    .innerJoin(lessons, eq(exercises.lesson_id, lessons.id))
    .innerJoin(courses, eq(lessons.course_id, courses.id))
    .where(
      and(
        eq(courses.pair_id, pairId),
        inArray(exercise_submissions.status, ['submitted', 'pending_grade'])
      )
    );
  return rows
    .filter((r): r is typeof r & { submitted_at: Date } => !!r.submitted_at && r.submitted_at.getTime() > since.getTime())
    .map((r) => ({
      item_id: `inbox_sub_${r.submission_id}`,
      type: 'exercise_submitted' as const,
      priority: 'normal' as const,
      resource_refs: [r.submission_id, r.exercise_id],
      recommended_tool: 'grade_exercise',
      occurred_at: r.submitted_at.toISOString(),
    }));
}

async function liveSessionNeedsReflectionItems(
  pairId: string,
  since: Date
): Promise<TeacherInboxItem[]> {
  const rows = await db
    .select()
    .from(live_sessions)
    .where(and(eq(live_sessions.pair_id, pairId), eq(live_sessions.status, 'completed')));
  return rows
    .filter(
      (r): r is typeof r & { ended_at: Date } =>
        !!r.ended_at &&
        r.ended_at.getTime() > since.getTime() &&
        (!r.teacher_reflection || !r.teacher_reflection.trim())
    )
    .map((r) => ({
      item_id: `inbox_live_${r.id}`,
      type: 'live_session_needs_reflection' as const,
      priority: 'normal' as const,
      resource_refs: [r.id],
      recommended_tool: 'live_session_complete',
      occurred_at: r.ended_at.toISOString(),
    }));
}

/** From an incident report: a learner message that already has an agent
 *  reply sitting after it in the same thread is *answered*, not pending —
 *  the old query only checked `role = 'user' AND created_at > since`, so it
 *  kept listing threads as outstanding forever, even after the agent had
 *  already replied (reproduced on ah_mrfypb14_l5uae9: two already-answered
 *  messages still surfaced as pending). Fetch the *whole* thread history
 *  (not since-filtered — an agent reply can land right at the `since`
 *  boundary and still count) and only surface a user message when no agent
 *  message exists after it. */
async function adhocMessageItems(pairId: string, since: Date): Promise<TeacherInboxItem[]> {
  const threads = await db
    .select({ id: ad_hoc_threads.id, acked_message_id: ad_hoc_threads.acked_message_id })
    .from(ad_hoc_threads)
    .where(and(eq(ad_hoc_threads.pair_id, pairId), isNull(ad_hoc_threads.archived_at)));
  if (threads.length === 0) return [];
  const threadIds = threads.map((t) => t.id);
  const ackedByThread = new Map(threads.map((t) => [t.id, t.acked_message_id] as const));
  const rows = await db
    .select()
    .from(ad_hoc_messages)
    .where(inArray(ad_hoc_messages.thread_id, threadIds));

  const byThread = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byThread.get(r.thread_id) ?? [];
    list.push(r);
    byThread.set(r.thread_id, list);
  }

  const items: TeacherInboxItem[] = [];
  for (const [threadId, msgs] of byThread.entries()) {
    msgs.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    let lastAgentAt = -Infinity;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === 'agent') {
        lastAgentAt = msgs[i]!.created_at.getTime();
        break;
      }
    }
    // 消账游标 (AdHoc 三票并一之三) — a message at or before the thread's
    // acked_message_id is treated as processed even with no agent reply
    // after it. Per-message gate (not "latest message only" like the other
    // two pending scans' isAdhocMessageOutstanding) because this function
    // already walks every unanswered message in the thread, not just the
    // trailing one — so it compares each candidate directly against the
    // cursor via isNewerEventId rather than going through that helper.
    const ackedMessageId = ackedByThread.get(threadId);
    for (const m of msgs) {
      if (m.role !== 'user') continue;
      if (m.created_at.getTime() <= since.getTime()) continue;
      if (m.created_at.getTime() < lastAgentAt) continue; // already answered
      if (ackedMessageId && !isNewerEventId(m.id, ackedMessageId)) continue; // already acked
      items.push({
        item_id: `inbox_adhoc_${m.id}`,
        type: 'adhoc_message' as const,
        priority: 'high' as const,
        resource_refs: [m.thread_id, m.id],
        recommended_tool: 'adhoc_message_send',
        occurred_at: m.created_at.toISOString(),
      });
    }
  }
  return items;
}

/** Near-real-time struggle signal: ≥3 "Again" ratings on the same flashcard
 *  within a trailing 24h window (always relative to `now`, independent of
 *  `since` — this is a rolling cluster detector, not a backlog scan). The
 *  item's identity is pinned to the specific event that crossed the
 *  threshold (the 3rd Again in sorted order) so a 4th/5th Again on the same
 *  card doesn't mint a new item every poll.
 *
 *  Clusters by card_id, not concept_id — session_events' review.rated payload
 *  only carries card_id (see routes/write.ts POST /reviews); resolving to the
 *  card's concept would need an extra join against flashcards, deferred (see
 *  report) since a card is already a reasonable proxy for "this one thing
 *  the learner keeps missing". */
async function againClusterItems(pairId: string, since: Date, now: Date): Promise<TeacherInboxItem[]> {
  const windowStart = new Date(now.getTime() - AGAIN_CLUSTER_WINDOW_MS);
  const rows = await db
    .select({
      event_id: session_events.event_id,
      occurred_at: session_events.occurred_at,
      payload: session_events.payload,
    })
    .from(session_events)
    .where(
      and(
        eq(session_events.pair_id, pairId),
        eq(session_events.event_type, 'review.rated'),
        gte(session_events.occurred_at, windowStart)
      )
    );

  const byCard = new Map<string, { event_id: string; occurred_at: Date }[]>();
  for (const r of rows) {
    const payload = r.payload as { rating?: string; card_id?: string } | null;
    if (!payload || payload.rating !== 'Again' || !payload.card_id) continue;
    const list = byCard.get(payload.card_id) ?? [];
    list.push({ event_id: r.event_id, occurred_at: r.occurred_at });
    byCard.set(payload.card_id, list);
  }

  const items: TeacherInboxItem[] = [];
  for (const [cardId, events] of byCard) {
    if (events.length < AGAIN_CLUSTER_THRESHOLD) continue;
    events.sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
    const trigger = events[AGAIN_CLUSTER_THRESHOLD - 1]!;
    if (trigger.occurred_at.getTime() <= since.getTime()) continue;
    items.push({
      item_id: `inbox_again_${trigger.event_id}`,
      type: 'again_cluster',
      priority: 'high',
      resource_refs: [cardId],
      recommended_tool: 'get_learner_brief',
      occurred_at: trigger.occurred_at.toISOString(),
    });
  }
  return items;
}

async function proposedContractItems(pairId: string, since: Date): Promise<TeacherInboxItem[]> {
  const rows = await db
    .select()
    .from(teaching_contracts)
    .where(and(eq(teaching_contracts.pair_id, pairId), eq(teaching_contracts.setup_status, 'proposed')));
  return rows
    .filter((r) => r.created_at.getTime() > since.getTime())
    .map((r) => ({
      item_id: `inbox_contract_${r.id}`,
      type: 'contract_proposed' as const,
      priority: 'low' as const,
      resource_refs: [r.id],
      recommended_tool: 'adhoc_message_send',
      occurred_at: r.created_at.toISOString(),
    }));
}

export async function buildTeacherInbox(pairId: string, sinceIso: string | undefined): Promise<TeacherInbox> {
  const since = sinceIso ? new Date(sinceIso) : new Date(0);
  const now = new Date();
  const [subs, live, adhoc, again, contracts] = await Promise.all([
    pendingSubmissionItems(pairId, since),
    liveSessionNeedsReflectionItems(pairId, since),
    adhocMessageItems(pairId, since),
    againClusterItems(pairId, since, now),
    proposedContractItems(pairId, since),
  ]);
  return {
    pair_id: pairId,
    since: since.toISOString(),
    generated_at: now.toISOString(),
    items: sortInboxItems([...subs, ...live, ...adhoc, ...again, ...contracts]),
  };
}
