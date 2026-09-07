import type { Flashcard } from '@learn-shell/contracts';

// Read APIs provide authoritative provenance; undefined supports older mocks,
// while null explicitly means the server could not resolve a lesson/course.
export type LocatedFlashcard = Flashcard & {
  lesson_id?: string | null;
  course_id?: string | null;
};

export function cardLessonId(card: LocatedFlashcard, fallback?: string): string | undefined {
  return card.lesson_id === undefined ? fallback : card.lesson_id ?? undefined;
}

export function cardCourseId(card: LocatedFlashcard, fallback?: string): string | undefined {
  return card.course_id === undefined ? fallback : card.course_id ?? undefined;
}

export function isActiveCard(card: Flashcard): boolean {
  return card.activated === true;
}

export function isDueReviewCard(card: Flashcard, nowMs: number): boolean {
  return isActiveCard(card) && card.paused !== true &&
    new Date(card.fsrs_state.due_at).getTime() <= nowMs;
}

// Management retains its complete collection. Review is always the eligible
// subset, including when reached through a course/deck link or rail click.
export function dueReviewCards<T extends Flashcard>(cards: readonly T[], nowMs: number): T[] {
  return cards.filter((card) => isDueReviewCard(card, nowMs)).sort((a, b) =>
    new Date(a.fsrs_state.due_at).getTime() - new Date(b.fsrs_state.due_at).getTime());
}

export function isIndependentCard(card: LocatedFlashcard): boolean {
  if (card.source_status !== undefined) return card.source_status === 'independent';
  return card.concept_id == null && (card.lesson_id === null || card.lesson_id === undefined);
}

export function scopeDueReviewCards<T extends LocatedFlashcard>(
  cards: readonly T[], nowMs: number,
  scope: { lessonId?: string | null; courseId?: string | null; deckId?: string | null },
  fallbackLesson: (card: T) => string | undefined = () => undefined,
  fallbackCourse: (card: T) => string | undefined = () => undefined,
): T[] {
  return dueReviewCards(cards, nowMs).filter((card) => {
    if (scope.lessonId) return cardLessonId(card, fallbackLesson(card)) === scope.lessonId;
    if (scope.courseId) return cardCourseId(card, fallbackCourse(card)) === scope.courseId;
    if (scope.deckId) return card.deck_id === scope.deckId;
    return true;
  });
}
