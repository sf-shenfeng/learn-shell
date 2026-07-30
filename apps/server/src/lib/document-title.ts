// deriveDocumentTitle — batch G.
//
// "frontmatter 取 title（有则用，无则首个 H1，再无则文件名/首行截断）" — this
// is the single source of truth for that rule, called from every write path
// that can omit an explicit title: POST /documents (paste/upload) and the MCP
// add_document tool. No YAML dependency in this repo (checked server + web
// package.json) — frontmatter here only ever needs one scalar key
// (`title: ...`), so a hand-rolled line scan is enough; a full YAML parser
// would be overkill for that one field (same "don't add a dep for something
// this small" call annotation/anchor.ts's header already made).

const FIRST_LINE_MAX = 80;

function stripFrontmatter(src: string): { body: string; frontmatter: string | null } {
  const lines = src.split('\n');
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === '') start++;
  if (start >= lines.length || lines[start]!.trim() !== '---') {
    return { body: src, frontmatter: null };
  }
  for (let i = start + 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i]!)) {
      return {
        body: lines.slice(i + 1).join('\n'),
        frontmatter: lines.slice(start + 1, i).join('\n'),
      };
    }
  }
  // Opened a frontmatter block but never closed it — treat the whole thing
  // as body rather than guessing where it would have ended.
  return { body: src, frontmatter: null };
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function frontmatterTitle(frontmatter: string): string | null {
  const m = frontmatter.match(/^title:\s*(.+)$/m);
  if (!m) return null;
  const v = unquote(m[1]!);
  return v.length > 0 ? v : null;
}

function firstH1(body: string): string | null {
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1]!.trim();
  }
  return null;
}

function firstNonEmptyLine(body: string): string | null {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function filenameToTitle(filename: string): string {
  return filename.replace(/\.(md|txt)$/i, '').trim();
}

/** frontmatter title → first H1 → filename (sans extension) → first
 *  non-empty line (truncated). Never returns an empty string — falls back
 *  to a fixed placeholder only if content_md is entirely blank and no
 *  filename was given (paste-an-empty-textarea edge case). */
export function deriveDocumentTitle(content_md: string, filename?: string | null): string {
  const { body, frontmatter } = stripFrontmatter(content_md);
  if (frontmatter) {
    const t = frontmatterTitle(frontmatter);
    if (t) return truncate(t, FIRST_LINE_MAX);
  }
  const h1 = firstH1(body);
  if (h1) return truncate(h1, FIRST_LINE_MAX);
  if (filename && filenameToTitle(filename).length > 0) {
    return truncate(filenameToTitle(filename), FIRST_LINE_MAX);
  }
  const firstLine = firstNonEmptyLine(body);
  if (firstLine) return truncate(firstLine, FIRST_LINE_MAX);
  return 'Untitled document';
}
