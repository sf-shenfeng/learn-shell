// Journal — Sessions 页重生, α 期 + 按日归组修订 + batch D
// (2026-07-07 art-direction 定版).
//
// 时间线以"天"为单位归组，日组默认折叠只见组头 (日期 + 当日一行摘要)。
// 组内是三类条目；课/Live 条目保留自身的展开/折叠。
//
// 批F (7/7 深夜验收判定架构错位): 批D/批E 曾在这里挂过一具"我的笔记"
// 右侧副栏 (JournalNotesPanel.tsx, 双列布局 + 窄屏折叠), 收起时左边冒出可点
// 条、主列却不回弹——是寄生在 Journal 排版里的无界滚动体, 不是干净的组件。
// 拍板重构：笔记区整体搬去抽屉 (journal/NotesDrawer.tsx), 跟 Pending Pool
// 同级同逻辑——从 RecentRail 的"笔记"行或 G N 召出, 不再是这个页面自己的
// 布局决策。这个页面因此回归批D 之前的样子：满宽纯传记, 不再持有
// useJournalNotes()、不再有 showNotesPanel/narrow 判断、不再给自己套
// max-w-3xl (AppShell 的 isJournalRoute 加宽同批撤掉, 见 shell/AppShell.tsx)。

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CourseId } from '@learn-shell/contracts';
import { useT } from '../i18n';
import CourseChips, { type CourseFilter } from './CourseChips';
import DayGroup, { type DayGroupData } from './DayGroup';
import RhythmRuler from './RhythmRuler';
import { dayKeyOf } from './format';
import { useJournalTimeline } from './useJournalTimeline';

// "更早"分页按日组数走 (两周一页), 不按裸条目数.
const PAGE_SIZE = 14;

export default function JournalPage() {
  const { t } = useT();
  const { entries, courses, isLoading, agentLabel, daySummaries, hasRepo } = useJournalTimeline();
  // ?course=<courseId> — 只作筛选状态的初值, 不是受控 URL 状态 (点 chip 之后
  // 就归 setCourseFilter 管, 不回写地址栏)。唯一的来路是课文页结课标识那条
  // "评估记在传记里 →" 链接 (pages/Lesson.tsx 的 LessonClosureNote): 落地即是
  // 这门课的时间线, 不是全部课程混排。零新后端 —— 复用本页本来就有的
  // CourseFilter。
  const [searchParams] = useSearchParams();
  const courseParam = searchParams.get('course');
  const [courseFilter, setCourseFilter] = useState<CourseFilter>(
    courseParam ? (courseParam as CourseId) : 'all'
  );
  // 参数指向的课程在传记里可能一条记录都还没有 (那门课的 chip 就不会出现) ——
  // 那种情况下认死这个筛选会把人堵在"这门课还没有留下痕迹"里, 连个能点回
  // "全部"的 chip 都没有。所以 courses 拿回来之后校一次, 认不出就退回 'all'。
  // courses 还没到 (空数组) 时不判死刑, 免得开屏闪一下再跳回来。
  const effectiveFilter: CourseFilter =
    courseFilter === 'all' || courses.length === 0 || courses.some((c) => c.id === courseFilter)
      ? courseFilter
      : 'all';
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // 日组展开状态放页面级 (Set<dayKey>)——同一会话内不因重渲染/筛选丢失；
  // 默认全折叠 (按日归组修订)。不持久化到 storage.
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());

  const filtered = useMemo(() => {
    if (effectiveFilter === 'all') return entries;
    return entries.filter((e) => {
      // 复习日 / 考纲周条目跨课程聚合，没有单一课程归属——筛选时始终保留可见。
      if (e.kind === 'review-day' || e.kind === 'syllabus-week') return true;
      return e.courseId === effectiveFilter;
    });
  }, [entries, effectiveFilter]);

  // 按天归组。entries 已整体倒序，组顺序 = 首次出现顺序，组内保持倒序.
  // 某日条目全部被滤掉 → 该日根本不成组，整组隐藏 (按日归组修订 §4).
  const groups = useMemo(() => {
    const byDay = new Map<string, DayGroupData>();
    for (const e of filtered) {
      const key = e.kind === 'review-day' || e.kind === 'syllabus-week' ? e.dayKey : dayKeyOf(e.date);
      const g = byDay.get(key);
      if (g) {
        g.entries.push(e);
      } else {
        byDay.set(key, { dayKey: key, date: e.date, entries: [e] });
      }
    }
    return Array.from(byDay.values());
  }, [filtered]);

  const visibleGroups = groups.slice(0, visibleCount);
  const hasMore = groups.length > visibleGroups.length;

  const toggleDay = (dayKey: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(dayKey)) next.delete(dayKey);
      else next.add(dayKey);
      return next;
    });
  };

  if (!hasRepo) {
    return (
      <p className="text-sm text-[var(--ls-text-secondary)]">
        {t('journal.emptyModePrefix')}{t('journal.emptyNoRepo')}
      </p>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight" style={{ marginBottom: '18px' }}>
        {t('nav.sessions')}
      </h1>

      <RhythmRuler daySummaries={daySummaries} />
      <CourseChips courses={courses} selected={effectiveFilter} onSelect={setCourseFilter} />

      {isLoading && <p className="text-sm text-[var(--ls-text-tertiary)]">{t('contract.loading')}</p>}

      {!isLoading && groups.length === 0 && entries.length === 0 && (
        <p className="text-[13px] leading-5 text-[var(--ls-text-tertiary)]">
          {t('journal.emptyCourse.prefix')}{' '}
          <Link to="/lesson" className="hover:underline" style={{ color: 'var(--ls-structure)' }}>
            {t('journal.emptyCourse.link')}
          </Link>{' '}
          {t('journal.emptyCourse.suffix')}
        </p>
      )}

      {!isLoading && groups.length === 0 && entries.length > 0 && (
        <p className="text-[13px] leading-5 text-[var(--ls-text-tertiary)]">
          {t('journal.emptyFiltered')}
        </p>
      )}

      {!isLoading && groups.length > 0 && (
        <>
          <div className="flex flex-col" style={{ gap: '4px' }}>
            {visibleGroups.map((g) => (
              <DayGroup
                key={g.dayKey}
                group={g}
                expanded={expandedDays.has(g.dayKey)}
                onToggle={() => toggleDay(g.dayKey)}
                agentLabel={agentLabel}
              />
            ))}
          </div>

          {hasMore && (
            <button
              type="button"
              onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
              className="hover:underline"
              style={{
                marginTop: '16px',
                fontSize: '12px',
                color: 'var(--ls-text-tertiary)',
              }}
            >
              {t('journal.loadMore')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
