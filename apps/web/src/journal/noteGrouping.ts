// Journal notes drawer — pure grouping/sorting/filtering helpers (batch E,
// 批E items 5/6/7). Kept separate from
// NotesDrawer.tsx (rendering, 批F 起 — was JournalNotesPanel.tsx pre-批F) and
// useJournalNotes.ts (fetch) — this module only ever reshapes an
// already-fetched `JournalNoteEntry[]`, no hooks, no I/O, easy to reason
// about independent of either.

import { ANNOTATION_COLORS, DEFAULT_ANNOTATION_COLOR } from '../annotation/palette';
import type { JournalNoteEntry } from './useJournalNotes';

export type SortMode = 'color' | 'course' | 'time-asc' | 'time-desc';

/** Annotation.color may hold a legacy/unknown key (pre-palette data) — same
 *  fallback useJournalNotes' predecessor used: treat it as the default color
 *  rather than dropping it from every color-keyed view. */
function effectiveColor(entry: JournalNoteEntry): string {
  const known = ANNOTATION_COLORS.some((c) => c.key === entry.annotation.color);
  return known ? entry.annotation.color : DEFAULT_ANNOTATION_COLOR;
}

/** Item 7: full-text search over selected_text + note, item 5: color
 *  filter (empty set = show all). Combine and apply together — the panel
 *  runs this once ahead of whichever grouping/sort mode is active, so the
 *  two "叠加生效" by construction rather than needing separate handling
 *  per view. */
export function filterEntries(
  entries: JournalNoteEntry[],
  opts: { search: string; colors: ReadonlySet<string> }
): JournalNoteEntry[] {
  const q = opts.search.trim().toLowerCase();
  return entries.filter((e) => {
    if (opts.colors.size > 0 && !opts.colors.has(effectiveColor(e))) return false;
    if (q) {
      const haystack = `${e.annotation.selected_text} ${e.annotation.note ?? ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export interface JournalColorGroup {
  key: string;
  hex: string;
  notes: JournalNoteEntry[];
}

/** Default view (颜色即分类学). Groups sort in ANNOTATION_COLORS'
 *  own order; empty groups don't get a seat (卡池抽屉化 判例 extended to color
 *  groups). Free notes participate here exactly like anchored ones — their
 *  color is a real, changeable field same as any other note (item 4). */
export function groupByColor(entries: JournalNoteEntry[]): JournalColorGroup[] {
  return ANNOTATION_COLORS.map(({ key, hex }) => ({
    key,
    hex,
    notes: entries
      .filter((e) => effectiveColor(e) === key)
      .sort((a, b) => new Date(b.annotation.created_at).getTime() - new Date(a.annotation.created_at).getTime()),
  })).filter((g) => g.notes.length > 0);
}

export interface JournalCourseGroup {
  /** courseId::lessonId, doc::documentId, or 'free' for the trailing 自由笔记 bucket. */
  key: string;
  /** Course topic, document title, or the 自由笔记 label for the free bucket
   *  (panel supplies the translated label; this module doesn't own i18n). */
  label: string;
  /** Lesson title for a course-hosted bucket — null for a document bucket
   *  (a document isn't itself sub-grouped by anything) or the free bucket. */
  sublabel: string | null;
  notes: JournalNoteEntry[];
}

/** Item 6 "按课程" (批G: 分组维度泛化为"按宿主" — 课程或文档, brief §5):
 *  groups by course → lesson, OR by document (one flat bucket per
 *  document, no sub-header), ordered by each host's own fetch order
 *  (courseOrderIndex — courses first in `getCourses()` order, documents
 *  after in `getDocuments()` order, see useJournalNotes.ts's offset) then
 *  Lesson.order within a course bucket. Free notes always sort last
 *  (courseOrderIndex = Infinity on every free entry) into one shared
 *  `freeLabel`-titled bucket, never interleaved with real courses/documents. */
export function groupByCourse(entries: JournalNoteEntry[], freeLabel: string): JournalCourseGroup[] {
  const buckets = new Map<string, JournalCourseGroup & { order: [number, number] }>();

  for (const e of entries) {
    const key = e.isFree ? 'free' : e.documentId != null ? `doc::${e.documentId}` : `${e.courseId}::${e.lessonId}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        label: e.isFree ? freeLabel : e.documentId != null ? (e.documentTitle ?? '') : (e.courseTopic ?? ''),
        sublabel: e.isFree || e.documentId != null ? null : e.lessonTitle,
        notes: [],
        order: [e.courseOrderIndex, e.lessonOrder],
      };
      buckets.set(key, bucket);
    }
    bucket.notes.push(e);
  }

  return Array.from(buckets.values())
    .map((b) => {
      b.notes.sort(
        (a, c) => new Date(c.annotation.created_at).getTime() - new Date(a.annotation.created_at).getTime()
      );
      return b;
    })
    .sort((a, b) => (a.order[0] - b.order[0]) || (a.order[1] - b.order[1]));
}

/** Item 6 "按时间升序/降序": flat, no headers. */
export function sortByTime(entries: JournalNoteEntry[], direction: 'asc' | 'desc'): JournalNoteEntry[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...entries].sort(
    (a, b) => sign * (new Date(a.annotation.created_at).getTime() - new Date(b.annotation.created_at).getTime())
  );
}
