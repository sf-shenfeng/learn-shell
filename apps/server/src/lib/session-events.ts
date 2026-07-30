// Learning-session event recording — the write path that makes
// learning_sessions / session_events live tables instead of seed-only.
//
// Sessions are resolved lazily: the latest open session (ended_at null,
// last activity within SESSION_GAP_MS) is reused; otherwise a new one is
// opened. Every append bumps event_count and rolls up cards/concepts.
//
// Agent Surface Hardening 第一批 ("其余多步写入路径
// 顺手排查, 同病同治"): several call sites do
// [primary write] + appendSessionEvent as two separate statements with no
// transaction around them — a crash between the two leaves a write with no
// corresponding event, or an event with no backing write reachable. Every
// exported function here now takes an optional `dbClient` (defaults to the
// module-level pool) so a caller can pass a `db.transaction(tx => ...)`
// handle and get both statements committed atomically. See
// routes/write.ts's POST /reviews and POST /submissions* for the callers
// that now do this.

import { and, desc, eq, isNull } from 'drizzle-orm';
import { db, type DbClient } from '../db/client';
import { learning_sessions, session_events, learner_agent_pairs } from '../db/schema';
import type {
  ActorType,
  LearningSessionMode,
  SessionEventType,
} from '@learn-shell/contracts';

const SESSION_GAP_MS = 30 * 60 * 1000;

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface AppendEventInput {
  pair_id: string;
  event_type: SessionEventType;
  actor_type: ActorType;
  /** Explicit actor id; when omitted, resolved from the pair record
   *  (learner → learner_id, agent → agent_id, system → 'system'). */
  actor_id?: string;
  payload: Record<string, unknown>;
  mode?: LearningSessionMode;
  card_id?: string;
  concept_ids?: string[];
  course_ref?: string;
  occurred_at?: Date;
}

async function resolveActorId(
  pairId: string,
  actorType: ActorType,
  dbClient: DbClient
): Promise<string> {
  if (actorType === 'system') return 'system';
  const [pair] = await dbClient
    .select()
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.id, pairId))
    .limit(1);
  if (!pair) return actorType;
  return actorType === 'learner' ? pair.learner_id : pair.agent_id;
}

async function resolveOpenSession(
  pairId: string,
  mode: LearningSessionMode | undefined,
  now: Date,
  dbClient: DbClient
): Promise<string> {
  const [latest] = await dbClient
    .select()
    .from(learning_sessions)
    .where(and(eq(learning_sessions.pair_id, pairId), isNull(learning_sessions.ended_at)))
    .orderBy(desc(learning_sessions.started_at))
    .limit(1);

  if (latest) {
    const [lastEvent] = await dbClient
      .select()
      .from(session_events)
      .where(eq(session_events.session_id, latest.id))
      .orderBy(desc(session_events.occurred_at))
      .limit(1);
    const lastActivity = lastEvent?.occurred_at ?? latest.started_at;
    if (now.getTime() - lastActivity.getTime() < SESSION_GAP_MS) {
      return latest.id;
    }
    // Stale open session — close it at its last activity, start fresh.
    await dbClient
      .update(learning_sessions)
      .set({ ended_at: lastActivity })
      .where(eq(learning_sessions.id, latest.id));
  }

  const id = genId('ls');
  await dbClient.insert(learning_sessions).values({
    id,
    pair_id: pairId,
    started_at: now,
    mode: mode ?? null,
  });
  return id;
}

/** `dbClient` defaults to the module-level pool; pass a `db.transaction(tx =>
 *  ...)` handle to fold this append into a caller's own transaction (see file
 *  header). */
export async function appendSessionEvent(
  input: AppendEventInput,
  dbClient: DbClient = db
): Promise<string> {
  const now = input.occurred_at ?? new Date();
  const sessionId = await resolveOpenSession(input.pair_id, input.mode, now, dbClient);
  const actorId = input.actor_id ?? (await resolveActorId(input.pair_id, input.actor_type, dbClient));

  await dbClient.insert(session_events).values({
    event_id: genId('evt'),
    pair_id: input.pair_id,
    session_id: sessionId,
    event_type: input.event_type,
    actor_type: input.actor_type,
    actor_id: actorId,
    recorded_by: 'server',
    occurred_at: now,
    permission_state: 'authorized',
    payload: input.payload,
  });

  const [session] = await dbClient
    .select()
    .from(learning_sessions)
    .where(eq(learning_sessions.id, sessionId))
    .limit(1);
  if (session) {
    const cards = new Set(session.cards_reviewed);
    if (input.card_id) cards.add(input.card_id);
    const concepts = new Set(session.concepts_touched);
    for (const c of input.concept_ids ?? []) concepts.add(c);
    const courses = new Set(session.course_refs);
    if (input.course_ref) courses.add(input.course_ref);
    await dbClient
      .update(learning_sessions)
      .set({
        event_count: session.event_count + 1,
        cards_reviewed: [...cards],
        concepts_touched: [...concepts],
        course_refs: [...courses],
        // keep mode of first meaningful event if session opened without one
        mode: session.mode ?? input.mode ?? null,
      })
      .where(eq(learning_sessions.id, sessionId));
  }

  return sessionId;
}
