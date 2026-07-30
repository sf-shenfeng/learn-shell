// Heading extraction + slugging — Reading page's H2/H3 sidebar anchor nav
// ("标题侧栏做最小版").
//
// No rehype-slug in this repo (checked apps/web/package.json) — same
// "hand-roll rather than add a dep for one small thing" call
// apps/web/src/annotation/anchor.ts's header already makes for its own
// anchor algorithm. `extractHeadings` below is the single source of truth
// for both halves of the feature: the sidebar list AND the ids the rendered
// headings carry (via remarkHeadingIds.ts, which consumes this same ordered
// array rather than re-deriving slugs itself — the two must never disagree
// on what a heading's anchor id is).
//
// ATX headings only (`## Text`) — Setext style (`Text\n---`) isn't detected.
// Flagged as a known gap in the batch report: south wind's research reports
// are expected to use ATX (matches the house lesson-authoring convention),
// so this isn't expected to bite in practice, but it's a real limitation if
// a pasted document uses Setext H1/H2.

const FENCE_RE = /^(```|~~~)/;
const ATX_HEADING_RE = /^(#{2,3})\s+(.+?)\s*#*\s*$/;

export interface DocHeading {
  level: 2 | 3;
  text: string;
  slug: string;
}

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

// Strip the common inline-emphasis/code/link markdown syntax from a heading's
// text before slugging/display — a heading like "## **Risk** factors" should
// slug from "Risk factors", not "**risk**-factors". Best-effort, same
// approximation trade-off apps/server/src/lib/annotation-anchor-match.ts's
// markdownToPlainText documents for its own (different) purpose.
function cleanHeadingText(raw: string): string {
  return raw
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    .trim();
}

/** GitHub-ish slugify: lowercase, unicode letters/numbers/dash/underscore
 *  survive (keeps CJK headings — learner reports are often Chinese —
 *  meaningfully sluggable instead of collapsing to empty), everything else
 *  becomes a dash, runs collapse, leading/trailing dashes trimmed. */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\-_\s]+/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Extracts every H2/H3 in document order, frontmatter and fenced code
 *  excluded, with GitHub-style dedup (first occurrence plain, repeats get
 *  `-1`, `-2`, …). Empty slug (e.g. a heading that's pure punctuation/emoji)
 *  falls back to `section-<n>` so every heading still gets a stable, unique
 *  anchor. */
export function extractHeadings(markdown: string): DocHeading[] {
  const body = stripFrontmatter(markdown);
  const lines = body.split('\n');

  const headings: DocHeading[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  let anonCounter = 0;

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = line.match(ATX_HEADING_RE);
    if (!m) continue;
    const level = m[1]!.length as 2 | 3;
    const text = cleanHeadingText(m[2]!);
    if (!text) continue;

    let base = slugifyHeading(text);
    if (!base) base = `section-${++anonCounter}`;

    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const slug = count === 0 ? base : `${base}-${count}`;

    headings.push({ level, text, slug });
  }

  return headings;
}
