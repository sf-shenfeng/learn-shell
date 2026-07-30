// Flashcard Markdown batch import repository extension (2026-07-08 定案) —
// The learner writes cards in Obsidian with a plain-text `#deck` / `Q:` / `A:`
// template, Cards page imports them.
//
// Deliberately NOT folded into packages/contracts/src/repository.ts — same
// local-additive-interface move as ./simulatedQuiz.ts's SimulatedQuizRepo
// and ./journalExt.ts's JournalRepo: packages/contracts stays read-only this
// pass. Both concrete repos (Mock/Http) implement `Repository &
// FlashcardImportRepo`; callers narrow `useRepository()`'s return type with
// `as (Repository & FlashcardImportRepo) | null`.
//
// Field shapes mirror apps/server/src/routes/write.ts's
// `POST /pairs/:pairId/flashcards/import` response 1:1 (that route defines
// the same shapes locally too, for the same read-only-contracts reason —
// canonicalizing both into a shared contracts type is a follow-up for
// whoever accepts this slice).

import type { PairId } from '@learn-shell/contracts';

export interface FlashcardImportParseError {
  line: number;
  message: string;
}

export interface FlashcardImportPreviewItem {
  front: string;
  back: string;
  /** 1-indexed source line of this card's `Q:` marker. */
  line: number;
  /** Only present on `updated` entries — the back currently stored in the
   *  DB, for a before/after diff. */
  previous_back?: string;
}

export interface FlashcardImportDeckResult {
  new: FlashcardImportPreviewItem[];
  duplicates: FlashcardImportPreviewItem[];
  updated: FlashcardImportPreviewItem[];
}

export interface FlashcardImportResult {
  errors: FlashcardImportParseError[];
  decks: Record<string, FlashcardImportDeckResult>;
  /** Decks referenced by the import that don't have any card yet for this
   *  pair — informational only (decks are derived, no decks table). */
  decks_to_create: string[];
}

export interface FlashcardImportRepo {
  /**
   * Parse (and, when `dry_run` is false, apply) a batch of flashcards from
   * an Obsidian-style Markdown file. `dry_run: true` returns a preview only
   * — nothing is written. The Cards page import modal always fires a
   * dry_run first, then a real (dry_run: false) call once the user
   * confirms the preview.
   */
  importFlashcards(input: {
    pair_id: PairId;
    content: string;
    dry_run: boolean;
  }): Promise<FlashcardImportResult>;
}
