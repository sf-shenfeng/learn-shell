// Flashcard Markdown batch import — Obsidian 写卡 → LS 渲染 (2026-07-08).
//
// This module is the *parser* only: plain text in, structured cards +
// line-numbered errors out. No DB access here — the import route
// (routes/write.ts POST /pairs/:pairId/flashcards/import) owns dedup against
// existing DB rows and the actual insert/update decisions. Kept pure so it's
// trivially unit-testable (flashcard-import.test.ts) without a database.
//
// Expected input shape (as authored in Obsidian, plain text template):
//
//   #deck 固收
//   Q: What does duration measure?
//   A: Price sensitivity to yield changes.
//   can span multiple lines, until the next Q: / #deck / EOF.
//
//   Q: ...
//   A: ...
//
//   #deck 权益
//   Q: ...
//   A: ...

export interface ParsedFlashcard {
  deck: string;
  front: string;
  back: string;
  /** 1-indexed line number of this card's `Q:` marker — surfaced in the
   *  import preview so errors/rows can be traced back to the source file. */
  line: number;
}

export interface FlashcardImportParseError {
  line: number;
  message: string;
}

export interface FlashcardImportParseResult {
  cards: ParsedFlashcard[];
  errors: FlashcardImportParseError[];
}

/**
 * Dedup key normalization for a card face — trim + collapse any run of
 * whitespace (including internal newlines) to a single space. The import
 * route uses this (scoped per-deck) to match a parsed card's front against
 * existing DB rows and against other cards in the same import batch.
 */
export function normalizeCardFace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

const DECK_RE = /^#deck\s+(.+)$/;
const Q_RE = /^Q:\s?(.*)$/;
const A_RE = /^A:\s?(.*)$/;

interface CardInProgress {
  /** null while no #deck section has been opened yet, or the section header
   *  itself had an empty name — the orphan case (`#deck 前的 Q/A`). */
  deck: string | null;
  qLine: number;
  mode: 'front' | 'back';
  frontLines: string[];
  backLines: string[];
}

/**
 * Parse the Obsidian flashcard markdown template into structured cards.
 * Never throws on malformed input — unparseable spans are recorded as
 * line-numbered errors and parsing continues; everything that *can* be
 * parsed is still returned.
 */
export function parseFlashcardMarkdown(content: string): FlashcardImportParseResult {
  const cards: ParsedFlashcard[] = [];
  const errors: FlashcardImportParseError[] = [];

  // Normalize line endings (tolerate CRLF / lone CR) and strip trailing
  // whitespace per line (tolerate trailing spaces on Q:/A:/#deck lines).
  const lines = content.split(/\r\n|\r|\n/).map((l) => l.replace(/[ \t]+$/, ''));

  let currentDeck: string | null = null;
  let building: CardInProgress | null = null;

  function flush(): void {
    if (!building) return;
    const b = building;
    building = null;
    if (b.deck === null) {
      // Orphan card (no #deck section) — the error was already recorded
      // when the `Q:` line was first seen; nothing more to do (and nowhere
      // to file the card even if it did get an `A:`).
      return;
    }
    if (b.mode === 'front') {
      errors.push({ line: b.qLine, message: 'Q has no matching A' });
      return;
    }
    cards.push({
      deck: b.deck,
      front: b.frontLines.join('\n').trim(),
      back: b.backLines.join('\n').trim(),
      line: b.qLine,
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i]!;

    const deckMatch = DECK_RE.exec(line);
    if (deckMatch) {
      flush();
      currentDeck = deckMatch[1]!.trim();
      continue;
    }

    const qMatch = Q_RE.exec(line);
    if (qMatch) {
      flush();
      if (currentDeck === null) {
        errors.push({ line: lineNo, message: 'Q: with no #deck section (orphan card)' });
      }
      building = {
        deck: currentDeck,
        qLine: lineNo,
        mode: 'front',
        frontLines: [qMatch[1]!],
        backLines: [],
      };
      continue;
    }

    const aMatch = A_RE.exec(line);
    if (aMatch) {
      if (!building) {
        errors.push({ line: lineNo, message: 'A: with no preceding Q:' });
        continue;
      }
      if (building.mode === 'front') {
        building.mode = 'back';
        building.backLines = [aMatch[1]!];
      } else {
        // Already collecting a back — a second "A:" line before the next
        // Q:/#deck is unusual input. The template only allows one A: per
        // card, so treat it as literal continuation text rather than
        // inventing a new marker semantic.
        building.backLines.push(line);
      }
      continue;
    }

    // Plain content line — belongs to whichever section is open (multi-line
    // Q:/A: continuation), or is silently ignored if no card is active
    // (blank lines / stray text between cards or before the first #deck).
    if (building) {
      if (building.mode === 'front') building.frontLines.push(line);
      else building.backLines.push(line);
    }
  }

  flush();

  return { cards, errors };
}
