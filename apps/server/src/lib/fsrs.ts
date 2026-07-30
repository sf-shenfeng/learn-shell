// Real FSRS scheduling via ts-fsrs — replaces the hardcoded fsrs_state
// stand-in. Our stored FSRSState is a projection of the full ts-fsrs Card;
// optional fields (state/lapses/scheduled_days) round-trip when present and
// are approximated for legacy cards that predate this module.

import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card,
  type Grade,
} from 'ts-fsrs';
import type { FSRSState } from '@learn-shell/contracts';

const f = fsrs(generatorParameters({ enable_fuzz: false }));

export type ReviewRatingLabel = 'Again' | 'Hard' | 'Good' | 'Easy';

const RATING_MAP: Record<ReviewRatingLabel, Grade> = {
  Again: Rating.Again,
  Hard: Rating.Hard,
  Good: Rating.Good,
  Easy: Rating.Easy,
};

function toCard(state: FSRSState, now: Date): Card {
  const card = createEmptyCard(state.last_review_at ? new Date(state.last_review_at) : now);
  card.due = new Date(state.due_at);
  card.stability = state.stability;
  card.difficulty = state.difficulty;
  card.reps = state.review_count;
  card.lapses = state.lapses ?? 0;
  card.last_review = state.last_review_at ? new Date(state.last_review_at) : undefined;
  card.scheduled_days = state.scheduled_days ?? 0;
  card.state =
    state.state !== undefined
      ? (state.state as State)
      : state.review_count === 0
        ? State.New
        : State.Review;
  return card;
}

/** 考纲登记簿 — `FSRSState.retrievability`
 * is a snapshot taken at `last_review_at` time (see `applyRating` below); it
 * does NOT decay as real time passes without a review. Syllabus decay needs
 * the *current* retrievability (elapsed days since last review keep eating
 * into it), so this recomputes live off ts-fsrs's forgetting curve using the
 * stored due/stability/last_review_at — same `toCard` reconstruction
 * `applyRating` uses, just without advancing the schedule.
 * Never-reviewed cards (last_review_at null) have no elapsed-time decay to
 * apply yet — their stored `retrievability` (1, from `newCardState`) is
 * already correct, so this returns it as-is rather than reconstructing a
 * card with no review history. */
export function currentRetrievability(state: FSRSState, now: Date = new Date()): number {
  if (!state.last_review_at) return state.retrievability;
  const card = toCard(state, now);
  return f.get_retrievability(card, now, false);
}

export function applyRating(
  prev: FSRSState,
  rating: ReviewRatingLabel,
  now: Date = new Date()
): FSRSState {
  const { card } = f.next(toCard(prev, now), now, RATING_MAP[rating]);
  return {
    due_at: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    last_review_at: now.toISOString(),
    review_count: card.reps,
    retrievability: f.get_retrievability(card, now, false),
    state: card.state,
    lapses: card.lapses,
    scheduled_days: card.scheduled_days,
  };
}

/** Initial state for a freshly authored card — due immediately. */
export function newCardState(now: Date = new Date()): FSRSState {
  const card = createEmptyCard(now);
  return {
    due_at: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    last_review_at: null,
    review_count: 0,
    retrievability: 1,
    state: card.state,
    lapses: 0,
    scheduled_days: 0,
  };
}
