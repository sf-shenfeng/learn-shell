import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type {
  Course,
  CourseFootprint,
  CourseId,
  LessonProgress,
  Repository,
} from '@learn-shell/contracts';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';
import { useT } from '../i18n';
import type { ProgressRepo } from '../repository/progressExt';
import { LessonStatusBadge } from '../lesson/LessonStatusBadge';
import { useRevisedUnreadSet } from '../lesson/useRevisedUnread';
import type { LessonWithAxes } from '../lesson/axes';
import { StateDot } from '../components/StateDot';
import { StatusPill } from '../components/StatusPill';

/**
 * Courses — landing page when nav "Lesson" is clicked.
 *
 * Stage 7a: collapsible card per course (originally matched /contract
 * page's ContractListEntry accordion layout — that component is gone as of
 * the 2026-07-08 certificate rework, but this card's own header + expand
 * toggle shape is unchanged). Expanded body lists lessons with learning-state
 * dots (三态字形案, 2026-07-22 二次裁定 — see LessonRow's doc comment):
 *   ○ prepped, not started — hollow amber ring
 *   ◐ learning in progress — half-filled amber circle
 *   ● learner completed (declared / closed) — filled green dot, the only green
 */
export default function Courses() {
  const repo = useRepository();
  const { pairId } = usePair();
  const { t } = useT();

  const coursesQ = useQuery({
    queryKey: ['courses', pairId],
    queryFn: () =>
      repo && pairId ? repo.getCourses(pairId) : Promise.resolve([] as Course[]),
    enabled: !!repo && !!pairId,
  });

  if (!repo) {
    return (
      <p className="text-sm text-[var(--ls-text-secondary)]">
        {t('courses.emptyMode')}
      </p>
    );
  }

  const courses = coursesQ.data ?? [];
  // Sort newest first (course.created_at).
  const sortedCourses = [...courses].sort((a, b) =>
    (b.created_at ?? '').localeCompare(a.created_at ?? '')
  );

  return (
    <div>
      <h1
        className="font-bold text-[24px] leading-[32px] tracking-[-0.02em]"
        style={{ margin: 0, marginBottom: '4px' }}
      >
        {t('courses.title')}
      </h1>
      <p
        className="text-[13px] leading-5 text-[var(--ls-text-secondary)]"
        style={{ marginBottom: '24px', maxWidth: '580px' }}
      >
        {t('courses.subtitle')}
      </p>

      {sortedCourses.length === 0 ? (
        <div
          className="border border-dashed border-[var(--ls-border)] text-[13px] leading-5 text-[var(--ls-text-tertiary)]"
          style={{ padding: '20px', borderRadius: '8px', maxWidth: '760px' }}
        >
          {t('courses.emptyNoContract')}
        </div>
      ) : (
        <div
          className="flex flex-col"
          style={{ gap: '10px', maxWidth: '760px' }}
        >
          {sortedCourses.map((c) => (
            <CourseCard key={c.id} course={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function CourseCard({ course }: { course: Course }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const repo = useRepository();
  const progressRepo = repo as (Repository & ProgressRepo) | null;
  // getCourseFootprint / deleteCourse landed on core Repository (another
  // worker's parallel task) — no separate cast needed, unlike ProgressRepo's
  // extension-interface pattern above.
  const adminRepo = repo;
  const { pairId } = usePair();
  const { t } = useT();
  const qc = useQueryClient();
  const lessonCount = course.structure.lesson_ids.length;

  // Lazy-load lessons only when expanded (keep the page light when user
  // has many courses).
  // 迁移 0030: Lesson.status(生成态) 列拆除 — 该列的唯一消费者是这里的轮询
  // ("有课在 generating 就每秒轮一次"), 但 status 从未被真实写路径写过, 这
  // 个轮询条件在 status 列还在时就已经恒假。列拆除后干脆去掉这个 refetchInterval,
  // 不留一个读不到任何字段的空判断。
  const lessonsQ = useQuery({
    queryKey: ['lessons', course.id],
    queryFn: () =>
      repo
        ? (repo.getLessons(course.id as CourseId) as Promise<LessonWithAxes[]>)
        : Promise.resolve([] as LessonWithAxes[]),
    enabled: !!repo && expanded,
  });

  // §6/§8 (2026-07-11 施工批) — same query key as Lesson.tsx's own course-progress fetch, so
  // whichever page loaded it first pays the network cost.
  //
  // 任务二 (2026-07-14): 课程级 x/y 完成计数在折叠态也要可见
  // (kebab 徽章不等展开)，所以这里去掉了原来的 `&& expanded` 门槛——
  // react-query 的缓存会兜底重复请求，brief 认定这个代价可接受。
  const progressQ = useQuery({
    queryKey: ['course-progress', pairId, course.id],
    queryFn: () =>
      progressRepo && pairId
        ? progressRepo.getCourseProgress(pairId, course.id as CourseId)
        : Promise.resolve([] as LessonProgress[]),
    enabled: !!progressRepo && !!pairId,
  });
  const progressList = progressQ.data ?? [];
  const progressByLessonId = new Map(progressList.map((p) => [p.lesson_id, p]));
  const declaredOrClosedCount = progressList.filter(
    (p) => p.state === 'completed_declared' || p.state === 'closed'
  ).length;
  const closedCount = progressList.filter((p) => p.state === 'closed').length;

  // 任务一 — footprint 只在确认条打开时才拉 (删除前的最后一次核对，不必
  // 提前预取拖慢列表)。
  const footprintQ = useQuery({
    queryKey: ['course-footprint', course.id],
    queryFn: () => adminRepo!.getCourseFootprint(course.id as CourseId),
    enabled: !!adminRepo && confirmingDelete,
  });
  const deleteMut = useMutation({
    mutationFn: () => adminRepo!.deleteCourse(course.id as CourseId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['courses', pairId] });
    },
  });

  const lessons = lessonsQ.data ?? [];
  // 迁移 0030 — Courses 真相徽章: 原来的 generated/generating/proposed 三态
  // 是已拆列的 Lesson.status(生成态)遗留概念 (且 generating/proposed 从未有
  // 真实写路径产出过, 见 packages/contracts/src/pair.ts 的 outline/generate
  // pipeline 拆除记录)。改由 axes.content 驱动: published/draft 两态, 缺
  // axes (契约未落地前的过渡态) 一律计入 draft, 不假装知道。
  const publishedCount = lessons.filter((l) => l.axes?.content === 'published').length;
  const draftCount = lessons.length - publishedCount;

  // 票二 (2026-07-17 定案) — "课改过了，回来看看" 标。迁移
  // 0030 服务端真相版: 直接读 axes, 不再需要 progressByLessonId 参数。Empty
  // (lessons=[]) before first expand — same "silent until known" idiom
  // CourseBadgeSummary's counts already accept above; once expanded once,
  // react-query's cache keeps `lessons` populated even after collapsing
  // again, so the header count survives a re-collapse.
  const revisedUnreadIds = useRevisedUnreadSet(lessons);

  return (
    <div
      className="border border-[var(--ls-border)] bg-[var(--ls-bg)]"
      style={{ borderRadius: '10px', overflow: 'hidden' }}
    >
      {/* 任务一修法 (嵌套按钮修复) — 这层原是 <button>，但内部还嵌了一个真按钮
          (kebab 删除入口)，button 套 button 触发 React hydration 警告且
          嵌套交互元素的焦点/点击行为未定义。降级为 div role="button"，
          自补 Enter/Space 键盘激活，视觉与原 onClick/hover 行为不变。 */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((ex) => !ex);
          }
        }}
        className="w-full flex items-center hover:bg-[var(--ls-panel)] transition-colors text-left cursor-pointer"
        style={{ padding: '12px 14px', gap: '12px' }}
      >
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-medium text-[var(--ls-text)] truncate">
            {course.topic}
          </div>
          {course.description && (
            <div
              className="text-[12px] leading-[18px] text-[var(--ls-text-tertiary)] truncate"
              style={{ marginTop: '2px' }}
            >
              {course.description}
            </div>
          )}
        </div>
        <CourseCompletionBadge
          doneCount={declaredOrClosedCount}
          closedCount={closedCount}
          total={lessonCount}
        />
        <CourseRevisedSummary count={revisedUnreadIds.size} />
        <CourseBadgeSummary
          total={lessonCount}
          published={publishedCount}
          draft={draftCount}
          knownFromList={expanded}
        />
        {/* 任务一 — 删除入口。header 是手风琴展开区 (div role="button")，这里
            stopPropagation 防止点删除也顺带触发展开/折叠。低调 kebab，不抢
            topic/badge 的视觉。 */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmingDelete(true);
          }}
          title={t('courses.delete.tooltip')}
          className="text-[14px] leading-none text-[var(--ls-text-tertiary)] hover:text-[var(--ls-risk)] transition-colors"
          style={{ flexShrink: 0, padding: '2px 4px' }}
        >
          ⋮
        </button>
        <span
          className="text-[12px] text-[var(--ls-text-tertiary)]"
          style={{ flexShrink: 0, width: '14px', textAlign: 'center' }}
        >
          {expanded ? '▾' : '▸'}
        </span>
      </div>

      {confirmingDelete && (
        <CourseDeleteConfirmBar
          footprint={footprintQ.data}
          loading={footprintQ.isLoading}
          hasError={footprintQ.isError || deleteMut.isError}
          deleting={deleteMut.isPending}
          onConfirm={() => deleteMut.mutate()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}

      {!confirmingDelete && expanded && (
        <div className="border-t border-[var(--ls-border)]">
          {lessonsQ.isLoading ? (
            <div
              className="text-[13px] text-[var(--ls-text-tertiary)]"
              style={{ padding: '14px 16px' }}
            >
              {t('courses.loadingLessons')}
            </div>
          ) : lessons.length === 0 ? (
            <div
              className="text-[13px] text-[var(--ls-text-tertiary)]"
              style={{ padding: '14px 16px' }}
            >
              {t('courses.noLessonsYet')}
            </div>
          ) : (
            <ul className="flex flex-col">
              {lessons.map((l, i) => (
                <LessonRow
                  key={l.id}
                  lesson={l}
                  courseId={course.id}
                  isLast={i === lessons.length - 1}
                  progressState={progressByLessonId.get(l.id)?.state}
                  revisedUnread={revisedUnreadIds.has(l.id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * CourseCompletionBadge — 任务二 (定版方案): 课程级完成度 "x/y"。
 * x = declared 或 closed 的 lesson 数，y = 总 lesson 数。x==0 时安静不渲染
 * (跟 LessonStatusBadge 的沉默哲学一致)；x==y 时追加 ✓，颜色两级：
 * 全部 closed → --ls-corroborated (绿，老师批改闭环)；有 declared 未 closed
 * → --ls-hypothesis (琥珀，学习者自己宣布)。0<x<y 时中性 tertiary 灰，不
 * 冒充任何一级颜色。
 */
function CourseCompletionBadge({
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
    <span className="text-[11px] tabular-nums" style={{ flexShrink: 0, color }}>
      {doneCount}/{total}
      {complete ? ' ✓' : ''}
    </span>
  );
}

/**
 * CourseRevisedSummary — 票二 (2026-07-17 定案): 课程卡 header
 * 汇总小点。有任一"已修订未读"课时才出现，count===0 时安静不渲染 (跟
 * CourseCompletionBadge 的 x=0 沉默判例、LessonStatusBadge 的
 * "state 缺省不渲染" 同一哲学 — 这张卡片header已经有两个徽章在这么做了)。
 * 颜色借 --ls-hypothesis (琥珀) —— 这是"需要你回头看一眼"的既有配色
 * (LessonStatusBadge.declaredBadge / CourseCompletionBadge 的未全 closed 分支
 * 都是这个语义)，跟 lesson 页 RevisionPill 自己的 --ls-structure (蓝，"这课
 * 曾被改过"的中性事实色) 刻意区分开：这里传达的是"对你来说是新信息"，不是单纯
 * 修订记录存在与否。
 */
function CourseRevisedSummary({ count }: { count: number }) {
  const { t } = useT();
  if (count === 0) return null;
  const color = 'var(--ls-hypothesis)';
  return (
    <span
      className="inline-flex items-center text-[11px] tabular-nums"
      style={{ flexShrink: 0, color, gap: '4px' }}
      title={t('courses.revisedSummaryTooltip')}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {count}{t('courses.revisedCountSuffix')}
    </span>
  );
}

/**
 * RevisedFlag — 票二: 课时行级"已修订"小标. 视觉语言直接照抄
 * LessonStatusBadge 的 pill 形状 (border + dot + uppercase) —— 这两个标在
 * 同一行并排出现 (LessonRow 里紧挨着 LessonStatusBadge)，形状必须对齐，颜色
 * 用 --ls-hypothesis 才能跟 declaredBadge 的琥珀区分不开混淆；这里刻意选同一
 * 家族的 pill 形状 + 同一支琥珀，因为语义确实相邻("你宣布/关课完成的这一
 * 课"和"这一课后来又变了")，用同一视觉语言反而是准确的，不是偷懒。
 */
function RevisedFlag() {
  const { t } = useT();
  const color = 'var(--ls-hypothesis)';
  // flexShrink:0 lives on LessonRow's wrapping span (its shared-height
  // anchor), not here — see StatusPill.tsx, single shared box model.
  return <StatusPill color={color}>{t('courses.revisedFlag')}</StatusPill>;
}

/**
 * CourseDeleteConfirmBar — 任务一: 内联两段式确认的第二段 (全站范式，金标准
 * pages/Cards.tsx confirmingDelete；明令禁止 window.confirm)。展开态显示
 * getCourseFootprint 的明细计数，未加载完前先显示"核对中"占位，不让人对着
 * 空数字点确认。
 */
function CourseDeleteConfirmBar({
  footprint,
  loading,
  hasError,
  deleting,
  onConfirm,
  onCancel,
}: {
  footprint: CourseFootprint | undefined;
  loading: boolean;
  hasError: boolean;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  return (
    <div className="border-t border-[var(--ls-border)]" style={{ padding: '12px 14px' }}>
      <div
        className="text-[12px] leading-5 text-[var(--ls-text-secondary)]"
        style={{ marginBottom: '10px' }}
      >
        {loading || !footprint ? (
          t('courses.delete.loading')
        ) : (
          <>
            {t('courses.delete.prefix')}
            {footprint.lessons}
            {t('courses.delete.lessonsSuffix')}
            {footprint.flashcards}
            {t('courses.delete.flashcardsSuffix')}
            {footprint.exercises}
            {t('courses.delete.exercisesSuffix')}
            {footprint.quizzes}
            {t('courses.delete.quizzesSuffix')}
            {t('courses.delete.irreversible')}
          </>
        )}
      </div>
      <div className="flex items-center" style={{ gap: '10px' }}>
        <button
          type="button"
          onClick={onConfirm}
          disabled={loading || !footprint || deleting}
          className="text-[12px] font-medium disabled:opacity-40"
          style={{ color: 'var(--ls-risk)' }}
        >
          {deleting ? t('courses.delete.deleting') : t('cards.confirmDelete')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-[12px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
        >
          {t('cards.cancel')}
        </button>
      </div>
      {hasError && (
        <div className="text-[11px] text-[var(--ls-risk)]" style={{ marginTop: '8px' }}>
          {t('courses.delete.error')}
        </div>
      )}
    </div>
  );
}

/**
 * CourseBadgeSummary — 迁移 0030 (Courses 真相徽章): 原来的
 * generated/generating/proposed 三态是 Lesson.status(生成态) 拆列前的遗留
 * 概念 (generating/proposed 从未有真实写路径产出过——outline/generate
 * pipeline 已拆除, 见 packages/contracts/src/pair.ts)。改由 axes.content
 * 驱动: published/draft 两态, 布局与原三段式 parts.join 不变, 只是词换了源。
 */
function CourseBadgeSummary({
  total,
  published,
  draft,
  knownFromList,
}: {
  total: number;
  published: number;
  draft: number;
  knownFromList: boolean;
}) {
  const { t } = useT();
  // Until lessons are loaded (collapsed state), we only know the total
  // from course.structure.lesson_ids; show the total alone.
  if (!knownFromList) {
    return (
      <span
        className="text-[11px] text-[var(--ls-text-tertiary)] tabular-nums"
        style={{ flexShrink: 0 }}
      >
        {total}{t('courses.lessonsCountSuffix')}
      </span>
    );
  }
  const parts: string[] = [];
  if (published > 0) parts.push(`${published}${t('courses.publishedSuffix')}`);
  if (draft > 0) parts.push(`${draft}${t('courses.draftSuffix')}`);
  return (
    <span
      className="text-[11px] text-[var(--ls-text-tertiary)] tabular-nums"
      style={{ flexShrink: 0 }}
    >
      {parts.join(' · ') || `${total}${t('courses.lessonsCountSuffix')}`}
    </span>
  );
}

/**
 * LessonRow — 迁移 0030 (Courses 真相徽章): 原来的三段式 (generated/
 * generating/proposed) 分支是 Lesson.status(生成态) 拆列前的遗留概念——
 * generating/proposed 两态从未被真实写路径产出过 (outline/generate pipeline
 * 已拆除, 见 packages/contracts/src/pair.ts), 真实数据里每一课点开都是可读
 * 的。布局(order/title/RevisedFlag/LessonStatusBadge)不变。
 *
 * 三态字形案 (2026-07-22 实机截图二次裁定): 颜色是学习者的
 * 勋章, 不是老师的出勤章——"已发布"不再顶着绿勾冒充"我学完了"。icon 改由
 * axes.learning 驱动 (跟 LessonAxesBar 同一事实源, 不另造推导), 且从「字符
 * 字形 (○/◐/✓)」统一为纯 CSS 圆点/圆环 (见 LessonStateDot) —— 字符靠字体
 * 基线定位, 跟同行的 01 序号、标题这些真正的文本对不上一条视觉中线; 圆点用
 * 固定尺寸的 inline-flex 盒子居中。
 *
 * 圆点统一案 二次裁定 (实机截图复核, 2026-07-22): 早前版本把这里的直径对
 * 齐到了 pages/Cards.tsx StatTile 的迷你点规格 (7px) —— 号认错了。全站其实
 * 有两个圆点家族: StatTile 的 TILE 家族 (7px, 统计卡片里的迷你点) 和
 * Cards.tsx CardRow 这类"列表行"状态点的 ROW 家族 (其视觉参照物)。课时
 * 行属于列表行, 该对齐 ROW 家族, 不是 TILE 家族。现在两边都改用共享的
 * ../components/StateDot (ROW_DOT_DIAMETER = 10px, 测量方法见该文件头注):
 *   ○ 空心灰圆环 (--ls-text-tertiary) — 备好未开始 (not_started / axes 缺省 / draft)
 *   ◐ 半实心琥珀圆 — 学习中 (in_progress)
 *   ● 实心绿点 — 学习者学完 (completed_declared / closed); declared/closed
 *     的区分交给同行紧邻的 LessonStatusBadge, 字形不重播
 *
 * 三态字形案 当天早间版本刻意不用琥珀 (怕跟 declaredBadge 的琥珀撞色/抢戏),
 * "学习中"用中性 --ls-text-secondary 灰半圆区分——实机截图复核后翻案:
 * 灰半圆反而跟 not_started 的灰圈语义纠缠不清, 琥珀才是"进行中/待完成"的
 * 通用色, 统一成琥珀家族 (--ls-hypothesis, 跟 Cards.tsx 圆点用的是同一枚
 * token) 才一眼分清三态。completed 的绿色仍是学习者专属勋章色, 这次调色
 * 不动它 (三态字形案 主张不变)。
 */
function LessonStateDot({ state }: { state: 'not_started' | 'in_progress' | 'done' }) {
  if (state === 'done') {
    return <StateDot shape="solid" color="var(--ls-corroborated)" />;
  }
  if (state === 'in_progress') {
    return <StateDot shape="half" color="var(--ls-hypothesis)" />;
  }
  // 二次调色 (7/22 傍晚): 待学圆环回归中性灰——amber 只属于"正在路上",
  // 没出发的路不预支路上的颜色。灰环待学 / 琥珀半圆在途 / 绿点抵达,一色一职。
  return <StateDot shape="ring" color="var(--ls-text-tertiary)" />;
}

function LessonRow({
  lesson,
  courseId,
  isLast,
  progressState,
  revisedUnread,
}: {
  lesson: LessonWithAxes;
  courseId: CourseId;
  isLast: boolean;
  /** §6 — undefined while progressQ hasn't resolved
   *  yet; LessonStatusBadge already treats undefined as "render nothing". */
  progressState?: LessonProgress['state'];
  /** 票二 — true when useRevisedUnreadSet judged this lesson "closed/declared,
   *  revised since, and not yet re-opened by this browser". Always false
   *  while lessons/progress/revision-history queries are still resolving —
   *  same "undefined/false renders nothing" idiom as progressState above. */
  revisedUnread?: boolean;
}) {
  const baseStyle: React.CSSProperties = {
    padding: '12px 16px',
    borderBottom: isLast ? 'none' : '1px solid var(--ls-border)',
    gap: '12px',
  };

  // axes 缺省 (契约未落地前的过渡态) 一律按 published 渲染 —— 这跟旧
  // `lesson.status ?? 'generated'` 的降级方向一致: 不知道就假设"可读",
  // 不让一个还没接上的字段把真实课程晾成"未生成"的视觉。title 的明暗仍由
  // 它决定; icon 不再看它 (三态字形案, 见组件头注)。
  const published = lesson.axes ? lesson.axes.content === 'published' : true;
  const learning = lesson.axes?.learning;
  const glyphState: 'not_started' | 'in_progress' | 'done' =
    learning === 'completed_declared' || learning === 'closed'
      ? 'done'
      : learning === 'in_progress'
        ? 'in_progress'
        : 'not_started';

  // 18px — 共享行首行高: 圆点盒子、序号、标题三者都定成这个高度, 三个 flex
  // 子项在 items-start 的行容器里各自顶边对齐, 高度一致就意味着中线也自动
  // 对齐, 不用再猜字体基线的偏移量 (LINE_HEIGHT 只影响首行, summary 第二行
  // 不受影响仍然往下排).
  const LINE_HEIGHT = '18px';

  const orderLabel = (
    <span
      className="text-[11px] tabular-nums text-[var(--ls-text-tertiary)]"
      style={{ flexShrink: 0, width: '24px', lineHeight: LINE_HEIGHT }}
    >
      {String(lesson.order).padStart(2, '0')}
    </span>
  );

  const titleBlock = (
    <div className="flex-1 min-w-0">
      <div
        className="text-[13px] font-medium truncate"
        style={{
          color: published ? 'var(--ls-text)' : 'var(--ls-text-secondary)',
          lineHeight: LINE_HEIGHT,
        }}
      >
        {lesson.title}
      </div>
      {lesson.summary && (
        <div
          className="text-[12px] leading-[18px] text-[var(--ls-text-tertiary)] truncate"
          style={{ marginTop: '2px' }}
        >
          {lesson.summary}
        </div>
      )}
    </div>
  );

  return (
    <li>
      <Link
        to={`/courses/${courseId}/lessons/${lesson.id}`}
        className="flex items-start hover:bg-[var(--ls-panel)] transition-colors"
        style={baseStyle}
      >
        {/* 固定 14x18 盒子 (18 = LINE_HEIGHT), inline-flex 居中 ROW_DOT_DIAMETER
            (10px, 见 ../components/StateDot) 圆点 — 不再靠字体基线定位 (旧版
            paddingTop:1px 手调是对字形偏移的猜测, 换字体/换语言就漂). 14px
            盒宽仍留出比圆点大的余量, 居中构造不受直径变化影响. 宽度 14px
            沿用 pages/Cards.tsx CardRow 的圆点列宽, 跟全站圆点列对齐。 */}
        <span
          style={{
            flexShrink: 0,
            width: '14px',
            height: LINE_HEIGHT,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <LessonStateDot state={glyphState} />
        </span>
        {orderLabel}
        {titleBlock}
        {revisedUnread && (
          <span
            style={{
              flexShrink: 0,
              height: LINE_HEIGHT,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <RevisedFlag />
          </span>
        )}
        <span
          style={{
            flexShrink: 0,
            height: LINE_HEIGHT,
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          <LessonStatusBadge state={progressState} />
        </span>
      </Link>
    </li>
  );
}
