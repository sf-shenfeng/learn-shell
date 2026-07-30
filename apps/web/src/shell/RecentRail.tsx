/**
 * RecentRail — left-nav sub-section under main routes.
 *
 * Recent 栏替换案 — replaces ConceptsRail (design-era static demo tree, never wired
 * to real data — no `getConcepts` method even exists on Repository).
 * Ruling: "Concepts 是最早 Design 期的遗物没有用". This rail is "回到你上次的
 * 地方" — up to four quiet, stateful quick-entries (awaiting signature /
 * continue / due / recent mindmap), each hidden when it has nothing to
 * show, under a "Recent" label. No dashboard, no chrome — just a way back in.
 *
 * 证书化 (2026-07-08): the "awaiting signature" row is new — Contract page's
 * nav entry is dead, so a `propose_contract`-drafted contract needs this as
 * its one non-badge surfacing point (see the query near the bottom of this
 * function for the detail).
 *
 * These rows read through existing Repository methods + React Query;
 * several deliberately reuse other pages' exact query keys (['courses',...],
 * ['lessons',...]) so the cache is shared instead of double-fetched when
 * both the sidebar and that page are mounted. No new endpoints, no
 * repository changes — Recent 栏替换案 brief §军规.
 *
 * 卡池抽屉化 二期: the pool row no longer navigates to a /pool route — Pool
 * is now a drawer (apps/web/src/pool/PoolDrawer.tsx) summoned from here via
 * `onOpenPool`, a plain callback threaded down from AppShell's lifted
 * `poolOpen` state (mirrors the existing paletteOpen/CommandPalette wiring
 * one level up — no new Context needed since this row is a direct child of
 * AppShell already).
 *
 * Dashboard 裁撤案: ['due', pairId] used to also be shared with Dashboard (now
 * 裁撤) — see its own inline comment below, kept unchanged to avoid a
 * needless cache-key churn for a key only this file reads now.
 *
 * 卡池常驻行案: the pool row is no longer one of the "hidden when empty" Recent
 * entries — it graduated into its own always-rendered row below Recent
 * (`PoolRow`, near the bottom of this file), N=0 included, with a trailing
 * `G P` kbd hint. It still shares ['pending-cards', pairId] with Cards.tsx/
 * PoolDrawer, unchanged.
 *
 * 批F: a `NotesRow` sits directly under `PoolRow`, same always-rendered/
 * N=0-included visibility rule and the same badge dialect (count + trailing
 * kbd chip, this time `G N`) — copied item-for-item from PoolRow, not a new
 * design. Opens journal/NotesDrawer.tsx via `onOpenNotes`, threaded down
 * from AppShell's lifted `notesOpen` state exactly like `onOpenPool` above.
 *
 * 最近接触 (2026-07-30): 本栏叫 Recent, 但四行原本都按"最近被写过"取数——
 * 课程行认 course_refs(从没被写过, 见下), 导图/文档行认 updated_at(只在编辑时
 * 变)。读一份文档、看一张图、翻一节课, 都不会让它排到前面来。修法统一:
 * 每行"最近接触事件时间与既有排序键取较新者", 无事件的存量数据原样回落。
 * 事件跑既有 sessions/events 轨道 (lesson.viewed / document.viewed /
 * mindmap.viewed), 无新表新列。
 *
 * 轻量计数案 遗留优化点 (轻量计数端点): count used to come from running
 * NotesDrawer's full `useJournalNotes()` fan-out (courses → per-course
 * lessons → per-lesson annotations, plus a free-notes fetch) just for
 * `entries.length + orphans.length`. Now it's one `getAnnotationCountForPair`
 * call against `GET /pairs/:pairId/annotations/count` (own query key,
 * `['notes-count', pairId]` — not shared with NotesDrawer's keys, since this
 * row and the drawer now run genuinely different queries: a number vs. the
 * full listing).
 */

import { Link } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { CourseId, LessonProgress, Repository, SessionEvent } from '@learn-shell/contracts';
import {
  latestTouchedLesson,
  latestViewedCourse,
  latestViewedDeck,
  latestViewedLesson,
} from './recentSignals';
import { useRepository } from '../repository';
import type { ProgressRepo } from '../repository/progressExt';
import { usePair } from './PairProvider';
import { useT } from '../i18n';
import { useJournalRepo } from '../journal/useJournalNotes';
import { useDocumentRepo } from '../document/useDocumentRepo';
import Kbd from './Kbd';
import HoverScrollText from '../components/HoverScrollText';

// 最近接触二期 (2026-07-30): 这四个挑"最近碰的是哪一个"的纯函数原本内联在
// 这里, 已拆到 ./recentSignals.ts —— 唯一理由是可测 (web 的测试只吃 .ts, 进
// 不了 .tsx), 逻辑一行未改。见该文件与 recentSignals.test.ts。

export default function RecentRail({
  onOpenPool,
  onOpenNotes,
}: {
  onOpenPool: () => void;
  onOpenNotes: () => void;
}) {
  const repo = useRepository();
  const { pairId } = usePair();
  const { t } = useT();
  const enabled = !!repo && !!pairId;

  // -------- 最近事件流 (Lesson 行与 Review 行共用) --------
  // 最近接触修法 (2026-07-30): 这里原本按 `s.course_refs.includes(courseId)`
  // 挑 session —— 而 `learning_sessions.course_refs` 从来没有任何写路径填过
  // (appendSessionEvent 的 course_ref 入参全库无人传, 见 lib/session-events.ts),
  // 所以那个 find 恒为 undefined, 事件查询恒不 enabled, lesson.viewed 一直没
  // 通电, 本行永远显示课程第一课。
  //
  // 二期 (同日, 学习者实测后): 从"只看最近一场"扩到"getRecentSessions 拿回来
  // 的这几场全看"。取舍写在明处 ——
  //   · 只看最近一场便宜 (1 个请求), 但会撒谎: session 按 30 分钟窗口切, 她
  //     两小时前读的那节课在上一场里; 而最近这场完全可能只有 document.viewed
  //     / trial.attempted 之类的事件, 一条 lesson.viewed 都没有, 于是这行退
  //     回契约课程 —— 正是学习者报的那个症状。
  //   · 扫这几场要多几个 GET, 但每场一个独立 query key, 已结束的场次事件不再
  //     变化, React Query 缓存住之后是零成本; 边栏本来就常驻不卸载。
  // 几个小 GET 换"不对她撒谎", 买。
  const sessionsQ = useQuery({
    queryKey: ['recent-rail', 'sessions', pairId],
    queryFn: () => (repo && pairId ? repo.getRecentSessions(pairId, 5) : Promise.resolve([])),
    enabled,
  });
  const recentSessions = sessionsQ.data ?? [];
  const sessionEventQs = useQueries({
    queries: recentSessions.map((s) => ({
      queryKey: ['recent-rail', 'session-events', s.id],
      queryFn: () => (repo ? repo.getSessionEvents(s.id) : Promise.resolve([] as SessionEvent[])),
      enabled,
    })),
  });
  // 拍平成一条流 —— 下面三个 latestViewed* 各自按 occurred_at 取最大值, 不依
  // 赖顺序, 所以这里不需要再排序。
  const recentEvents = sessionEventQs.flatMap((q) => q.data ?? []);

  // -------- Row 1: Continue learning --------
  // 课程选择 (最近接触二期, 2026-07-30 学习者裁决): 最新一条带 course_id 的
  // `lesson.viewed` → 活跃契约的课 → 最新创建的课。头两档之外的兜底与改前逐
  // 位相同 —— 改的只是在最前面插了"她最近真的在读哪门课"这一档。
  // "Current lesson" = the lesson whose `lesson.viewed` event is freshest
  // across the pair's recent sessions; falls back to the course's first
  // ready lesson (课内选节的两信号逻辑本次未动)。
  const contractQ = useQuery({
    queryKey: ['recent-rail', 'contract', pairId],
    queryFn: () => (repo && pairId ? repo.getActiveContract(pairId) : Promise.resolve(null)),
    enabled,
  });
  const coursesQ = useQuery({
    queryKey: ['courses', pairId], // shared key with Courses page (Dashboard 裁撤案: Dashboard 已裁撤)
    queryFn: () => (repo && pairId ? repo.getCourses(pairId) : Promise.resolve([])),
    enabled,
  });
  const courses = coursesQ.data ?? [];
  const fallbackCourseId = [...courses].sort((a, b) =>
    (b.created_at ?? '').localeCompare(a.created_at ?? '')
  )[0]?.id;
  // 第一优先: 她最近真的翻开过的那门课。防御一道 —— 事件里的 course_id 可能
  // 指向一门已经删掉的课, 那就当它不存在, 往下走兜底 (courses 还没到之前不做
  // 这个判断, 否则会先按契约课拉一轮 lessons 再切, 白跑一个请求)。
  const viewedCourseId = latestViewedCourse(recentEvents)?.courseId;
  const viewedCourseUsable =
    viewedCourseId && (!coursesQ.data || courses.some((c) => c.id === viewedCourseId))
      ? viewedCourseId
      : undefined;
  const courseId =
    viewedCourseUsable ?? (contractQ.data?.course_id as CourseId | undefined) ?? fallbackCourseId;
  const course = courses.find((c) => c.id === courseId);

  const lessonsQ = useQuery({
    queryKey: ['lessons', courseId], // shared key with Courses page's CourseCard
    queryFn: () => (repo && courseId ? repo.getLessons(courseId) : Promise.resolve([])),
    enabled: enabled && !!courseId,
  });
  // 第二根信号, 与上面取较新者 —— 共享 Courses.tsx / Lesson.tsx 的
  // ['course-progress', pairId, courseId] 缓存, 逛过课程页就是零请求。
  const progressRepo = repo as (Repository & ProgressRepo) | null;
  const courseProgressQ = useQuery({
    queryKey: ['course-progress', pairId, courseId],
    queryFn: () =>
      progressRepo && pairId && courseId
        ? progressRepo.getCourseProgress(pairId, courseId as CourseId)
        : Promise.resolve([] as LessonProgress[]),
    enabled: !!progressRepo && !!pairId && !!courseId,
  });

  // 迁移 0030: Lesson.status(生成态) 列拆除 — 该列从未被真实写路径写过, 这
  // 里的 filter 恒真 (status 永远 undefined ?? 'generated' === 'generated'),
  // 直接去掉过滤, 保留排序。
  const readyLessons = [...(lessonsQ.data ?? [])].sort((a, b) => a.order - b.order);
  const viewedLesson = latestViewedLesson(recentEvents);
  const touchedLesson = latestTouchedLesson(courseProgressQ.data);
  // 两根信号取较新者; 都没有(或指向的课不在本课程里)才回落到第一课 —— 与改前
  // 的兜底逐位相同。
  const lastTouchedLessonId = [viewedLesson, touchedLesson]
    .filter((x): x is { lessonId: string; at: string } => !!x)
    .sort((a, b) => b.at.localeCompare(a.at))[0]?.lessonId;
  const currentLesson = readyLessons.find((l) => l.id === lastTouchedLessonId) ?? readyLessons[0];

  // -------- Row 2: Due reviews --------
  const dueQ = useQuery({
    queryKey: ['due', pairId], // Dashboard 裁撤案: 曾与已裁撤的 Dashboard 共享此 key；
    // Review 页自己的到期计数用的是 ['due-full', pairId] (不同 key) ——
    // 这个 key 现在只有 RecentRail 一处在用，留着不改防止无谓抖动缓存。
    queryFn: () => (repo && pairId ? repo.getDueReviews(pairId) : Promise.resolve([])),
    enabled,
  });
  const dueCount = dueQ.data?.length ?? 0;
  // 最近接触二期 (2026-07-30 学习者裁决): 本行原本只有"Review · N 到期", 一
  // 个最近性语义都没有 —— 她刚复习完某一组卡, 回头左栏还是那句干巴巴的计数。
  // 现在带上她最近停留的那一组卡的名字, 并深链回去。
  // deck 在本产品里没有独立标题字段, deck_id 本身就是人读的名字 (DeckRail 直
  // 接拿它当行标签渲染), 所以这里显示的就是它。
  const viewedDeck = latestViewedDeck(recentEvents);

  // -------- Row 3: Pending pool --------
  const pendingQ = useQuery({
    queryKey: ['pending-cards', pairId], // shared key with Cards page
    queryFn: () => (repo && pairId ? repo.getPendingCards(pairId) : Promise.resolve([])),
    enabled,
  });
  const pendingCount = pendingQ.data?.length ?? 0;

  // -------- 批F: 笔记常驻行 (与卡池行同级同逻辑) --------
  // 轻量计数案: lightweight count endpoint instead of NotesDrawer's full
  // useJournalNotes() fan-out — see file header comment.
  const journalRepo = useJournalRepo();
  const notesCountQ = useQuery({
    queryKey: ['notes-count', pairId],
    queryFn: () =>
      journalRepo && pairId ? journalRepo.getAnnotationCountForPair(pairId) : Promise.resolve(0),
    enabled: !!journalRepo && !!pairId,
  });
  const notesCount = notesCountQ.data ?? 0;

  // -------- Row 4: Recent mindmap --------
  const mindmapsQ = useQuery({
    queryKey: ['recent-rail', 'mindmaps', pairId],
    queryFn: () => (repo && pairId ? repo.getAllMindmaps(pairId) : Promise.resolve([])),
    enabled,
  });
  // 最近接触 (2026-07-30): 排序从这里挪到服务端 —— 这里只能按 updated_at 排
  // (看图不动它), 服务端能把 mindmap.viewed 事件时间一起纳进 greatest(...),
  // 见 routes/read.ts 的 GET /pairs/:pairId/mindmaps。
  const latestMindmap = (mindmapsQ.data ?? [])[0];

  // -------- Row 5: Recent document (批G,
  // 门牌) — lightweight endpoint (id/title/updated_at only), same 轻量计数端点手法
  // annotations/count already established rather than fetching full
  // getDocuments() rows just to read three fields off the first one. --------
  const documentRepo = useDocumentRepo();
  const recentDocumentsQ = useQuery({
    queryKey: ['recent-rail', 'documents', pairId],
    queryFn: () =>
      documentRepo && pairId ? documentRepo.getRecentDocuments(pairId, 1) : Promise.resolve([]),
    enabled: !!documentRepo && !!pairId,
  });
  const latestDocument = recentDocumentsQ.data?.[0];

  // -------- Row 0: Awaiting your signature (证书化, 2026-07-08) --------
  // Contract page's nav entry is dead; a `propose_contract`-drafted contract
  // (setup_status: 'proposed') needs *some* place to surface until it's
  // signed. Shares ['contracts', pairId] with the Contract signing-table
  // page and AppShell's top-bar chip (same cache, one fetch) — oldest
  // pending contract wins if more than one is stacked up.
  const contractsQ = useQuery({
    queryKey: ['contracts', pairId],
    queryFn: () => (repo && pairId ? repo.getAllContracts(pairId) : Promise.resolve([])),
    enabled,
  });
  const pendingContract = (contractsQ.data ?? [])
    .filter((c) => c.setup_status === 'proposed')
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))[0];

  // 卡池常驻行案: Pool 的行走了之后，剩下的三行全是导航链接——不再需要
  // link/button 两种 kind 的联合类型 (原来 button 变体专为 Pool 那行存在,
  // 见下方 PoolRow, 它现在是自己的常驻行, 不进这个数组了).
  type Row = { key: string; to: string; label: string; title: string };

  const rows: Row[] = [];
  if (pendingContract) {
    const goalClipped =
      pendingContract.goal.length > 28
        ? pendingContract.goal.slice(0, 28) + '…'
        : pendingContract.goal;
    rows.push({
      key: 'pending-contract',
      to: `/contract/${pendingContract.id}`,
      label: `${t('contract.awaitingSignature')} · ${goalClipped}`,
      title: t('header.pendingContract.hint'),
    });
  }
  if (course && currentLesson) {
    rows.push({
      key: 'continue',
      to: `/courses/${courseId}/lessons/${currentLesson.id}`,
      // 最近接触二期 (2026-07-30 学习者裁决): 行文案显示节标题而非课程名 ——
      // 链接落点就是这一节, 名字与落点同物; 课程名留在 title (hover) 里当上
      // 下文, 与 Document/Mindmap 行"裸名字"的方言一致。
      label: currentLesson.title,
      title: `${t('recentRail.continuePrefix')}${course.topic} · ${currentLesson.title}`,
    });
  }
  // 严格 Recents 语义 (2026-07-30 裁决): 门是"有到期 **或** 有最近复习对象"。
  // 原先只认 dueCount > 0 —— 她刚把某组卡复习完、到期归零, 这行反而消失, 恰好
  // 违背"Recents 是回到你上次的地方"这条既有裁定 (与到期与否无关)。
  // 两者都没有时整行照旧隐藏, 与改前逐位相同。
  //
  // 深链走 `?deck=`: /review 本来就认这个 search param (pages/Review.tsx 的
  // deckParam, Cards.tsx 早就在这么链了), 不是为本次新造的路由。
  if (dueCount > 0 || viewedDeck) {
    // 文案三档:
    //   · 有对象 + 有到期 → 名字 · N 到期
    //   · 有对象 + 零到期 → **只留名字**。零计数不是信息是噪音, 照 Document /
    //     Mindmap 两行"裸名字"的方言 (它们从来不带计数)。
    //   · 无对象 + 有到期 → 原文案原链接, 与改前逐位相同。
    const label = viewedDeck
      ? dueCount > 0
        ? `${viewedDeck.deckId} · ${dueCount}${t('recentRail.dueSuffix')}`
        : viewedDeck.deckId
      : `${t('nav.review')} · ${dueCount}${t('recentRail.dueSuffix')}`;
    rows.push({
      key: 'due',
      to: viewedDeck ? `/review?deck=${encodeURIComponent(viewedDeck.deckId)}` : '/review',
      label,
      title: viewedDeck
        ? `${t('recentRail.reviewPrefix')}${viewedDeck.deckId}`
        : `${dueCount}${t('recentRail.dueTitleSuffix')}`,
    });
  }
  if (latestMindmap) {
    rows.push({
      key: 'mindmap',
      to: `/mindmap?map=${latestMindmap.id}`,
      label: latestMindmap.title,
      title: `${t('recentRail.mindmapPrefix')}${latestMindmap.title}`,
    });
  }
  if (latestDocument) {
    rows.push({
      key: 'document',
      to: `/documents/${latestDocument.id}`,
      label: latestDocument.title,
      title: `${t('recentRail.documentPrefix')}${latestDocument.title}`,
    });
  }

  return (
    <div className="mt-6" style={{ padding: '0 10px' }}>
      {rows.length > 0 && (
        <>
          <div className="text-[11px] font-medium tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)] mb-2.5">
            {t('recentRail.heading')}
          </div>
          <ul className="flex flex-col gap-1.5 text-[12px] leading-4 text-[var(--ls-text-secondary)]">
            {rows.map((r) => (
              <RecentItem key={r.key} to={r.to} label={r.label} title={r.title} rowKey={r.key} />
            ))}
          </ul>
        </>
      )}

      {/* 卡池常驻行案: 卡池常驻行 — Recent 区块的同级邻居，不共享它的区块
          标题。Recent 有内容时用一道极淡的顶部分隔线隔开；Recent 为空时
          （新账号/无课）它就是这里唯一的行，不需要分隔线。 */}
      <PoolRow
        count={pendingCount}
        onOpen={onOpenPool}
        withDivider={rows.length > 0}
      />
      {/* 批F: 笔记常驻行，紧跟卡池行——两者是同一个"常驻行"视觉块，块顶的
          分隔线已经由 PoolRow 画过了，这里不再重复画一道。 */}
      <NotesRow count={notesCount} onOpen={onOpenNotes} />
    </div>
  );
}

const recentRowClassName =
  'w-full flex items-center gap-[7px] py-0.5 -mx-1.5 rounded-[5px] ' +
  'hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]';

// 定版设计: 右对齐灰阶小文字类型标签 (不用色点/彩色图标——色点语义已被
// 完成标志征用)。key 就是 rows 数组里的类型判别符 (见上方 Row 构建处);
// startsWith 匹配以防某个 key 将来带上后缀/前缀而不失配。
const ROW_TYPE_LABELS: { match: string; label: string }[] = [
  { match: 'pending-contract', label: 'Contract' },
  { match: 'continue', label: 'Lesson' },
  { match: 'due', label: 'Review' },
  { match: 'mindmap', label: 'Mindmap' },
  { match: 'document', label: 'Document' },
];

function rowTypeLabel(key: string): string | undefined {
  return ROW_TYPE_LABELS.find((r) => key.startsWith(r.match))?.label;
}

function RecentItem({ to, label, title, rowKey }: { to: string; label: string; title: string; rowKey: string }) {
  const typeLabel = rowTypeLabel(rowKey);
  return (
    <li>
      <Link
        to={to}
        title={title}
        className={recentRowClassName}
        style={{ paddingLeft: '6px', paddingRight: '6px' }}
      >
        {/* 悬停滚动读全案: 220px 的左栏里长课名/长文档名一定截断，hover 400ms
            后在原地往返滚一趟读全（未溢出的行完全静止，见 HoverScrollText）。 */}
        <HoverScrollText className="truncate min-w-0 flex-1" text={label} />
        {typeLabel && (
          <span className="flex-shrink-0 text-[10px] text-[var(--ls-text-tertiary)]">
            {typeLabel}
          </span>
        )}
      </Link>
    </li>
  );
}

// 卡池常驻行案: 卡池常驻行 — same row dialect as RecentItem/RecentButtonItem
// (same hover/padding), but lives outside the <ul> as Recent's sibling and
// always renders regardless of count. Trailing kbd chip mirrors
// annotation/AnnotationPill.tsx's `<kbd>` (the H-confirm hint there) so the
// "there's a shortcut for this" affordance reads the same everywhere.
function PoolRow({
  count,
  onOpen,
  withDivider,
}: {
  count: number;
  onOpen: () => void;
  withDivider: boolean;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onOpen}
      title={count > 0 ? `${count}${t('recentRail.poolWaitingSuffix')}` : t('recentRail.poolEmpty')}
      className={`${recentRowClassName} text-left bg-transparent border-0 cursor-pointer text-[12px] leading-4 ${
        withDivider ? 'mt-2 pt-2 border-t border-[var(--ls-border)]' : ''
      }`}
      style={{ paddingLeft: '6px', paddingRight: '6px' }}
    >
      <HoverScrollText
        className="truncate min-w-0 flex-1"
        style={{ color: count === 0 ? 'var(--ls-text-tertiary)' : 'var(--ls-text-secondary)' }}
        text={`${t('nav.pool')} · ${count}`}
      />
      <Kbd className="flex-none">G P</Kbd>
    </button>
  );
}

// 批F: 笔记常驻行 — PoolRow 原样复制过来的第二份, 差别只有三处: 文案
// (journal.notes.title / recentRail.notesEmpty)、kbd (G N)、以及从不画顶部
// 分隔线 (它紧跟在 PoolRow 后面, 分隔线的活儿 PoolRow 已经干过了, 两行一起
// 构成同一个"常驻行"视觉块)。
function NotesRow({ count, onOpen }: { count: number; onOpen: () => void }) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onOpen}
      title={count > 0 ? `${count}${t('recentRail.notesSavedSuffix')}` : t('recentRail.notesEmpty')}
      className={`${recentRowClassName} text-left bg-transparent border-0 cursor-pointer text-[12px] leading-4`}
      style={{ paddingLeft: '6px', paddingRight: '6px' }}
    >
      <HoverScrollText
        className="truncate min-w-0 flex-1"
        style={{ color: count === 0 ? 'var(--ls-text-tertiary)' : 'var(--ls-text-secondary)' }}
        text={`${t('journal.notes.title')} · ${count}`}
      />
      <Kbd className="flex-none">G N</Kbd>
    </button>
  );
}
