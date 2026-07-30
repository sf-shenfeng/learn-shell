// Shared date helpers for the Journal timeline.

import type { Lang } from '../i18n/dict';

/** Local-timezone YYYY-MM-DD bucket key — used for both the heat map and
 * 复习日 aggregation so "today" lines up the same way in both places. */
export function dayKeyOf(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA');
}

/** Monday-anchored calendar-week bucket key
 * ("每周一条") — the key is the Monday's own dayKeyOf, so every day
 * Mon–Sun in the same week collapses to one bucket. Deliberately NOT full
 * ISO-8601 week numbering (no cross-year week-number system, no "week 1
 * belongs to which year" edge case to get right) — a stable per-week
 * identity is all the syllabus-week projection needs, both to group
 * mappings by week and to pick which day-group a weekly entry attaches to
 * (see useJournalTimeline.ts: it attaches to the day of that week's most
 * recent mapping, not to the Monday itself). */
export function weekKeyOf(iso: string): string {
  const d = new Date(iso);
  const day = d.getDay(); // 0=Sun .. 6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diffToMonday);
  return dayKeyOf(monday.toISOString());
}

/** "7月5日" (zh) / "Jul 5" (en) — no year. Shared by formatEntryDate below
 * and by the rhythm ruler's tick tooltips (节律尺案), which only ever spans
 * a handful of weeks so a bare month/day is never ambiguous. */
export function formatMonthDay(d: Date, lang: Lang = 'zh'): string {
  if (lang === 'en') {
    return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(d);
  }
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** "7月" (zh) / "Jul" (en) — rhythm ruler's month-boundary tick label. */
export function formatMonthShort(d: Date, lang: Lang = 'zh'): string {
  if (lang === 'en') {
    return new Intl.DateTimeFormat('en', { month: 'short' }).format(d);
  }
  return `${d.getMonth() + 1}月`;
}

/** "7月5日" / "Jul 5" — falls back
 * to including the year when the entry isn't from the current year. */
export function formatEntryDate(iso: string, lang: Lang = 'zh'): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.getFullYear() !== now.getFullYear()) {
    if (lang === 'en') {
      return new Intl.DateTimeFormat('en', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(d);
    }
    return `${d.getFullYear()}年${formatMonthDay(d, lang)}`;
  }
  return formatMonthDay(d, lang);
}

/** Journal notes panel's "加入日期" (batch E, item 2): a plain date for
 * anything not from today, "刚刚知道是几点就够了" for today — reuses
 * dayKeyOf's local-calendar-day bucketing (same "today" definition the
 * rhythm ruler/复习日 aggregation already share) so this never disagrees
 * with what the rest of the page calls "today". */
export function formatNoteDate(iso: string, lang: Lang = 'zh'): string {
  const d = new Date(iso);
  if (dayKeyOf(iso) === dayKeyOf(new Date().toISOString())) {
    return new Intl.DateTimeFormat(lang === 'en' ? 'en' : 'zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  }
  return formatEntryDate(iso, lang);
}
