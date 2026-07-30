// Annotation anchor matching — server-side port for the batch D orphan sweep.
//
// 军规服从: the brief requires reusing batch A's disambiguation code rather
// than writing a second one. The real thing (apps/web/src/annotation/anchor.ts
// `resolveAnchor`) resolves a DOM Range against the *rendered* page — that
// needs `Range`/`Text`/`Highlight`, none of which exist in a Node server
// process (no DOM here, no headless renderer wired into this app). What DOES
// port cleanly is the disambiguation core: given a flat string and an
// {selectedText, prefix, suffix} anchor, find every occurrence of
// selectedText and score each by how well its surrounding context matches
// prefix/suffix, declining (null) below the same confidence gate. That part
// of the algorithm has zero DOM dependency in the original — `findBestOffset`
// below is a byte-for-byte port of resolveAnchor's occurrence-scan loop +
// commonPrefixLen/commonSuffixLen, kept in sync by hand with anchor.ts (same
// duplication trade-off apps/web/src/annotation/palette.ts already makes and
// documents for ANNOTATION_COLORS — there is no workspace edge from
// @learn-shell/server to the browser-only web app to import this from).
//
// What's NOT a faithful port: resolveAnchor searches the *rendered* DOM text
// (markdown syntax already stripped, interactive blocks excluded by
// PagedLesson's [data-ls-block] convention). This module only has the raw
// lesson content_markdown to search, so `markdownToPlainText` below is a
// best-effort approximation (strip heading/emphasis/table/link syntax and
// directive containers) — good enough to catch the common case (plain prose
// selections) but not a guarantee against false-orphan on a selection that
// happened to span markdown-syntax characters right at its boundary. Flagged
// in the batch report as the sweep's main accuracy caveat.

export interface TextAnchor {
  selected_text: string;
  prefix: string;
  suffix: string;
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a.charAt(i) === b.charAt(i)) i++;
  return i;
}

function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  while (
    i < a.length &&
    i < b.length &&
    a.charAt(a.length - 1 - i) === b.charAt(b.length - 1 - i)
  ) {
    i++;
  }
  return i;
}

/** Port of anchor.ts's resolveAnchor occurrence-scan — returns the best
 *  matching start offset into `text`, or null when the quote isn't found at
 *  all, or is found more than once with zero disambiguating context (same
 *  confidence gate as the client: "better an explicit orphan than a silent
 *  wrong-highlight guess"). */
export function findBestOffset(text: string, anchor: TextAnchor): number | null {
  if (!anchor.selected_text) return null;

  const occurrences: number[] = [];
  let idx = text.indexOf(anchor.selected_text);
  while (idx !== -1) {
    occurrences.push(idx);
    idx = text.indexOf(anchor.selected_text, idx + 1);
  }
  if (occurrences.length === 0) return null;

  let best = occurrences[0]!;
  let bestScore = -1;
  for (const occ of occurrences) {
    const actualPrefix = text.slice(Math.max(0, occ - anchor.prefix.length), occ);
    const actualSuffix = text.slice(
      occ + anchor.selected_text.length,
      occ + anchor.selected_text.length + anchor.suffix.length
    );
    const score =
      commonSuffixLen(actualPrefix, anchor.prefix) + commonPrefixLen(actualSuffix, anchor.suffix);
    if (score > bestScore) {
      bestScore = score;
      best = occ;
    }
  }

  if (occurrences.length > 1 && bestScore === 0) return null;
  return best;
}

// ---------------------------------------------------------------------------
// Lesson paging (DOM-free — faithful port of apps/web/src/lesson/paging.ts,
// same duplication trade-off noted above; this half of that file has no DOM
// dependency at all, so it's a low-risk copy).
// ---------------------------------------------------------------------------

const KICKER_RE = /^::kicker\[([^\]]+)\]\s*$/;
const FENCE_RE = /^(```|~~~)/;
const DIRECTIVE_OPEN_RE = /^:{3,}\s*\S/;
const DIRECTIVE_CLOSE_RE = /^:{3,}\s*$/;
const PAGE_BREAK_RE = /^-{3,}\s*$/;

function stripFrontmatter(src: string): string {
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

/** Split lesson markdown into per-page raw markdown (kicker lines dropped —
 *  chrome, never part of the searchable text either client or server side). */
export function splitLessonPages(src: string): string[] {
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

  return rawPages.map((pageLines) =>
    pageLines
      .filter((line) => !KICKER_RE.test(line))
      .join('\n')
      .trim()
  );
}

/** Best-effort markdown → plain text (see file-header caveat). Strips the
 *  syntax that's cheap and common to get wrong: emphasis markers, headings,
 *  link/image syntax (kept the visible label), inline code fences, table
 *  pipes, list bullets, and directive open/close lines (:::trial etc. —
 *  their *content* still renders as prose client-side for Callout/CfaNote,
 *  but their opening/closing fence lines never appear as text; TrialBlock's
 *  own question/hint form controls are `[data-ls-block]`-excluded from
 *  anchoring entirely, matching anchor.ts's EXCLUDED_SELECTOR). */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => !DIRECTIVE_OPEN_RE.test(line) && !DIRECTIVE_CLOSE_RE.test(line))
    .join('\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|/gm, '')
    .replace(/\|\s*$/gm, '')
    .replace(/\|/g, ' ');
}

/** True when `anchor` resolves against `pageMarkdown` (approximated plain
 *  text). The single entry point the sweep calls per (annotation, page). */
export function anchorResolves(pageMarkdown: string, anchor: TextAnchor): boolean {
  const text = markdownToPlainText(pageMarkdown);
  return findBestOffset(text, anchor) !== null;
}
