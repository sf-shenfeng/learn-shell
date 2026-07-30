// Lesson paging — splits paged-lesson markdown into pages.
//
// Format contract: docs/LESSON-BLOCKS-v1.md §1.
//   - top-level `---` (outside code fences and ::: containers) = page break
//   - each page opens with a `::kicker[NAME]` leaf line (extracted here,
//     rendered by the pager chrome, never by the markdown renderer)
//   - lessons authored before paging have no ::kicker — callers use
//     `isPaged()` to fall back to the legacy single-scroll renderer.

export interface LessonPage {
  kicker: string | null;
  markdown: string;
}

const KICKER_RE = /^::kicker\[([^\]]+)\]\s*$/;
const FENCE_RE = /^(```|~~~)/;
const DIRECTIVE_OPEN_RE = /^:{3,}\s*\S/;
const DIRECTIVE_CLOSE_RE = /^:{3,}\s*$/;
const PAGE_BREAK_RE = /^-{3,}\s*$/;
const TRIAL_OPEN_RE = /^:{3,}\s*trial\b/;

/** Remove YAML frontmatter if the document starts with a `---` block. */
export function stripFrontmatter(src: string): string {
  const lines = src.split('\n');
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === '') start++;
  if (start >= lines.length || lines[start]!.trim() !== '---') return src;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i]!)) {
      return lines.slice(i + 1).join('\n');
    }
  }
  return src;
}

/** Split lesson markdown into pages on top-level `---` lines. */
export function splitPages(src: string): LessonPage[] {
  const body = stripFrontmatter(src);
  const lines = body.split('\n');

  const rawPages: string[][] = [];
  let current: string[] = [];
  let inFence = false;
  let directiveDepth = 0;

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && DIRECTIVE_OPEN_RE.test(line) && !KICKER_RE.test(line)) {
      directiveDepth++;
      current.push(line);
      continue;
    }
    if (!inFence && directiveDepth > 0 && DIRECTIVE_CLOSE_RE.test(line)) {
      directiveDepth--;
      current.push(line);
      continue;
    }
    if (!inFence && directiveDepth === 0 && PAGE_BREAK_RE.test(line)) {
      rawPages.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  rawPages.push(current);

  return rawPages
    .map((pageLines) => {
      let kicker: string | null = null;
      const kept: string[] = [];
      for (const line of pageLines) {
        const m = KICKER_RE.exec(line);
        if (m && kicker === null) {
          kicker = m[1]!.trim().toUpperCase();
          continue;
        }
        kept.push(line);
      }
      return { kicker, markdown: kept.join('\n').trim() };
    })
    .filter((p) => p.markdown.length > 0 || p.kicker !== null);
}

/** A lesson is "paged" when at least one page carries a kicker. */
export function isPaged(pages: LessonPage[]): boolean {
  return pages.some((p) => p.kicker !== null);
}

// ---- auto-pagination fallback for free markdown (自动分页兜底案) ----
//
// A naive agent can still write straight prose through add_lesson (server-
// side write validation, apps/server/src/mcp/server.ts's validateLessonContent,
// rejects *new* writes shaped like this — but it can't retroactively fix
// whatever already landed in the DB before that gate existed, and rejection
// isn't retroactive repair anyway). Before this fallback, such a lesson had
// no `::kicker` anywhere → `isPaged()` was false → PagedLesson fell back to
// one long single-scroll render: exactly the "一整屏滚动+格式破碎" bug this
// fallback exists to close. Rather than leave that renderer path in
// place, `getDisplayPages()` below turns it into synthetic pages instead —
// split on real heading structure when the document has any (h2 preferred,
// h3 next), or on paragraph groups as a last resort — so even a badly
// shaped lesson is still readable as a deck instead of a waterfall. Legally
// paged lessons (`isPaged()` true) are untouched; this only ever engages for
// content this renderer would otherwise have shown as one long scroll.

const H2_ONLY_RE = /^##(?!#)\s+\S/;
const H3_ONLY_RE = /^###(?!#)\s+\S/;

/** How many blank-line-separated paragraphs make up one synthetic page when
 *  the document has no heading structure at all to split on. */
const PARAGRAPH_GROUP_SIZE = 4;

function isBlankChunk(lines: string[]): boolean {
  return lines.every((l) => l.trim() === '');
}

/** Fence-aware count of top-level lines matching `headingRe` (headings
 *  inside fenced code don't count) — used by `refineOversizedChunk` to
 *  decide whether an h2 chunk has enough h3 substructure to split further. */
function countHeadings(lines: string[], headingRe: RegExp): number {
  let count = 0;
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && headingRe.test(line)) count++;
  }
  return count;
}

/** Fence-aware split of `lines` into chunks, each starting right at a line
 *  matching `headingRe` (top-level only — headings inside fenced code are
 *  ignored). Content before the first match becomes a leading chunk (kept
 *  only if non-blank — e.g. a lone `# Title` line becomes its own short
 *  cover page rather than an empty one). Returns `null` when `headingRe`
 *  never matches (nothing to split on at this heading level) or matches
 *  only once (a single split point isn't a paging structure). */
function chunkByHeading(lines: string[], headingRe: RegExp): string[][] | null {
  const chunks: string[][] = [];
  let current: string[] = [];
  let inFence = false;
  let headingCount = 0;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && headingRe.test(line)) {
      headingCount++;
      if (!isBlankChunk(current)) chunks.push(current);
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (!isBlankChunk(current)) chunks.push(current);
  if (headingCount < 2) return null;
  return chunks;
}

/** Last-resort split when the document has no usable heading structure:
 *  group blank-line-separated paragraphs (fence-aware) into fixed-size
 *  chunks of `groupSize`. Never returns an empty array — a document with no
 *  blank lines at all just becomes its own single chunk. */
function chunkByParagraphs(lines: string[], groupSize: number): string[][] {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && line.trim() === '' && current.length > 0) {
      paragraphs.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) paragraphs.push(current);
  if (paragraphs.length === 0) return [lines];

  const chunks: string[][] = [];
  for (let i = 0; i < paragraphs.length; i += groupSize) {
    chunks.push(paragraphs.slice(i, i + groupSize).flat());
  }
  return chunks;
}

function toAutoPages(chunks: string[][]): LessonPage[] {
  return chunks
    .map((c) => ({ kicker: null, markdown: c.join('\n').trim() }))
    .filter((p) => p.markdown.length > 0);
}

// ---- h2→h3 refinement for oversized auto-pages (自动分页兜底案 病二) ----
//
// h2 is the right split granularity for most free markdown, but a single h2
// section can still be a dense vocab/list dump with many h3 sub-entries
// underneath it (e.g. "十个双重身份词" → 10 h3s under one h2) — splitting
// only on h2 leaves that section as one long scroll, exactly the thing
// paging exists to avoid (product axiom: 课文像 PPT 翻页，翻页远好于
// 滚动). So after the h2 split, any h2-chunk that's too dense gets split
// again by its own h3s.

/** Rendered-density threshold, not raw byte count: at the lesson pager's
 *  ~15px/22px prose type scale and 65ch measure (PROSE_CLS in
 *  PagedLesson.tsx), ~1200 chars of markdown body is roughly a full page's
 *  worth of scroll before a reader has to scroll *inside* what's supposed to
 *  be one page. */
const MAX_CHUNK_CHARS = 1200;
/** Second trigger independent of char count: a section can be short per-h3
 *  (e.g. a list of "double role words") yet still read as a marathon once
 *  enough of them are stacked under one h2. */
const MAX_H3_PER_PAGE = 3;

/** If an h2-chunk is oversized by either threshold *and* has ≥2 h3s inside
 *  it (a single h3 isn't a split point, same rule chunkByHeading itself
 *  uses), split it by h3 into multiple pages. The h2 heading (and any
 *  intro prose before the first h3) stays on the first sub-page only —
 *  simplest option that doesn't lose the parent heading and doesn't require
 *  threading a repeated-title prop through every auto-page. Otherwise the
 *  chunk passes through unchanged. */
function refineOversizedChunk(lines: string[]): string[][] {
  const h3Count = countHeadings(lines, H3_ONLY_RE);
  if (h3Count < 2) return [lines];
  const chars = lines.join('\n').length;
  if (chars <= MAX_CHUNK_CHARS && h3Count <= MAX_H3_PER_PAGE) return [lines];
  return chunkByHeading(lines, H3_ONLY_RE) ?? [lines];
}

/** Synthetic pages for a document with no legal paging structure at all —
 *  h2 headings first, h3 next, paragraph groups as the fallback. h2 pages
 *  get a further h3 pass when oversized (see refineOversizedChunk above). */
function autoPaginate(body: string): LessonPage[] {
  const lines = body.split('\n');
  const byH2 = chunkByHeading(lines, H2_ONLY_RE);
  if (byH2) return toAutoPages(byH2.flatMap(refineOversizedChunk));
  const byH3 = chunkByHeading(lines, H3_ONLY_RE);
  if (byH3) return toAutoPages(byH3);
  return toAutoPages(chunkByParagraphs(lines, PARAGRAPH_GROUP_SIZE));
}

/** The single entry point PagedLesson should use: legally paged content
 *  passes through unchanged (`autoPaged: false`); anything else — free
 *  markdown, partial/broken paging attempts, whatever slipped past write-time
 *  validation before it existed — gets auto-split so it's still a deck
 *  instead of a scroll (`autoPaged: true`, so the caller can show a low-key
 *  "this was auto-paginated" notice). */
export function getDisplayPages(content: string): { pages: LessonPage[]; autoPaged: boolean } {
  const structPages = splitPages(content);
  if (isPaged(structPages)) return { pages: structPages, autoPaged: false };
  const autoPages = autoPaginate(stripFrontmatter(content));
  // A one-paragraph document has nothing to split into more than one page —
  // still route it through the same synthetic-page shape (kicker: null) so
  // PagedLesson has exactly one code path to render, not two.
  return { pages: autoPages.length > 0 ? autoPages : structPages, autoPaged: true };
}

/** Count top-level `:::trial` container directives in a page's markdown
 *  (fence-aware). §1.2 caps each page at one interactive block, so in
 *  practice this is 0 or 1 — used by PagedLesson to compute each page's
 *  running `trialIndex` offset without
 *  touching the `key={index}` remount mechanics. */
export function countTrialBlocks(markdown: string): number {
  let count = 0;
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && TRIAL_OPEN_RE.test(line)) count++;
  }
  return count;
}
