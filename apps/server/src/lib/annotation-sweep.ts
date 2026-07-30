// Annotation orphan sweep (batch D;
// extended to documents in 批G, item 3).
//
// Call sites:
//   1. POST /pairs/:pairId/annotations/sweep-orphans (routes/annotations.ts)
//      — the exposed "普查" for one pair's whole set, across every lesson/
//      document it touches.
//   2. update_lesson's post-write hook (MCP tool + PATCH /lessons/:id) — a
//      single lesson just changed content, re-check only its own rows.
//   3. 批G: a document's content update (MCP update_document + PATCH
//      /documents/:id) — same "just this host" re-check, see
//      sweepDocumentAnnotations below.
//
// Re-anchoring uses the disambiguation core ported in
// annotation-anchor-match.ts (see that file's header for what's a faithful
// port vs. an approximation). `orphaned_at` is re-derived every sweep, not a
// one-way ratchet — a row that resolves again (e.g. a revision reverted)
// un-orphans back to null, matching the 金缮条款's "status, not a verdict"
// framing.
//
// Documents don't page (brief §4 — continuous scroll is the point): every
// document-hosted row's page_index is always 0, and its "page" is the whole
// content_md, NOT content_md run through splitLessonPages — that splitter
// looks for `---` horizontal-rule lines to find lesson page breaks, which is
// exactly the wrong thing to do to an arbitrary pasted report (a `---`
// section divider in someone's Markdown would wrongly fragment it). So
// sweepRows below takes pre-split `pages: string[]` rather than a raw
// content string + doing the splitting itself — lesson callers pass
// `splitLessonPages(content)`, document callers pass `[content_md]`
// (single-element — one page, always index 0).

import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { lesson_annotations, lessons, documents, type LessonAnnotationRow } from '../db/schema';
import { anchorResolves, splitLessonPages } from './annotation-anchor-match';

export interface SweepSummary {
  /** Rows examined. */
  swept: number;
  /** Rows whose orphaned_at is now non-null (includes ones already orphaned). */
  orphaned: number;
  /** Rows whose orphaned_at is now null (includes ones already fine). */
  resolved: number;
}

/** Re-anchors a set of annotations against `pages` (pre-split — see file
 *  header) and writes the verdict. `rows` must all share the same host. */
async function sweepRows(
  rows: LessonAnnotationRow[],
  pages: string[]
): Promise<SweepSummary> {
  const now = new Date();

  let orphaned = 0;
  let resolved = 0;

  for (const row of rows) {
    const pageMarkdown = pages[row.page_index];
    const stillResolves =
      pageMarkdown !== undefined &&
      anchorResolves(pageMarkdown, {
        selected_text: row.selected_text,
        prefix: row.prefix,
        suffix: row.suffix,
      });

    if (stillResolves) {
      resolved++;
      if (row.orphaned_at !== null) {
        await db
          .update(lesson_annotations)
          .set({ orphaned_at: null })
          .where(eq(lesson_annotations.id, row.id));
      }
    } else {
      orphaned++;
      if (row.orphaned_at === null) {
        await db
          .update(lesson_annotations)
          .set({ orphaned_at: now })
          .where(eq(lesson_annotations.id, row.id));
      }
    }
  }

  return { swept: rows.length, orphaned, resolved };
}

function addSummary(a: SweepSummary, b: SweepSummary): SweepSummary {
  return { swept: a.swept + b.swept, orphaned: a.orphaned + b.orphaned, resolved: a.resolved + b.resolved };
}

/** Re-sweep every annotation on a single lesson — the update_lesson post-hook. */
export async function sweepLessonAnnotations(lessonId: string): Promise<SweepSummary> {
  const [lesson] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  if (!lesson) return { swept: 0, orphaned: 0, resolved: 0 };

  const rows = await db
    .select()
    .from(lesson_annotations)
    .where(eq(lesson_annotations.lesson_id, lessonId));
  if (rows.length === 0) return { swept: 0, orphaned: 0, resolved: 0 };

  const pages = lesson.content_markdown != null ? splitLessonPages(lesson.content_markdown) : [];
  return sweepRows(rows, pages);
}

/** 批G: re-sweep every annotation on a single document — the
 *  update_document / PATCH-content post-hook
 *  (mirrors sweepLessonAnnotations above). Documents don't page —
 *  the whole content_md is the one "page" every document-hosted row's
 *  page_index (always 0) resolves against. */
export async function sweepDocumentAnnotations(documentId: string): Promise<SweepSummary> {
  const [document] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!document) return { swept: 0, orphaned: 0, resolved: 0 };

  const rows = await db
    .select()
    .from(lesson_annotations)
    .where(eq(lesson_annotations.document_id, documentId));
  if (rows.length === 0) return { swept: 0, orphaned: 0, resolved: 0 };

  // Single "page" — see file header on why this isn't splitLessonPages(...).
  return sweepRows(rows, [document.content_md]);
}

/** Re-sweep every annotation belonging to a pair, across every lesson AND
 *  document it has touched — the exposed POST
 *  /pairs/:pairId/annotations/sweep-orphans. 批E: free notes (lesson_id and
 *  document_id both null) have no anchor to re-resolve — excluded up front,
 *  never counted as swept/orphaned/resolved either way. */
export async function sweepPairAnnotations(pairId: string): Promise<SweepSummary> {
  const allRows = await db
    .select()
    .from(lesson_annotations)
    .where(eq(lesson_annotations.pair_id, pairId));
  const lessonRows_ = allRows.filter(
    (r): r is LessonAnnotationRow & { lesson_id: string } => r.lesson_id !== null
  );
  const documentRows_ = allRows.filter(
    (r): r is LessonAnnotationRow & { document_id: string } => r.document_id !== null
  );
  if (lessonRows_.length === 0 && documentRows_.length === 0) {
    return { swept: 0, orphaned: 0, resolved: 0 };
  }

  let total: SweepSummary = { swept: 0, orphaned: 0, resolved: 0 };

  if (lessonRows_.length > 0) {
    const lessonIds = Array.from(new Set(lessonRows_.map((r) => r.lesson_id)));
    const lessonRecords = await db.select().from(lessons).where(inArray(lessons.id, lessonIds));
    const contentByLesson = new Map(lessonRecords.map((l) => [l.id, l.content_markdown]));

    const byLesson = new Map<string, LessonAnnotationRow[]>();
    for (const row of lessonRows_) {
      const bucket = byLesson.get(row.lesson_id);
      if (bucket) bucket.push(row);
      else byLesson.set(row.lesson_id, [row]);
    }

    for (const [lessonId, rows] of byLesson) {
      // Lesson deleted out from under its annotations (FK is ON DELETE
      // CASCADE so this shouldn't normally happen mid-loop, but a lesson
      // absent from contentByLesson — e.g. removed between the two queries
      // — is treated as "no content", i.e. every row on it orphans).
      const content = contentByLesson.get(lessonId) ?? null;
      const pages = content != null ? splitLessonPages(content) : [];
      total = addSummary(total, await sweepRows(rows, pages));
    }
  }

  if (documentRows_.length > 0) {
    const documentIds = Array.from(new Set(documentRows_.map((r) => r.document_id)));
    const documentRecords = await db.select().from(documents).where(inArray(documents.id, documentIds));
    const contentByDocument = new Map(documentRecords.map((d) => [d.id, d.content_md]));

    const byDocument = new Map<string, LessonAnnotationRow[]>();
    for (const row of documentRows_) {
      const bucket = byDocument.get(row.document_id);
      if (bucket) bucket.push(row);
      else byDocument.set(row.document_id, [row]);
    }

    for (const [documentId, rows] of byDocument) {
      const content = contentByDocument.get(documentId);
      // Single "page" per document (see file header) — a deleted-out-from-
      // under-it document (absent from contentByDocument) still orphans
      // every row on it, same "no content = every row fails" treatment as
      // the lesson branch above.
      const pages = content != null ? [content] : [];
      total = addSummary(total, await sweepRows(rows, pages));
    }
  }

  return total;
}
