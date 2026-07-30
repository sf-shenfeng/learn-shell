// LessonCourseRail — 课文页课程导航轨 (导航轨案).
//
// 细轨家族第三名成员，视觉语言 100% 抄 document/DocRail.tsx（该文件的文档
// 注释里讲过这套语言的源头：Mind Map 的 Inspector → Review 的 DeckRail
// → DocRail → 这里）：220px 展开面板 / 40px 竖排细轨收起态、border
// var(--ls-border)、borderRadius 10px、sticky top 12px、"›" 收起按钮、同款
// hover:bg-[var(--ls-panel)] transition-colors。
//
// 跟 DocRail 的结构差异：DocRail 是单层文档平铺列表；这里是两层树
// (course > lesson)，course 行是手风琴——点击展开/收起，展开态才发起该课的
// lessons 查询（跟 pages/Courses.tsx 的 CourseCard 同一个"折叠时不查"节流
// 手法）。当前课时所在的那门课挂载时自动展开，其余课默认折叠。
//
// 默认收起（课文页已有 AppShell 侧栏 + 右侧 Live 教学面板的"三折"挤压逻辑
// 抢占横向空间，阅读测度优先——跟 DocRail 默认收起同一个判断），收起态持久
// 化 localStorage（键 learn-shell:lesson-course-rail-collapsed，读写形状照抄
// DocumentReader.tsx 的 DOC_RAIL_COLLAPSED_KEY 先例：默认收起，只有显式存过
// '0' 才展开）。
//
// 数据源复用现有 query，不新造端点：courses 用 ['courses', pairId]（与
// Courses.tsx 同 key），lessons 用 ['lessons', courseId]（与 Lesson.tsx 主查询
// / Courses.tsx 的 CourseCard 同 key）——当前课这一支会直接命中 Lesson.tsx
// 已经热着的缓存，不重新发请求。
//
// 空态克制（brief d）：只有一门课、且这门课的 lesson_ids 总数 ≤ 1 时没有地方
// 可跳，整轨不渲染——判断只看 course.structure.lesson_ids.length（跟
// CourseBadgeSummary 折叠态下"只知道总数"的读法一样），不必先展开取
// lessons 详情。
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  Course,
  CourseId,
  Lesson,
  LessonId,
  LessonProgress,
  LessonProgressState,
  Repository,
} from '@learn-shell/contracts';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';
import { useT } from '../i18n';
import type { ProgressRepo } from '../repository/progressExt';

export const LESSON_COURSE_RAIL_COLLAPSED_KEY = 'learn-shell:lesson-course-rail-collapsed';

// 两个态的宽度 (40px 细轨 / 220px 面板) 原本是下面两处字面量。之后
// Lesson.tsx 的外层行要按"放不放得下这条轨"决定它以哪个态出场 (甚至不出场)，
// 那道阈值算的就是这两个数——所以提上来导出，两处共用一份，不各写各的。
export const COURSE_RAIL_STRIP_W = 40;
export const COURSE_RAIL_PANEL_W = 220;

export function readLessonCourseRailCollapsed(): boolean {
  try {
    return localStorage.getItem(LESSON_COURSE_RAIL_COLLAPSED_KEY) !== '0';
  } catch {
    return true;
  }
}

export function LessonCourseRail({
  currentCourseId,
  currentLessonId,
  collapsed,
  onToggleCollapse,
  onSelect,
}: {
  currentCourseId: CourseId;
  currentLessonId: LessonId;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelect: (courseId: CourseId, lessonId: LessonId) => void;
}) {
  const { t } = useT();
  const repo = useRepository();
  const { pairId } = usePair();

  const coursesQ = useQuery({
    queryKey: ['courses', pairId],
    queryFn: () => (repo && pairId ? repo.getCourses(pairId) : Promise.resolve([] as Course[])),
    enabled: !!repo && !!pairId,
  });
  const courses = coursesQ.data ?? [];

  // 空态克制：只有一门课且它只有 ≤1 节课时，没有别处可跳。
  const soleCourseLessonCount = courses.length === 1 ? courses[0]?.structure.lesson_ids.length : null;
  if (courses.length === 0 || (courses.length === 1 && (soleCourseLessonCount ?? 0) <= 1)) {
    return null;
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex-none flex items-center justify-center border border-[var(--ls-border)] bg-[var(--ls-bg)] hover:bg-[var(--ls-panel)] transition-colors"
        style={{
          width: COURSE_RAIL_STRIP_W,
          minHeight: 160,
          borderRadius: '10px',
          padding: '12px 0',
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          fontSize: '11px',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--ls-text-secondary)',
          gap: '10px',
          position: 'sticky',
          top: '12px',
          alignSelf: 'flex-start',
        }}
        title={t('reading.courseRail.expandTitle')}
      >
        <span>{t('reading.courseRail.heading')}</span>
      </button>
    );
  }

  return (
    <aside
      className="flex-none border border-[var(--ls-border)]"
      style={{
        width: `${COURSE_RAIL_PANEL_W}px`,
        padding: '14px 12px',
        borderRadius: '10px',
        position: 'sticky',
        top: '12px',
        alignSelf: 'flex-start',
        maxHeight: 'calc(100vh - 24px)',
        overflowY: 'auto',
      }}
    >
      <div
        className="flex items-center justify-between"
        style={{ marginBottom: '10px', padding: '0 6px' }}
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--ls-text-tertiary)]">
          {t('reading.courseRail.heading')}
        </div>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="text-[13px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors"
          style={{ padding: '2px 6px', lineHeight: '1' }}
          title={t('reading.courseRail.collapseTitle')}
        >
          ›
        </button>
      </div>
      <ul className="flex flex-col" style={{ gap: '2px' }}>
        {courses.map((c) => (
          <CourseNode
            key={c.id}
            course={c}
            currentCourseId={currentCourseId}
            currentLessonId={currentLessonId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </aside>
  );
}

function CourseNode({
  course,
  currentCourseId,
  currentLessonId,
  onSelect,
}: {
  course: Course;
  currentCourseId: CourseId;
  currentLessonId: LessonId;
  onSelect: (courseId: CourseId, lessonId: LessonId) => void;
}) {
  const { t } = useT();
  const repo = useRepository();
  const progressRepo = repo as (Repository & ProgressRepo) | null;
  const { pairId } = usePair();
  const isCurrent = course.id === currentCourseId;
  // 当前课自动展开，其余课默认折叠——手风琴式，折叠时不发起该课的 lessons 查询
  // （同 Courses.tsx 的 CourseCard `enabled: !!repo && expanded`）。
  const [expanded, setExpanded] = useState(isCurrent);

  const lessonsQ = useQuery({
    queryKey: ['lessons', course.id],
    queryFn: () => (repo ? repo.getLessons(course.id) : Promise.resolve([] as Lesson[])),
    enabled: !!repo && expanded,
  });
  const lessons = lessonsQ.data ?? [];

  // 任务二 (2026-07-14) — rail 原本不拉 progress；这里只给展开的
  // course 发起查询 (跟 lessons 同一套"折叠不查"节流)，key 跟 Courses.tsx 的
  // CourseCard / Lesson.tsx 主查询同一个 ['course-progress', pairId, courseId]，
  // 命中缓存不重复打请求。
  const progressQ = useQuery({
    queryKey: ['course-progress', pairId, course.id],
    queryFn: () =>
      progressRepo && pairId
        ? progressRepo.getCourseProgress(pairId, course.id)
        : Promise.resolve([] as LessonProgress[]),
    enabled: !!progressRepo && !!pairId && expanded,
  });
  const progressList = progressQ.data ?? [];
  const progressByLessonId = new Map(progressList.map((p) => [p.lesson_id, p]));
  const doneCount = progressList.filter(
    (p) => p.state === 'completed_declared' || p.state === 'closed'
  ).length;
  const closedCount = progressList.filter((p) => p.state === 'closed').length;
  const totalLessons = course.structure.lesson_ids.length;

  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className={`w-full flex items-center rounded-[var(--ls-radius-control)] transition-colors duration-[var(--ls-duration-fast)] ${
          isCurrent ? 'text-[var(--ls-text)]' : 'text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)]'
        }`}
        style={{ padding: '7px 10px', gap: '8px' }}
      >
        <span className="text-[11px] flex-none" style={{ width: '10px' }}>
          {expanded ? '▾' : '▸'}
        </span>
        <span className="text-[13px] leading-5 font-medium truncate text-left flex-1 min-w-0">
          {course.topic}
        </span>
        <CourseRailCompletionBadge doneCount={doneCount} closedCount={closedCount} total={totalLessons} />
      </button>
      {expanded && (
        <ul className="flex flex-col" style={{ gap: '2px', paddingLeft: '18px' }}>
          {lessonsQ.isLoading ? (
            <li
              className="text-[11px] text-[var(--ls-text-tertiary)]"
              style={{ padding: '4px 10px' }}
            >
              {t('courses.loadingLessons')}
            </li>
          ) : (
            lessons.map((l) => {
              const active = l.id === currentLessonId;
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(course.id, l.id)}
                    disabled={active}
                    className={`w-full flex items-center rounded-[var(--ls-radius-control)] transition-colors duration-[var(--ls-duration-fast)] ${
                      active
                        ? 'bg-[var(--ls-panel)] text-[var(--ls-text)]'
                        : 'text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)]'
                    }`}
                    style={{ padding: '6px 10px', gap: '8px' }}
                  >
                    <span className="text-[13px] leading-5 truncate text-left flex-1 min-w-0">
                      {l.title}
                    </span>
                    <LessonRailProgressDot state={progressByLessonId.get(l.id)?.state} />
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </li>
  );
}

/**
 * CourseRailCompletionBadge — 任务二, rail 版的课程级 "x/y" 徽章 (逻辑跟
 * Courses.tsx 的 CourseCompletionBadge 是同一份定版方案，两处各自本地
 * 实现而非抽共享组件——跟 LessonStatusBadge 不同，这个徽章两处的宽度预算/
 * 视觉密度不一样，硬共享反而要塞一堆 size prop)。x==0 安静；x==y 追加 ✓，
 * 全 closed 绿、有 declared 未 closed 琥珀。
 */
function CourseRailCompletionBadge({
  doneCount,
  closedCount,
  total,
}: {
  doneCount: number;
  closedCount: number;
  total: number;
}) {
  if (doneCount === 0 || total === 0) return null;
  const complete = doneCount === total;
  const allClosed = complete && closedCount === total;
  const color = complete
    ? allClosed
      ? 'var(--ls-corroborated)'
      : 'var(--ls-hypothesis)'
    : 'var(--ls-text-tertiary)';
  return (
    <span className="text-[10px] tabular-nums flex-none" style={{ color }}>
      {doneCount}/{total}
      {complete ? ' ✓' : ''}
    </span>
  );
}

/**
 * LessonRailProgressDot — 任务二: 每节课行右侧的完成状态点。220px 展开面板
 * 里 title 已经在跟缩进/hover 背景抢空间，brief 允许在挤的时候退化成色点
 * (琥珀/绿)，title 属性放状态全称——比塞一整个 LessonStatusBadge pill 更贴
 * 这条 40px/220px 双态 rail 的密度。空状态 (not_started/in_progress) 沉默
 * 不渲染，跟 LessonStatusBadge 的哲学一致。
 */
const RAIL_DOT_COLOR: Partial<Record<LessonProgressState, string>> = {
  completed_declared: 'var(--ls-hypothesis)',
  closed: 'var(--ls-corroborated)',
};

function LessonRailProgressDot({ state }: { state: LessonProgressState | undefined }) {
  const { t } = useT();
  if (!state) return null;
  const color = RAIL_DOT_COLOR[state];
  if (!color) return null;
  const label =
    state === 'closed' ? t('lesson.progress.closedBadge') : t('lesson.progress.declaredBadge');
  return (
    <span
      className="rounded-full flex-none"
      style={{ width: '6px', height: '6px', background: color }}
      title={label}
    />
  );
}
