// Flashcard Markdown import parser — client-side mirror of
// apps/server/src/lib/flashcard-import.ts, used only by MockRepository's
// 'seeded' (localStorage-only, no server) mode so the Cards page import flow
// is exercisable without a live backend.
//
// Deliberately duplicated rather than shared: apps/web can't import
// apps/server's src directly (separate package, nothing exported for it),
// and standing up a new shared package just for this one pure function is
// out of scope for this pass. The real (authoritative) parse — and the only
// one that ever touches the DB — happens server-side in 'live' mode via
// POST /pairs/:pairId/flashcards/import. Keep this in lockstep with the
// server copy if the format ever changes; flashcard-import.test.ts on the
// server side is the source of truth for parsing behavior.

export interface ParsedFlashcard {
  deck: string;
  front: string;
  back: string;
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

export function normalizeCardFace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

const DECK_RE = /^#deck\s+(.+)$/;
const Q_RE = /^Q:\s?(.*)$/;
const A_RE = /^A:\s?(.*)$/;

interface CardInProgress {
  deck: string | null;
  qLine: number;
  mode: 'front' | 'back';
  frontLines: string[];
  backLines: string[];
}

export function parseFlashcardMarkdown(content: string): FlashcardImportParseResult {
  const cards: ParsedFlashcard[] = [];
  const errors: FlashcardImportParseError[] = [];

  const lines = content.split(/\r\n|\r|\n/).map((l) => l.replace(/[ \t]+$/, ''));

  let currentDeck: string | null = null;
  let building: CardInProgress | null = null;

  function flush(): void {
    if (!building) return;
    const b = building;
    building = null;
    if (b.deck === null) return;
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
        building.backLines.push(line);
      }
      continue;
    }

    if (building) {
      if (building.mode === 'front') building.frontLines.push(line);
      else building.backLines.push(line);
    }
  }

  flush();

  return { cards, errors };
}
