// Canonical card provenance and lesson eligibility. Read-only: never changes FSRS or paused.
import { isFlashcardInReviewQueue } from './flashcard-activation';
import { and, asc, eq } from 'drizzle-orm';
import type { DbClient } from '../db/client';
import { concepts, courses, flashcards, lessons, lesson_progress, live_sessions } from '../db/schema';

export interface CardSource {
  id: string;
  lesson_id: string;
  course_id: string;
  flashcard_ids: string[] | null;
}
interface ProjectableCard { id: string; concept_id: string | null; activated?: boolean | null }

/** A valid forward link wins. Only a missing forward link may use an exact,
 * unique reverse reference. Tags/deck titles never establish provenance. */
export function projectFlashcards<T extends ProjectableCard>(
  cards: T[], sources: CardSource[], completedLessonIds: ReadonlySet<string>
) {
  const forward = new Map(sources.map((s) => [s.id, s]));
  const reverse = new Map<string, CardSource[]>();
  for (const source of sources) {
    for (const id of new Set(source.flashcard_ids ?? [])) {
      reverse.set(id, [...(reverse.get(id) ?? []), source]);
    }
  }
  return cards.map((card) => {
    const candidates = reverse.get(card.id) ?? [];
    const source = card.concept_id
      ? forward.get(card.concept_id)
      : candidates.length === 1 ? candidates[0] : undefined;
    const unresolved = Boolean(card.concept_id) || candidates.length > 1;
    return {
      ...card,
      concept_id: source?.id ?? card.concept_id,
      lesson_id: source?.lesson_id ?? null,
      course_id: source?.course_id ?? null,
      source_status: source ? 'course' as const : unresolved ? 'unresolved' as const : 'independent' as const,
      // Course activation is objective eligibility, not a manual override.
      // Paused is the user's persistent opt-out; independent cards retain their setting.
      activated: source ? completedLessonIds.has(source.lesson_id)
        : unresolved ? false : card.activated !== false,
    };
  });
}

export async function getFlashcardContext(db: DbClient, pairId: string) {
  const [sources, progress, live] = await Promise.all([
    db.select({ id: concepts.id, lesson_id: lessons.id, course_id: lessons.course_id,
      flashcard_ids: concepts.flashcard_ids }).from(concepts)
      .innerJoin(lessons, eq(lessons.id, concepts.lesson_id))
      .innerJoin(courses, eq(courses.id, lessons.course_id))
      .where(eq(courses.pair_id, pairId)),
    db.select({ lesson_id: lesson_progress.lesson_id, state: lesson_progress.state })
      .from(lesson_progress).where(eq(lesson_progress.pair_id, pairId)),
    db.select({ lesson_id: live_sessions.context_id }).from(live_sessions)
      .where(and(eq(live_sessions.pair_id, pairId), eq(live_sessions.context_type, 'lesson'),
        eq(live_sessions.status, 'completed'))),
  ]);
  const completed = new Set<string>([
    ...progress.filter((p) => p.state === 'completed_declared' || p.state === 'closed').map((p) => p.lesson_id),
    ...live.map((l) => l.lesson_id),
  ]);
  return { sources, completed };
}

export async function getProjectedFlashcards(db: DbClient, pairId: string) {
  const [cards, { sources, completed }] = await Promise.all([
    db.select().from(flashcards).where(eq(flashcards.pair_id, pairId)).orderBy(asc(flashcards.created_at)),
    getFlashcardContext(db, pairId),
  ]);
  return projectFlashcards(cards, sources, completed);
}

export async function activatedForNewFlashcard(db: DbClient, pairId: string, conceptId?: string | null) {
  if (!conceptId?.trim()) return false;
  const { sources, completed } = await getFlashcardContext(db, pairId);
  return projectFlashcards([{ id: '', concept_id: conceptId }], sources, completed)[0]!.activated;
}

/** Shared by REST and the MCP due resource, including deterministic due order. */
export async function getDueFlashcards(db: DbClient, pairId: string, nowMs = Date.now()) {
  return (await getProjectedFlashcards(db, pairId))
    .filter((card) => isFlashcardInReviewQueue(card, nowMs))
    .sort((a, b) => new Date(a.fsrs_state.due_at).getTime() - new Date(b.fsrs_state.due_at).getTime());
}
