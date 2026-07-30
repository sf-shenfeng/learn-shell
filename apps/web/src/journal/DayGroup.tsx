// 日组 — 按日归组修订：时间线以"天"为单位归组，日组默认折叠只见组头.
//
// 组头 = 日期 + 当日一行摘要（"N 课 · M Live · 复习 K 张"——有什么写什么,
// 缺项不占位）。展开状态由 JournalPage 持有（Set<dayKey>），同一会话内
// 不因重渲染丢失；不持久化到 storage（修订条款：简单起见）.

import type { DictKey } from '../i18n/dict';
import { useT } from '../i18n';
import type { JournalEntry } from './types';
import { formatEntryDate } from './format';
import LessonEntryCard from './entries/LessonEntryCard';
import LiveEntryCard from './entries/LiveEntryCard';
import ReviewDayEntryCard from './entries/ReviewDayEntryCard';
import SyllabusWeekEntryCard from './entries/SyllabusWeekEntryCard';

export interface DayGroupData {
  dayKey: string;
  /** 当日最晚一条的 ISO — 组头日期显示用. */
  date: string;
  entries: JournalEntry[];
}

/** 组头摘要："N 课 · M Live · 复习 K 张"，零项的类目直接不出现.
 *  `t` is threaded in (not a hook itself — this fn is also called from
 *  useJournalTimeline.ts, a hook, not a component) per brief's non-component
 *  i18n convention. */
export function summarizeDay(entries: JournalEntry[], t: (key: DictKey) => string): string {
  const lessons = entries.filter((e) => e.kind === 'lesson').length;
  const lives = entries.filter((e) => e.kind === 'live').length;
  const reviewCards = entries
    .filter((e) => e.kind === 'review-day')
    .reduce((sum, e) => sum + (e.kind === 'review-day' ? e.cardCount : 0), 0);
  // 考纲周条目挂在这天的日组里时也要给组头一个 chunk（否则一个只有它的
  // 日组会渲染出一行空摘要）——"点亮 N 个考点"数的是这周新点亮的去重节点数,
  // 只报点亮 (brief §4 语言规范), 跟正文一致.
  const litNodes = entries
    .filter((e) => e.kind === 'syllabus-week')
    .reduce((sum, e) => sum + (e.kind === 'syllabus-week' ? e.litNodeCodes.length : 0), 0);

  const chunks: string[] = [];
  if (lessons > 0) chunks.push(`${lessons}${t('journal.day.lessonsUnit')}`);
  if (lives > 0) chunks.push(`${lives} Live`);
  if (reviewCards > 0)
    chunks.push(`${t('journal.day.reviewPrefix')}${reviewCards}${t('journal.day.cardsUnit')}`);
  if (litNodes > 0)
    chunks.push(`${t('journal.day.syllabusPrefix')}${litNodes}${t('journal.day.syllabusUnit')}`);
  return chunks.join(' · ');
}

export default function DayGroup({
  group,
  expanded,
  onToggle,
  agentLabel,
}: {
  group: DayGroupData;
  expanded: boolean;
  onToggle: () => void;
  agentLabel: string;
}) {
  const { t, lang } = useT();
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex items-baseline justify-between w-full text-left hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
        style={{ gap: '10px', padding: '8px 6px', borderRadius: 'var(--ls-radius-control)' }}
      >
        <span className="flex items-baseline flex-wrap min-w-0" style={{ gap: '10px' }}>
          <span className="font-medium tabular-nums" style={{ fontSize: '13px', lineHeight: '20px' }}>
            {formatEntryDate(group.date, lang)}
          </span>
          <span style={{ fontSize: '12px', lineHeight: '18px', color: 'var(--ls-text-tertiary)' }}>
            {summarizeDay(group.entries, t)}
          </span>
        </span>
        <span
          className="flex-none text-[var(--ls-text-tertiary)]"
          style={{ fontSize: '11px', transform: expanded ? 'rotate(180deg)' : undefined }}
          aria-hidden
        >
          ▾
        </span>
      </button>

      {expanded && (
        <ul className="flex flex-col" style={{ gap: '10px', margin: '6px 0 4px' }}>
          {group.entries.map((entry) => {
            if (entry.kind === 'lesson') {
              return <LessonEntryCard key={entry.id} entry={entry} agentLabel={agentLabel} />;
            }
            if (entry.kind === 'live') {
              return <LiveEntryCard key={entry.id} entry={entry} agentLabel={agentLabel} />;
            }
            if (entry.kind === 'syllabus-week') {
              return <SyllabusWeekEntryCard key={entry.id} entry={entry} />;
            }
            return <ReviewDayEntryCard key={entry.id} entry={entry} />;
          })}
        </ul>
      )}
    </section>
  );
}
