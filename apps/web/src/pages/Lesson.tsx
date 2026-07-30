import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import PagedLesson from '../lesson/PagedLesson';
import MindmapEmbed from '../mindmap-embed/MindmapEmbed';
import { focusOverlayStyle, FocusToggleButton } from '../shell/FocusOverlay';
import {
  LessonCourseRail,
  readLessonCourseRailCollapsed,
  LESSON_COURSE_RAIL_COLLAPSED_KEY,
  COURSE_RAIL_STRIP_W,
  COURSE_RAIL_PANEL_W,
} from '../lesson/LessonCourseRail';
import type {
  AnnotationId,
  CourseId,
  Lesson as LessonModel,
  LessonId,
  Exercise,
  ExerciseSubmission,
  AwaitingRole,
  LiveSession,
  LiveSessionId,
  LiveSessionListItem,
  TeachingMove,
  TeachingMoveId,
  TeachingResponse,
  Repository,
  LessonProgress,
} from '@learn-shell/contracts';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';
import { useAgentBridge } from '../shell/useAgentBridge';
import { useIdentity, cleanAgentName } from '../lib/identity';
import { useT } from '../i18n';
import type { DictKey } from '../i18n/dict';
import { ConfidencePicker } from '../lib/ConfidencePicker';
import { useConfidenceModeEnabled } from '../lib/useConfidenceMode';
import { CONFIDENCE_ANCHOR_PCT, type ConfidenceLevel } from '../lib/confidence';
import type { ConfidenceCaptureRepo } from '../repository/confidenceCaptureExt';
import { AlreadyGradedError, type ProgressRepo } from '../repository/progressExt';
import {
  learnerCloseDeclaredAt,
  SessionTerminalError,
  type OnboardingRepo,
} from '../repository/onboardingExt';
import { LessonStatusBadge } from '../lesson/LessonStatusBadge';
import { StatusPillButton } from '../components/StatusPill';
import SummonAgentCard from '../lesson/SummonAgentCard';
import { LessonAxesBar } from '../lesson/LessonAxesBar';
import type { LessonWithAxes } from '../lesson/axes';
// 教学记录挂批注 (第三种宿主, 学习者需求 2026-07-18) — the same learning
// machine PagedLesson/DocumentReader mount, pointed at a completed live
// session's read-only record. 不新造平行零件: same hook, same pill/overlay/
// notes panel; only the host (and its per-move anchoring, see
// annotation/useAnnotations.ts live branches) differs.
import { useAnnotations } from '../annotation/useAnnotations';
import AnnotationPill from '../annotation/AnnotationPill';
import AnnotationOverlay from '../annotation/AnnotationOverlay';
import AnnotationNotesPanel from '../annotation/AnnotationNotesPanel';
import type { AnnotationHost } from '../annotation/host';
// 注: 评估三通道的共享次要件 (journal/entries/shared.tsx 的 SecondaryDisclosure
// / EvidenceRefsLine) 曾在这里 import —— 随两个评估区撤出课文页一并去掉
// (2026-07-26 去重裁定)。它们仍是 Journal 条目卡的现役零件, 只是课文页不再
// 是它们的第二个宿主。

/**
 * Lesson — single lesson page (batch 六 rewrite of the Stage 7b two-column
 * layout).
 *
 *   Main column   — Self-study (paged lesson + mindmap + exercises)
 *   Right panel   — Live Teaching chat, sticky, toggleable, collapsible to
 *                   a thin rail, and squeezed together with the main
 *                   column as the window narrows (see MAIN_MIN/LIVE_MIN
 *                   below — 三折布局案).
 *
 * Focus (Focus 单按钮化) is a single button in the page header now: no live
 * session → fullscreen single-column self-study; a live session engaged
 * (livePanelOpen, which auto-flips true once a session goes 'active')
 * → fullscreen left/right classroom split. Same FocusOverlay escape hatch
 * as Mind Map / Review.
 *
 * 导航轨案 追加 (方案A), 召唤状态机 v3 状态机修订 (作者原句
 * 逐字执行): the live column (aside + its 40px rail) doesn't render at all
 * — not even CSS-hidden — while there's no Live session record for this
 * lesson at all AND the learner hasn't revealed it this mount; see
 * `hasLiveSession` / `liveColumnEligible` / `showLiveColumn`. "有会话" means
 * ANY session record exists (active / completed / cancelled / expired) —
 * 导航轨案's original "only if ended in front of me this mount" grace is
 * superseded: a completed session's history must persist across a refresh
 * (it's this lesson's live 教学记录, not a transient toast), same for a
 * cancelled/expired zombie offering a fresh restart.
 *
 * 尾巴 B (召唤状态机 v3 flagged gap, 补齐于 2026-07-18): the true "never had ANY
 * live session" (处女课) case used to have no reachable column at all — the
 * header pill's onClick called startLiveMut() directly, so the summon card
 * (branch 3 below) was dead code for a lesson that had never been taught.
 * Fixed by adding a per-mount `virginRevealed` flag: a virgin lesson's first
 * pill click no longer starts anything — it only flips `virginRevealed` and
 * opens the panel, which is enough for `liveColumnEligible` to mount the
 * column. LiveTeaching then falls into its own 'summon' branch (still no
 * real session), which renders SummonAgentCard and waits. 学习者裁决
 * (2026-07-20): 学习者侧再也没有"开课"这个动作了— 老师(agent)在自己那侧
 * 用 MCP live_session_start 开课, 这个页面只靠 active-session 的轻量轮询
 * (pollActiveSessionRef, 见 LiveTeaching) 自动发现并切到 'live'。Once a
 * real session exists, hasLiveSession takes over
 * permanently and `virginRevealed` stops mattering (reset to false on every
 * lessonId change so it never leaks into another virgin lesson). The main
 * self-study column takes the freed width (prose still capped at 65ch) and
 * the course nav rail sits flush against it. Once the column is eligible it
 * mounts and, from then on, behaves exactly as documented below: mounted
 * but hidden when closed AND when rail-collapsed (preserves chat state /
 * in-progress draft across both).
 *
 * Inside the column, `LiveTeaching` runs its own three-branch state
 * machine (召唤状态机 v3; gap-4 修订 2026-07-18 — "graduated" comes from an
 * independent latest-COMPLETED query, NOT the latest session's status,
 * because a cancelled/expired retry started after a completed class used
 * to mask that history and dump the page back on the summon branch):
 *   1. active     → normal in-progress teaching UI (a class in progress
 *      outranks history); if the agent bridge drops mid-session, a thin
 *      banner appears under LiveStatusBar instead of interrupting with
 *      the summon card (召唤状态机 v3 现病 fix).
 *   2. any completed session exists → read-only teaching history
 *      (MoveStream of that completed session), no summon card, no start
 *      CTA — this lesson's live has "graduated".
 *   3. neither → summon card + start CTA (first-summon / re-summon
 *      scenario; cancelled/expired zombies land here too).
 * The header pill's label also tracks branch 1: once a completed session
 * exists it reads "教学记录"/"Teaching History" instead of the generic
 * Live Teaching label, so a graduated lesson is visually distinct from one
 * that never had (or is mid-) a live session.
 *
 * The live chat is a structural placeholder: messages flow client-side only.
 * W2+ wires it to the Agent via MCP.
 */

// Non-focus two-column squeeze (三折布局案 — "三折"): main content and the
// live panel now share the pressure of a narrowing window instead of only
// the main column giving way. Both get a flex-basis + min/max so the
// browser's flex distribution shrinks them together; below MAIN_MIN+GAP+
// LIVE_MIN the live column auto-collapses to a rail rather than forcing an
// overflow scrollbar.
const MAIN_MIN = 420;
const LIVE_MIN = 300;
const LIVE_BASE = 440;
const LIVE_MAX = 480;
const RAIL_W = 40;
const COL_GAP = 28;
// 外层行 (twoCol ↔ 课程导航轨) 的栏距 — 原本是 JSX 里的 '20px' 字面量,
// 挤压阈值要算它, 提成常数一处定义。
const OUTER_GAP = 20;
const COL_TRANSITION =
  'flex-basis 220ms cubic-bezier(0.4,0,0.2,1), min-width 220ms cubic-bezier(0.4,0,0.2,1), max-width 220ms cubic-bezier(0.4,0,0.2,1)';

const LIVE_COLLAPSED_KEY = 'learn-shell:lesson-live-collapsed';
function readLiveCollapsed(): boolean {
  try {
    return localStorage.getItem(LIVE_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

// 三折布局案 验收补刀 (2026-07-04): the rail's collapsed state was persisted
// but the panel's open state was not — after a reload the panel defaulted
// to closed, masking the surviving collapsed state entirely. Persist both
// so closed / open / open-collapsed all round-trip a refresh.
const LIVE_OPEN_KEY = 'learn-shell:lesson-live-open';
function readLivePanelOpen(): boolean {
  try {
    return localStorage.getItem(LIVE_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export default function Lesson() {
  const { courseId, lessonId } = useParams();
  // ?page=<page_index> 单向深链（URL→初始页）— Journal 笔记栏"跳回课文原位"
  // 的落点, 同款先例见 Mindmap.tsx 的
  // ?map= (导图深链案): 未知/越界值由 Pager 自己的 clampedIndex 兜底，页内
  // 切页不回写 URL — 最小刀口, 跟 ?map= 一样的取舍。
  const [searchParams] = useSearchParams();
  const pageParam = searchParams.get('page');
  const parsedPage = pageParam != null ? Number(pageParam) : NaN;
  const initialPageIndex = Number.isInteger(parsedPage) && parsedPage >= 0 ? parsedPage : undefined;
  const repo = useRepository();
  const { pairId } = usePair();
  const navigate = useNavigate();
  const [livePanelOpen, setLivePanelOpen] = useState<boolean>(() => readLivePanelOpen());
  // 课程导航轨 (导航轨案) — 默认收起, 持久化同 DocRail 先例 (DocumentReader.tsx
  // 的 DOC_RAIL_COLLAPSED_KEY 读写形状).
  const [courseRailCollapsed, setCourseRailCollapsed] = useState<boolean>(() =>
    readLessonCourseRailCollapsed()
  );
  useEffect(() => {
    try {
      localStorage.setItem(LESSON_COURSE_RAIL_COLLAPSED_KEY, courseRailCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [courseRailCollapsed]);
  // Focus (Focus 单按钮化) — single toggle in the header now (LiveStatusBar's own
  // button was removed to avoid two entry points). Its shape depends on
  // whether a live session is engaged: splitFocus = classroom (left lesson
  // / right live), singleFocus = fullscreen self-study alone.
  const [focusMode, setFocusMode] = useState(false);
  // Live rail collapse (三折布局案) — persisted, and also auto-set once the
  // two-column row gets too narrow for both minimums (see ResizeObserver
  // effect below). Only meaningful outside Focus.
  const [liveCollapsed, setLiveCollapsed] = useState<boolean>(() => readLiveCollapsed());
  // 尾巴 B (召唤状态机 v3 状态机 doc comment flagged gap 补齐, 2026-07-18): 处女课
  // (从未开过 live、无任何会话记录)专用开关。头部 pill 首次点击时先把它
  // 翻真, 让下面的 live 列挂载并让 LiveTeaching 走它自己的分支 3(只呈现
  // 召唤卡)——学习者裁决 (2026-07-20) 之后这里再也不直接开课, 开课动作已
  // 整体退役到老师侧 MCP live_session_start, 学习者只等 active-session 轮询
  // 自己发现教室开了。已经开过课的 lesson 不需要它, hasLiveSession 永远
  // 接管。换课时必须清零, 否则会把"已展开"状态错误带去另一节处女课。
  const [virginRevealed, setVirginRevealed] = useState(false);
  useEffect(() => {
    setVirginRevealed(false);
  }, [lessonId]);
  const { t } = useT();

  useEffect(() => {
    try {
      localStorage.setItem(LIVE_COLLAPSED_KEY, liveCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [liveCollapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(LIVE_OPEN_KEY, livePanelOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [livePanelOpen]);

  // Live session existence — lifted out of LiveTeaching (same query key, so
  // react-query dedupes the network call) purely to drive Focus's shape and
  // (导航轨案 追加, 方案A; 召唤状态机 v3 修订) whether the live
  // column renders at all. "有 Live 会话" now means ANY session record
  // exists for this (pair, lesson) — active, completed, cancelled, or
  // expired. 导航轨案's original mount-transient "ended in front of me" latch
  // is gone: a completed session's history (branch 1 of LiveTeaching's
  // state machine) and a cancelled/expired zombie's re-summon affordance
  // (branch 3) both need to survive a refresh, not just the same mount the
  // session ended in. Only a lesson with zero session records ever gets no
  // column — Journal's 'live' entries remain the cross-lesson permanent
  // record regardless.
  const sessionSummaryQ = useQuery({
    queryKey: ['live-session-for-lesson', pairId, lessonId],
    queryFn: () =>
      repo && pairId && lessonId
        ? repo.getLiveSessionForLesson(pairId, lessonId as unknown as LessonId)
        : Promise.resolve(null),
    enabled: !!repo && !!pairId && !!lessonId,
  });
  const liveStatus = sessionSummaryQ.data?.status;
  const hasLiveSession = !!liveStatus;
  // 召唤状态机 v3 gap-4: "这课毕业过吗" cannot be read off the LATEST session's
  // status — a cancelled/expired retry started after a completed class
  // masks it (真实案例: 间接法课, 7/03 completed 挡在 7/13 cancelled 后面).
  // Same query key as LiveTeaching's completedQ below, so react-query
  // dedupes; here it only drives the header pill's 教学记录 label.
  const completedSummaryQ = useQuery({
    queryKey: ['live-completed-session-for-lesson', pairId, lessonId],
    queryFn: () =>
      repo && pairId && lessonId
        ? repo.getCompletedLiveSessionForLesson(pairId, lessonId as unknown as LessonId)
        : Promise.resolve(null),
    enabled: !!repo && !!pairId && !!lessonId,
  });
  const hasCompletedSession = !!completedSummaryQ.data;
  // 尾巴 B: a virgin lesson the learner just revealed via the header pill
  // (no session record yet, so hasLiveSession is still false) must also
  // earn the live column — LiveTeaching mounts and falls into its own
  // 'summon' branch (召唤卡 only, see LiveStartCTA retirement note near its
  // old definition) rather than staying unreachable.
  const liveColumnEligible = hasLiveSession || virginRevealed;
  // Does the live column actually occupy width outside Focus (full panel or
  // its 40px rail both count — only livePanelOpen=false collapses that
  // allowance away entirely, same as before this job).
  const showLiveColumn = liveColumnEligible && livePanelOpen;

  // A session going active (or already active on mount) should surface the
  // panel automatically — this is also what flips Focus from single-column
  // into the classroom split without a second click.
  useEffect(() => {
    if (hasLiveSession) setLivePanelOpen(true);
  }, [hasLiveSession]);

  // splitFocus now also requires liveColumnEligible — otherwise a stale
  // livePanelOpen=true left over from a session that has since ended would
  // still claim a 45% classroom column that no longer renders anything
  // (导航轨案 追加; extended to cover the virgin-reveal case so Focus
  // doesn't hide the just-revealed summon card, 尾巴 B).
  const splitFocus = focusMode && livePanelOpen && liveColumnEligible;
  const singleFocus = focusMode && !splitFocus;

  // Esc exits Focus entirely (both flavors). Guarded against form controls
  // the same way PagedLesson guards its arrow-key pager and Mindmap guards
  // its own Escape handling.
  useEffect(() => {
    if (!focusMode) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setFocusMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMode]);

  // Three-fold squeeze (三折布局案): watch the actual rendered width of the
  // two-column row (not just window width, so a sidebar toggle counts too)
  // and force the live column into its rail once both columns can no
  // longer fit their minimums side by side. Fires only on the wide→narrow
  // crossing (dependency is the boolean, not a continuous poll) so a
  // manual re-expand isn't immediately fought if the width hasn't changed.
  const twoColRef = useRef<HTMLDivElement>(null);
  const [tooNarrow, setTooNarrow] = useState(false);
  useEffect(() => {
    if (focusMode || !showLiveColumn) {
      setTooNarrow(false);
      return;
    }
    const el = twoColRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setTooNarrow(w > 0 && w < MAIN_MIN + COL_GAP + LIVE_MIN);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [focusMode, showLiveColumn]);
  useEffect(() => {
    if (tooNarrow) setLiveCollapsed(true);
  }, [tooNarrow]);

  // 窄视口互穿 (实测逐档取证) — 上面那道"三折"只挤 twoCol 内部
  // 的 main/live 两栏；外层行的第三名成员(课程导航轨)从来不参与挤压：它是
  // flex-none 的硬 220px，而 twoCol 带 minWidth:0，于是窗口一窄，浏览器就把
  // twoCol 压到比它内容最小值还窄，main(MAIN_MIN) + COL_GAP + Live 细轨(RAIL_W)
  // 一起溢出 twoCol 的盒子——溢出物没人裁，直接画在课程轨身上。实测(mock 数据,
  // 外层行可用宽 650px): twoCol.scrollWidth 488 > clientWidth 410, Live 竖排
  // 标签与课程面板重叠 40px，再窄一档主课文也压上去，四层文字叠成一团。
  //
  // 修法照抄同文件已有的 tooNarrow 阶梯，只是把量尺架到外层行上、让位的那栏
  // 换成课程轨：放不下 220px 面板就退成 40px 细轨，连 40px 都放不下就整轨
  // 不占位。没有 matchMedia、没有断点表、没有新依赖，阈值全部由本文件既有
  // 常数推出来。
  //
  // 与 tooNarrow 的一处刻意分歧：那边是"写回 state"(setLiveCollapsed(true))，
  // 这边是派生量——railFit 直接参与渲染判断，不去改 courseRailCollapsed。理由
  // 是这条修的是"互穿"这个缺陷，写回式只是推一把、用户手动再展开就又穿回去；
  // 派生式则是硬保证，且窗口重新变宽时她原本的展开偏好原样回来，不被这次挤压
  // 抹掉。
  //
  // 量的是外层行本身(块级，宽度不随轨的胖瘦变化)，所以不存在"轨一收窄行就变宽
  // 又想展开"的抖动回路。ref 走 state callback 而不是 useRef：课文数据还在
  // loading 时这一行根本没挂载，useRef 版会静悄悄错过第一次观测。
  const [outerRowEl, setOuterRowEl] = useState<HTMLDivElement | null>(null);
  const [railFit, setRailFit] = useState<'panel' | 'strip' | 'none'>('panel');
  useEffect(() => {
    if (focusMode || !outerRowEl) {
      setRailFit('panel');
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w <= 0) return;
      // twoCol 的硬底 = 它内部那两栏当下真实的最小宽度之和：主栏 MAIN_MIN
      // + 栏距 + Live 栏(展开态 LIVE_MIN / 细轨态 RAIL_W)。读 liveCollapsed
      // 而不是假定"tooNarrow 早晚会把它折起来"——那道折叠只朝一个方向发力
      // (只 set true, 不 set false)，学习者手动展开回来时这里必须立刻跟上，
      // 所以 liveCollapsed 也进了下面的依赖数组。
      // 没有 Live 栏时主栏是 maxWidth 而非 minWidth，能一路收窄不溢出
      // (实测 scrollWidth 恒等于 clientWidth)，不占底，课程轨也就没有让位
      // 的理由。
      const twoColFloor = showLiveColumn
        ? MAIN_MIN + COL_GAP + (liveCollapsed ? RAIL_W : LIVE_MIN)
        : 0;
      setRailFit(
        w >= twoColFloor + OUTER_GAP + COURSE_RAIL_PANEL_W
          ? 'panel'
          : w >= twoColFloor + OUTER_GAP + COURSE_RAIL_STRIP_W
            ? 'strip'
            : 'none'
      );
    });
    ro.observe(outerRowEl);
    return () => ro.disconnect();
  }, [focusMode, showLiveColumn, liveCollapsed, outerRowEl]);

  const lessonsQ = useQuery({
    queryKey: ['lessons', courseId],
    queryFn: () =>
      repo && courseId
        ? (repo.getLessons(courseId as CourseId) as Promise<LessonWithAxes[]>)
        : Promise.resolve([] as LessonWithAxes[]),
    enabled: !!repo && !!courseId,
  });

  // §6/§2 (2026-07-11 施工批) — same instance as `repo`, just widened; both concrete repos
  // (Mock/Http) actually implement ProgressRepo, same cast idiom
  // ExerciseCard already uses for ConfidenceCaptureRepo below. One batch
  // query per course covers the header badge, the course-list badges
  // (Courses.tsx has its own copy of this same query key) and the
  // prerequisite banner's "is the previous lesson closed?" check.
  const progressRepo = repo as (Repository & ProgressRepo) | null;
  const courseProgressQ = useQuery({
    queryKey: ['course-progress', pairId, courseId],
    queryFn: () =>
      progressRepo && pairId && courseId
        ? progressRepo.getCourseProgress(pairId, courseId as CourseId)
        : Promise.resolve([] as LessonProgress[]),
    enabled: !!progressRepo && !!pairId && !!courseId,
    // 阅卷铃自退休 (门铃提示词案 PIN2): 铃 (SummonAgentCard variant='grading',
    // DeclareCompletedSection 的 bellVisible) 挂载条件就是这个课的
    // progress.state === 'completed_declared' — 老师那边跑
    // close-teaching-loop 收官是这个标签页感知不到的外部事件, 铃亮着的这段
    // 时间主动问一声"收了没", 状态一翻 'closed' 铃在下一次渲染就自己
    // unmount (SelfStudy 的 `progress?.state !== 'closed'` 门本来就有, 不用
    // 新逻辑)。读 q.state.data 而不是闭包里的 currentLessonProgress, 同
    // fullQ 下面那个 refetchInterval 回调一个道理——回调被 react-query 真正
    // 调用那一刻的最新值, 不受 hook 声明顺序限制。间隔对齐 LiveTeaching 的
    // pollActiveSessionRef 自动进教室轮询 (5s) — 同一量级的"页面自己定时问
    // 一声", 不是 agent 侧轮询, 与 live_wait 红线无关; 不在这个状态时
    // (false) 零开销, 同 fullQ 的写法。
    refetchInterval: (q) => {
      const list = q.state.data as LessonProgress[] | undefined;
      const state = list?.find((p) => p.lesson_id === lessonId)?.state;
      return state === 'completed_declared' ? 5_000 : false;
    },
  });
  const currentLessonProgress = courseProgressQ.data?.find((p) => p.lesson_id === lessonId);
  const currentLessonProgressState = currentLessonProgress?.state;

  // 阅卷铃自退休续 —— 这里原有一个"翻到 closed 就踹一脚 post-lesson-evaluation
  // 查询"的边沿 effect, 随 PostLessonEvaluationBlock 一起撤 (2026-07-26 去重
  // 裁定): 那个查询在本页已无订阅者, 再失效也没人重渲。现在收尾区换成
  // LessonClosureNote, 它的门槛直接吃 currentLessonProgress 本身 —— 同
  // LessonStatusBadge / DeclareCompletedSection 的路子, course-progress 轮询
  // 到 'closed' 那一刻 JSX 自然重渲, 不需要任何额外接线。

  // 修订回执制 (学习者裁决 A, 迁移 0030) — 进入这节课的课文页，就把当前
  // revision 记为服务端"已见"过。曾经是 lesson/revisionSeen.ts 的
  // localStorage 降级方案 (票二, 2026-07-17 定案) — 该模块已随这批
  // 服务端回执制退役删除; Courses.tsx 的"已修订"标现在读 axes.revision_seen
  // (见 lesson/useRevisedUnread.ts), 不再读 localStorage。
  //
  // Uses lessonsQ.data directly (not the `lesson` const below) because this
  // effect must stay above the `if (!repo) / if (lessonsQ.isLoading)` early
  // returns — same fixed hook-order constraint every other query/effect
  // here follows.
  const lessonForSeenMark = lessonsQ.data?.find((l) => l.id === lessonId);
  const seenMarkId = lessonForSeenMark?.id;
  const seenMarkRevision = lessonForSeenMark?.revision;
  useEffect(() => {
    if (!repo || !seenMarkId) return;
    repo.markRevisionSeen(seenMarkId).catch(() => {
      // 静默失败 — 已读回执不该打扰学习者的阅读体验。
    });
    // seenMarkRevision 不直接传给服务端(端点只认 lessonId, revision 由服务端
    // 现读现算) — 留在依赖数组里是为了"课文打开着的时候老师又改了一版"这种
    // 边缘场景也能重新打一次已读, 同旧实现的边界处理保持一致。
  }, [repo, seenMarkId, seenMarkRevision]);

  // 进行中接线 (迁移 0030) — 首次打开某课时的幂等 ping。touchLessonProgress
  // 服务端幂等 (not_started → in_progress，已经更靠前的状态不倒退)，这里不
  // 追踪"是不是第一次"，每次挂载都打一次，失败静默不打扰学习者。
  useEffect(() => {
    if (!repo || !lessonId) return;
    repo.touchLessonProgress(lessonId as LessonId).catch(() => {
      // 静默失败 — 这只是进度 ping，不该弹错误打断阅读。
    });
  }, [repo, lessonId]);

  // 尾巴 B (召唤状态机 v3 flagged gap 补齐, 2026-07-18): the top-level
  // startLiveMut that used to live here (导航轨案 追加) is gone — a virgin
  // lesson's header-pill click no longer kicks off a session directly, it
  // just reveals the live column's summon card (virginRevealed above).
  // 学习者裁决 (2026-07-20): LiveTeaching 内部原来也有一份对应的 startMut
  // (挂在已退役的 LiveStartCTA 按钮上) — 现在两处都没有了, 开课这件事整体
  // 搬到老师侧的 MCP live_session_start, 学习者侧不再持有任何触发开课的
  // mutation。

  if (!repo) {
    return (
      <p className="text-sm text-[var(--ls-text-secondary)]">{t('lesson.emptyMode')}</p>
    );
  }
  if (lessonsQ.isLoading) {
    return <p className="text-sm text-[var(--ls-text-tertiary)]">{t('lesson.loading')}</p>;
  }

  const lesson = lessonsQ.data?.find((l) => l.id === lessonId);
  if (!lesson) {
    return <p className="text-sm text-[var(--ls-text-secondary)]">{t('lesson.notFound')}</p>;
  }

  // Rail tab replaces LiveTeaching's own content when collapsed — the panel
  // itself stays mounted (CSS-hidden) beside it so chat state / drafts
  // survive the fold. Only meaningful outside Focus (三折布局案 scope).
  const showRailTab = !focusMode && livePanelOpen && liveCollapsed;

  return (
    <article style={focusOverlayStyle(focusMode)}>
      {/* Header */}
      <header
        className="flex items-start justify-between flex-wrap"
        style={{ marginBottom: focusMode ? '12px' : '24px', gap: '14px', flexShrink: 0 }}
      >
        <div>
          <div className="text-[11px] tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)] font-medium">
            {t('lesson.orderPrefix')}{lesson.order}{t('lesson.orderSuffix')} · ≈ {lesson.estimated_minutes} {t('lesson.min')}
          </div>
          <div className="flex items-center flex-wrap" style={{ marginTop: '4px', gap: '10px' }}>
            <h1 className="font-bold text-[26px] leading-[34px] tracking-[-0.02em]">
              {lesson.title}
            </h1>
            <RevisionPill lesson={lesson} />
            <LessonStatusBadge state={currentLessonProgress?.state} />
          </div>
          <LessonAxesBar axes={lesson.axes} />
        </div>
        {/* Live teaching pill + Focus toggle (Focus 单按钮化 — Focus moved out of
            the live panel into this global header anchor, same right-side
            language as Mind Map's Focus button). Both stay live inside
            Focus too: toggling the pill there is what flips Focus between
            its single-column and classroom-split shapes. */}
        <div className="flex items-center" style={{ gap: '8px', marginTop: '4px' }}>
          <button
            type="button"
            onClick={() => {
              // 尾巴 B (召唤状态机 v3 flagged gap 补齐): a virgin lesson (no
              // session record yet, and not yet revealed this mount) no
              // longer starts a session directly on pill click — it just
              // reveals the live column so LiveTeaching's own 'summon'
              // branch (召唤卡 only) becomes reachable. Once the
              // column is reachable (real session OR revealed), the pill
              // goes back to its original show/hide toggle job — same as a
              // lesson that already has live history.
              if (liveColumnEligible) {
                setLivePanelOpen((o) => !o);
              } else {
                setVirginRevealed(true);
                setLivePanelOpen(true);
              }
            }}
            className="inline-flex items-center border border-[var(--ls-border-strong)] text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)] font-medium transition-colors duration-[var(--ls-duration-fast)] disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              height: '32px',
              padding: '0 14px',
              borderRadius: '999px',
              fontSize: '12px',
              lineHeight: '1',
              gap: '8px',
            }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: showLiveColumn
                  ? 'var(--ls-corroborated)'
                  : 'var(--ls-text-tertiary)',
              }}
            />
            {/* 召唤状态机 v3 追加: a completed session graduates this
                lesson's live area into a read-only teaching record — the
                pill's own label tracks that so "已上过 live 且已完成" and
                "还没上过 / 正在上" are distinguishable without opening the
                panel. Independent of open/closed; the point is the label
                itself, not the toggle verb. liveColumnEligible (尾巴 B)
                covers both "has real session history" and "just revealed
                the summon card this mount" with the same open/close label —
                学习者裁决 (2026-07-20): 开课这件事已经不在学习者侧任何组件
                里了 (老师侧 MCP live_session_start), 这个 pill 纯粹是
                show/hide 面板的开关。Gap-4 修订: graduated 判定
                走 hasCompletedSession（独立 completed 查询）而非最新一场的
                status——最新是 cancelled 也遮不住毕业标；进行中的 active
                课优先于历史标, 与 LiveTeaching 的 mode 优先级一致。 */}
            {liveStatus !== 'active' && hasCompletedSession
              ? t('lesson.live.teachingHistoryLabel')
              : liveColumnEligible
                ? livePanelOpen
                  ? t('lesson.hideLiveTeaching')
                  : t('lesson.tab.live')
                : t('lesson.live.startButton')}
          </button>
          <FocusToggleButton
            active={focusMode}
            onClick={() => setFocusMode((v) => !v)}
            activeTitle={t('lesson.focus.exitTitle')}
            inactiveTitle={
              showLiveColumn
                ? t('lesson.focus.classroomTitle')
                : t('lesson.focus.selfStudyTitle')
            }
          />
        </div>
      </header>

      {!focusMode && (
        <PrerequisiteBanner
          lessons={lessonsQ.data ?? []}
          currentLessonId={lessonId as LessonId}
          progress={courseProgressQ.data ?? []}
        />
      )}

      {/* Outer row: the existing main/live two-column squeeze, plus the
          课程导航轨 (导航轨案) as a third, independent flex-none sibling —
          it doesn't participate in the main/live squeeze math (twoColRef's
          ResizeObserver only ever measured that inner div, so wrapping it
          here just means the row it measures is now whatever width is left
          after the rail, which is the correct input for that squeeze
          decision anyway). Focus 态 (both flavors) 不渲染这条轨——全屏自习/
          教室模式没有跳课的场景，接线点就是这里的 `!focusMode &&`。
          追加: 这一行现在也被量了(setOuterRowEl → railFit)，量的是"外层行
          还剩多少宽度"，决定课程轨以面板/细轨出场还是干脆不占位。 */}
      <div
        ref={setOuterRowEl}
        className="flex"
        style={
          focusMode
            ? { flex: '1 1 auto', minHeight: 0, gap: `${OUTER_GAP}px` }
            : { alignItems: 'flex-start', gap: `${OUTER_GAP}px` }
        }
      >
      {/* Two-column layout: main self-study + live panel. Focus reuses this
          exact same <main>/<aside> tree — only inline styles branch on
          focusMode/splitFocus/singleFocus — so PagedLesson and LiveTeaching
          are never unmounted across a Focus toggle or a rail collapse:
          current page index, live session state, and any in-progress
          answer draft all survive. */}
      <div
        ref={twoColRef}
        className="flex"
        style={
          focusMode
            ? { flex: '1 1 auto', minHeight: 0, minWidth: 0, gap: '20px' }
            : { flex: '1 1 auto', minWidth: 0, alignItems: 'flex-start', gap: showLiveColumn ? `${COL_GAP}px` : '0' }
        }
      >
        <main
          style={
            splitFocus
              ? {
                  flex: '0 0 55%',
                  minWidth: 0,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  overflowY: 'auto',
                }
              : singleFocus
                ? {
                    flex: `0 1 880px`,
                    width: '100%',
                    maxWidth: '880px',
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    overflowY: 'auto',
                    margin: '0 auto',
                  }
                : showLiveColumn
                  ? { flex: `1 1 640px`, minWidth: `${MAIN_MIN}px`, transition: COL_TRANSITION }
                  : // No live column occupying width (no session, or session
                    // hidden via livePanelOpen=false) — main is twoColRef's
                    // only visible child, and twoColRef itself still grows
                    // to fill the row (flex: 1 1 auto below), so without
                    // this the capped-width content packs left and dumps
                    // all the freed width as dead space before the course
                    // rail (真机报障). Auto margins on the flex item
                    // absorb that leftover space symmetrically — same
                    // centering trick singleFocus already uses below.
                    { maxWidth: '760px', margin: '0 auto', transition: COL_TRANSITION }
          }
        >
          <SelfStudy
            lesson={lesson}
            initialPageIndex={initialPageIndex}
            progress={currentLessonProgress}
          />
        </main>

        {/* Live panel — only rendered while a Live session is active, or
            just ended in front of the student this mount (导航轨案 追加,
            方案A: otherwise the column is fully gone, not just
            CSS-hidden — the ended-in-view grace keeps LiveSessionClose's
            three-part summary readable right after class). While rendered,
            it keeps the pre-existing "mounted but hidden" trick across a
            manual close or rail-collapse (preserves chat state /
            in-progress draft) — unchanged from before this job. 尾巴 B:
            gate widened to liveColumnEligible so a virgin lesson the
            learner just revealed via the header pill also mounts this
            column — LiveTeaching falls into its own 'summon' branch since
            there's still no real session record. */}
        {liveColumnEligible && (
          <aside
            style={
              splitFocus
                ? { flex: '0 0 45%', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }
                : singleFocus || !livePanelOpen
                  ? { display: 'none' }
                  : liveCollapsed
                    ? {
                        position: 'sticky',
                        top: '20px',
                        height: 'calc(100vh - 40px)',
                        flex: `0 0 ${RAIL_W}px`,
                        minWidth: RAIL_W,
                        maxWidth: RAIL_W,
                        transition: COL_TRANSITION,
                      }
                    : {
                        position: 'sticky',
                        top: '20px',
                        // 右栏滚动病 (学习者 2026-07-18 报障): this was
                        // `maxHeight` — with height:auto, the child section's
                        // own `maxHeight: '100%'` (a percentage) resolved
                        // against an indefinite height, i.e. to none, so the
                        // panel grew to full content height, its inner
                        // content column's overflowY:auto never engaged, and
                        // wheel events over the live panel fell through to
                        // the page scroller (left prose moved, right column
                        // didn't). Definite `height` — same property the
                        // collapsed-rail branch above already uses — gives
                        // the section's 100% cap something real to resolve
                        // against; short content still sits naturally at the
                        // top (the aside itself paints nothing).
                        height: 'calc(100vh - 40px)',
                        flex: `0 1 ${LIVE_BASE}px`,
                        minWidth: `${LIVE_MIN}px`,
                        maxWidth: `${LIVE_MAX}px`,
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                        transition: COL_TRANSITION,
                      }
            }
          >
            {showRailTab && <LiveRailTab onExpand={() => setLiveCollapsed(false)} />}
            <LiveTeaching
              lesson={lesson}
              onClose={focusMode ? undefined : () => setLivePanelOpen(false)}
              onCollapse={focusMode ? undefined : () => setLiveCollapsed(true)}
              classroom={splitFocus}
              hidden={showRailTab}
            />
          </aside>
        )}
      </div>
      {/* railFit 是外层行量出来的"放得下什么"——'none' 时整轨不渲染
          (连 40px 都没地方摆), 'strip' 时无视记住的展开偏好强制细轨态。
          偏好本身(courseRailCollapsed / localStorage)不被改写, 窗口一宽就
          原样回来。 */}
      {!focusMode && railFit !== 'none' && (
        <LessonCourseRail
          currentCourseId={courseId as CourseId}
          currentLessonId={lessonId as LessonId}
          collapsed={railFit === 'strip' || courseRailCollapsed}
          onToggleCollapse={() => setCourseRailCollapsed((v) => !v)}
          onSelect={(cId, lId) => navigate(`/courses/${cId}/lessons/${lId}`)}
        />
      )}
      </div>
    </article>
  );
}

/* ============================== SELF-STUDY =============================== */

function SelfStudy({
  lesson,
  initialPageIndex,
  progress,
}: {
  lesson: LessonModel;
  /** ?page= deep link (batch D, Journal 笔记栏跳回原位) — see Lesson()'s own comment. */
  initialPageIndex?: number;
  /** §6 — undefined while courseProgressQ is still
   *  loading; the declare-completed section below treats that the same as
   *  'not_started' (nothing to show yet, nothing wrong either). */
  progress?: LessonProgress;
}) {
  const { t } = useT();
  const repo = useRepository() as (Repository & ProgressRepo) | null;

  // §4 改课三律落点 (teacher_note/erratum) — one fetch per lesson, handed to
  // PagedLesson for anchor-resolved inline rendering (see PagedLesson.tsx's
  // splitPatchesByPage).
  const patchesQ = useQuery({
    queryKey: ['lesson-patches', lesson.id],
    queryFn: () => (repo ? repo.getLessonPatches(lesson.id) : Promise.resolve([])),
    enabled: !!repo,
  });

  // §6 完成核对单预览 — furthest page reached this mount, lifted from
  // PagedLesson purely for the declare-completed checklist's own preview;
  // not persisted anywhere until the learner actually clicks declare. The
  // authoritative page count the server actually writes into the checklist
  // snapshot no longer trusts this number (迁移 0037, 学习者裁决第三针) — it
  // comes from lesson_progress.pages_visited instead; `currentPageIndex`
  // below is forwarded to declare-completed as a same-request fallback for
  // whichever page a touch() call hasn't reached the server for yet.
  const [pagesRead, setPagesRead] = useState(0);
  const [pagesTotal, setPagesTotal] = useState(0);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);

  // Mindmap/exercises/footer are always shown now (Focus 单按钮化 — Focus's
  // classroom column used to CSS-hide these; the whole self-study stack is
  // now the same regardless of layout, only the enclosing <main>'s
  // flex/overflow changes across non-focus / split-focus / single-focus).
  // ExerciseCard's in-progress answer draft lives in its own local state —
  // it survives because this tree never unmounts across those transitions.
  return (
    <>
      <PagedLesson
        lesson={lesson}
        initialPageIndex={initialPageIndex}
        patches={patchesQ.data ?? []}
        onPagesRead={(read, total, currentIdx) => {
          setPagesRead(read);
          setPagesTotal(total);
          setCurrentPageIndex(currentIdx);
        }}
      />
      <LessonMindmapEmbed lessonId={lesson.id} />
      <ExerciseSection lesson={lesson} />

      {progress?.state !== 'closed' && (
        <DeclareCompletedSection
          lesson={lesson}
          progress={progress}
          pagesRead={pagesRead}
          pagesTotal={pagesTotal}
          currentPageIndex={currentPageIndex}
        />
      )}

      {/* 课程总评 (PostLessonEvaluationBlock, "课程总评" + 折叠区"教学观察" +
          引用行) 撤出课文页 —— 2026-07-26 学习者裁定去重, 同 LiveHistory 尾部
          场评那一撤: 同一份 post_lesson_evaluations 三通道数据在 Journal 的
          课条目 (journal/entries/LessonEntryCard.tsx) 里 100% 复现, 那边不动。
          分工原则: 课文页 = 上课现场; Journal = 回顾档案。同一份内容只存在于
          一处。
          留在原位的是下面这条结课标识 —— 学习者原话: "Evaluation 虽然不在
          课程页面呈现, 但是要在结课之后留一个导向 Journal 页面的链接, 就是要
          让我有一个结课完成的显性标识。" */}
      {progress?.state === 'closed' && <LessonClosureNote lesson={lesson} />}

      <footer
        className="border-t border-[var(--ls-border)] flex gap-3 text-[11px] text-[var(--ls-text-tertiary)]"
        style={{ marginTop: '40px', paddingTop: '14px' }}
      >
        <span>
          {lesson.concept_ids.length}
          {lesson.concept_ids.length === 1 ? t('lesson.footer.conceptSingular') : t('lesson.footer.conceptPlural')}
        </span>
        <span>·</span>
        <span>
          {lesson.source_refs.length}
          {lesson.source_refs.length === 1 ? t('lesson.footer.sourceRefSingular') : t('lesson.footer.sourceRefPlural')}
        </span>
      </footer>
    </>
  );
}

/* ============================== LIVE TEACHING ============================ */

/**
 * LiveTeaching panel — Stage 7c rewrite (Hub-aligned turn-based card UI).
 *
 * State machine driven by session.awaiting_role + last move.response_kind:
 *   - no session yet         → "Start live teaching" button
 *   - awaiting_role='agent'  → agent thinking dots
 *   - awaiting_role='learner' →
 *       last move.response_kind='text'     → textarea + Submit + 追问
 *       last move.response_kind='continue' → Continue button + 追问
 *       last move.response_kind='none'     → display, agent will follow
 *   - status='completed' / 'cancelled' → show summary / reflection / next_action
 *
 * Trigger: stage 7c uses mock simulator (auto agent reply). Stage 7d wires
 * the real Agent via MCP — see HANDOFF.md "Live Teaching trigger TBD".
 */

function LiveTeaching({
  lesson,
  onClose,
  onCollapse,
  classroom = false,
  hidden = false,
}: {
  lesson: LessonModel;
  onClose?: () => void;
  /** Collapse this panel to a thin rail (三折布局案) — only offered outside
   *  Focus; the panel stays mounted underneath, just CSS-hidden. */
  onCollapse?: () => void;
  /** Split-focus (classroom) content mode — full move stream instead of the
   *  one-card + history-toggle view. Driven by Lesson's Focus state (see
   *  `splitFocus` there), not a button inside this panel anymore (
   *  Focus 单按钮化 — the old classroom toggle here was a second Focus entry point). */
  classroom?: boolean;
  /** CSS-hidden while Lesson's live column is collapsed to a rail —
   *  never unmounted, so chat state / in-progress draft survive the fold. */
  hidden?: boolean;
}) {
  const repo = useRepository();
  const qc = useQueryClient();
  const { pairId } = usePair();
  const { identity } = useIdentity();
  const agentLabel = identity ? cleanAgentName(identity.agent.display_name) : 'Agent';
  const { online } = useAgentBridge();
  const { t } = useT();
  const lessonId = lesson.id;

  // 学习者裁决 (2026-07-20): 学习者侧 Start Session 按钮退役后, 教室能不能
  // 开全靠老师那侧的 MCP live_session_start——这个浏览器标签页得自己发现
  // "老师刚开的课"。`pollActiveSessionRef` 是这条自动进教室的开关: 只在
  // 'summon'/'half' 态(召唤卡挂在屏幕上、正等老师开课的那两种状态)打开,
  // 'live'/'history' 态(教室已经进去了, 或已经毕业)关掉——用 ref 而不是直接
  // 把 `mode`(下面才算出来)塞进 refetchInterval 闭包, 是因为 mode 依赖
  // completedQ/sessionsListQ 等好几个查询的结果, 早于它们声明的这个
  // sessionSummaryQ 没法在定义那一刻拿到 mode 的值——ref 读的是"回调真正被
  // react-query 调用那一刻"的最新值, 不受声明顺序限制。轮询间隔 5s 是浏览器
  // 侧的 UI 刷新, 与 agent 侧 live_wait 的红线(禁止模型层轮询)无关——这里
  // 没有任何 agent 在跑, 只是页面自己定时问一声"教室开了没"。
  const pollActiveSessionRef = useRef(false);

  // Latest session for this (pair, lesson).
  const sessionSummaryQ = useQuery({
    queryKey: ['live-session-for-lesson', pairId, lessonId],
    queryFn: () =>
      repo && pairId
        ? repo.getLiveSessionForLesson(pairId, lessonId)
        : Promise.resolve(null),
    enabled: !!repo && !!pairId,
    refetchInterval: () => (pollActiveSessionRef.current ? 5_000 : false),
  });

  const sessionId = sessionSummaryQ.data?.id;

  // Latest COMPLETED session for this (pair, lesson) — 召唤状态机 v3 gap-4 fix.
  // The latest-session query above surfaces whatever is newest regardless
  // of status, so a cancelled/expired retry started AFTER a completed class
  // used to mask that completed history entirely (真实案例: 间接法课 —
  // 7/03 completed ls_mr4fizd5, 8 moves/7 responses, hidden behind a 7/13
  // cancelled; the page fell through to the summon branch). Queried
  // independently so "did this lesson ever graduate, and which session was
  // that" is answerable no matter what happened afterwards.
  const completedQ = useQuery({
    queryKey: ['live-completed-session-for-lesson', pairId, lessonId],
    queryFn: () =>
      repo && pairId
        ? repo.getCompletedLiveSessionForLesson(pairId, lessonId)
        : Promise.resolve(null),
    enabled: !!repo && !!pairId,
  });

  // 完课历史列表案 + 半场会话案, merged (会话列表合流案 尾巴: "半场/完课列表重叠拉取可合一"):
  // completedSessionsQ (status='completed') and halfSessionsQ (no status,
  // i.e. "all") used to be two separate requests against the exact same
  // endpoint (`getLiveSessionsForLesson(pairId, lessonId, ...)` →
  // `/teaching/pairs/:pair_id/lesson/:lesson_id/sessions`) — the unfiltered
  // "all" fetch is already a strict superset containing every completed
  // row the filtered fetch would return, so the second network round-trip
  // bought nothing. One fetch now (all statuses, server's own "omit = all"
  // convention, desc by started_at), both lists derived client-side from
  // the same payload. completedQ/completedFullQ (singular, 召唤状态机 v3 gap-4) stay
  // wired exactly as before so the single-session render path is untouched
  // — this only feeds the >1-completed-sessions branch and the half-session
  // branch below.
  const sessionsListQ = useQuery({
    queryKey: ['live-sessions-for-lesson', pairId, lessonId],
    queryFn: () =>
      repo && pairId
        ? repo.getLiveSessionsForLesson(pairId, lessonId)
        : Promise.resolve([] as LiveSessionListItem[]),
    enabled: !!repo && !!pairId,
  });
  const completedSessions = useMemo(
    () => (sessionsListQ.data ?? []).filter((s) => s.status === 'completed'),
    [sessionsListQ.data]
  );
  // 半场会话案: "半场"会话 — expired（租约到期没收官）或 cancelled（人为中断）
  // 但确有内容（moves>0）的终态会话。红队案例：课上一半租约过期没
  // complete，这场记录此前直接蒸发（mode 推导只认 completed，其余全部落进
  // 'summon'，召唤卡上没有任何"上次学到哪"的痕迹）。filtering down to
  // expired/cancelled + move_count>0 happens client-side per the ticket's
  // own instruction (list items already carry move_count, no extra payload
  // shape needed). 0-move 僵尸（从未真正开讲就被取消/过期的会话）仍然被这个
  // 过滤器无视，和 mode 推导现状一致。
  const halfSessions = useMemo(
    () =>
      (sessionsListQ.data ?? []).filter(
        (s) => (s.status === 'expired' || s.status === 'cancelled') && s.move_count > 0
      ),
    [sessionsListQ.data]
  );
  // Only the newest half session renders (parallels historySession's own
  // "latest by started_at" singular semantics) — 半场会话案 doesn't ask for a
  // multi-half stack the way 完课历史列表案 stacks multiple *completed* sessions.
  const halfSession = halfSessions[0] ?? null;
  const halfSessionId = halfSession?.id;
  const halfFullQ = useQuery({
    queryKey: ['live-session-full', halfSessionId],
    queryFn: () =>
      repo && halfSessionId
        ? repo.getLiveSessionFullView(halfSessionId)
        : Promise.resolve(null),
    enabled: !!repo && !!halfSessionId,
  });
  const halfMoves = halfFullQ.data?.moves ?? [];
  const halfResponses = halfFullQ.data?.responses ?? [];

  // Full view (session + moves + responses) polled while active.
  const fullQ = useQuery({
    queryKey: ['live-session-full', sessionId],
    queryFn: () =>
      repo && sessionId
        ? repo.getLiveSessionFullView(sessionId)
        : Promise.resolve(null),
    enabled: !!repo && !!sessionId,
    refetchInterval: (q) => {
      const v = q.state.data as ReturnType<typeof Object> & {
        session?: LiveSession;
      } | null | undefined;
      const status = (v as { session?: LiveSession } | null)?.session?.status;
      return status === 'active' ? 1_000 : false;
    },
  });

  // Full view of the completed session — the history branch's actual data.
  // Its id differs from `sessionId` whenever a newer non-completed session
  // exists; when they coincide react-query dedupes on the shared
  // ['live-session-full', id] key, so this adds no duplicate network work.
  const completedSessionId = completedQ.data?.id;
  const completedFullQ = useQuery({
    queryKey: ['live-session-full', completedSessionId],
    queryFn: () =>
      repo && completedSessionId
        ? repo.getLiveSessionFullView(completedSessionId)
        : Promise.resolve(null),
    enabled: !!repo && !!completedSessionId,
  });

  // A session completing in front of the student (active→completed seen by
  // fullQ's poll) must promote the completed query too — without this the
  // history branch would only materialize after a refresh.
  const latestStatus = fullQ.data?.session?.status ?? sessionSummaryQ.data?.status;
  useEffect(() => {
    if (latestStatus === 'completed') {
      qc.invalidateQueries({
        queryKey: ['live-completed-session-for-lesson', pairId, lessonId],
      });
    }
    // Plural sessions-list query (sessionsListQ, merged 完课历史列表案+半场会话案) needs the
    // same nudge whenever a session lands in ANY of the terminal statuses it
    // derives completed/half from — otherwise a session completing (or
    // expiring/being cancelled) live only stacks into the history/half panel
    // after a manual refresh. One shared key now that completed and half
    // both read off the same fetch, so one invalidation covers both branches
    // (no more separate plural-completed vs half-sessions keys to keep in
    // sync — that split was exactly the kind of key drift this merge removes).
    if (
      latestStatus === 'completed' ||
      latestStatus === 'expired' ||
      latestStatus === 'cancelled'
    ) {
      qc.invalidateQueries({
        queryKey: ['live-sessions-for-lesson', pairId, lessonId],
      });
    }
  }, [latestStatus, qc, pairId, lessonId]);

  // 学习者裁决 (2026-07-20): 学习者侧 Start Session 按钮整体退役——开课正门
  // 收窄到老师一侧的 MCP live_session_start, 这里不再有 startMut/startLiveSession
  // 调用链。召唤态只呈现 SummonAgentCard(人话+机器行), 老师开课后 mode 由
  // 上面的自动进教室轮询(pollActiveSessionRef)自己发现并切到 'live', 不需要
  // 这个页面替学习者按按钮。

  const cancelMut = useMutation({
    mutationFn: async () => {
      if (!repo || !sessionId) throw new Error('no session');
      return repo.cancelLiveSession(sessionId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['live-session-for-lesson', pairId, lessonId] });
      qc.invalidateQueries({ queryKey: ['live-session-full', sessionId] });
    },
  });

  // status: no session OR terminal — show start/restart CTA
  const view = fullQ.data;
  const session = view?.session ?? sessionSummaryQ.data ?? null;
  const moves = view?.moves ?? [];
  const responses = view?.responses ?? [];

  // The graduated session + its moves/responses (history branch's data).
  // May be an OLDER session than `session` when a cancelled/expired retry
  // came after it — that's exactly the gap-4 case this exists for.
  const historyView = completedFullQ.data;
  const historySession = historyView?.session ?? completedQ.data ?? null;
  const historyMoves = historyView?.moves ?? [];
  const historyResponses = historyView?.responses ?? [];

  // 召唤状态机 v3 (优先级从上到下; gap-4 修订: completed 的
  // 判定来源从"最新一场的 status"换成独立的 completedQ——最新一场是
  // cancelled/expired 也遮不住更早的 completed 了; 半场会话案 追加分支 2.5):
  //   1. active/awaiting 进行中     → 'live'    — 正常上课 UI 不变 (进行中
  //      的课优先于历史: 学习者刚重开一场,就该看到教室,不是旧记录)
  //   2. 存在任一 completed 会话    → 'history' — 教学记录, read-only, 已毕业
  //   2.5 无 completed 但有 moves>0
  //       的 expired/cancelled 会话 → 'half'    — 半场记录, 同样 read-only,
  //      但标头带"未收官/中断"徽章 (不是"已毕业"的沉稳灰, 是"没走完"的
  //      安静提醒), 且re-summon入口默认展开——这正是 半场会话案 的原意: 半场记录
  //      不再蒸发, 而且紧挨着"再开一场"的路
  //   3. 都没有 (或只剩僵尸)        → 'summon'  — 召唤卡 + 开课 CTA
  const mode: 'history' | 'half' | 'live' | 'summon' =
    session?.status === 'active'
      ? 'live'
      : historySession
        ? 'history'
        : halfSession
          ? 'half'
          : 'summon';

  // 学习者追加裁决 (同批 完课历史列表案): "就这一课再开一场" — history 模式尾部的次要
  // 入口, 就地复活召唤卡（不再带 LiveStartCTA, 见下方渲染分支)而不离开
  // 历史堆叠。 `virginRevealed`（above, outer Lesson component）先例同款:
  // 本地 flag, 换课清零。active 优先级不受影响——mode 的公式本身就没看这个
  // flag, 一旦真开出新场 session 变 active, mode 直接跳 'live' 分支渲染,
  // 这里只是顺手把 flag 收回去, 下次再毕业回到 history 时入口重新是收起态
  // ("收起逻辑…选最简洁的现状贴合做法": 复用同一个 toggle 按钮, 不新增关闭
  // 控件)。
  const [reSummonRevealed, setReSummonRevealed] = useState(false);
  useEffect(() => {
    setReSummonRevealed(false);
  }, [lessonId]);
  useEffect(() => {
    if (mode === 'live') setReSummonRevealed(false);
  }, [mode]);
  // 半场会话案 规格点 3: 半场态默认展开 re-summon 入口（措辞也换成"接着讲"
  // 而非完课态的中性文案，见下方 halfResume 分支）——半场 + 重启并存呈现
  // 正是这张票的原意，不该要学习者自己去点开才发现能续课。深度依赖 [mode]
  // 单一依赖：只在"刚进入 half 态"这一刻扳一次默认值，之后学习者手动收起
  // 不会被这条 effect 弹回去（mode 不变就不重跑）。
  useEffect(() => {
    if (mode === 'half') setReSummonRevealed(true);
  }, [mode]);

  // 自动进教室 (学习者裁决 2026-07-20) — 见上方 pollActiveSessionRef 头注:
  // 召唤卡挂在屏幕上的三种态才打开 active-session 的 5s 轮询——virgin/
  // re-summon ('summon' 态)、半场 resume ('half' 态)、以及 'history' 态里
  // 学习者手动展开的次要 re-summon 入口 (reSummonRevealed)。一旦真进了
  // 'live' (老师开课, session 变 active) 就立刻关掉——不需要再猜"教室开了
  // 没"。放在 reSummonRevealed 声明之后, 好让这条 effect 同时读到 mode 与
  // reSummonRevealed 两个信号。
  useEffect(() => {
    pollActiveSessionRef.current =
      mode === 'summon' || mode === 'half' || (mode === 'history' && reSummonRevealed);
  }, [mode, reSummonRevealed]);

  // Hub-aligned "one card at a time" view + history toggle. Only meaningful
  // in 'live' mode — 'history' always renders the full MoveStream
  // regardless (there's no "current card" once the session has graduated).
  const [viewMode, setViewMode] = useState<'current' | 'history'>('current');
  // Snap back to current whenever a new move arrives — keeps focus on the
  // turn-by-turn flow even if the learner was peeking at history.
  const movesLen = moves.length;
  const prevMovesLen = useRef(0);
  useEffect(() => {
    if (movesLen > prevMovesLen.current) setViewMode('current');
    prevMovesLen.current = movesLen;
  }, [movesLen]);

  return (
    <section
      className="border border-[var(--ls-border)] bg-[var(--ls-bg)] flex flex-col"
      style={{
        borderRadius: '10px',
        padding: '0',
        minHeight: 0,
        maxHeight: '100%',
        display: hidden ? 'none' : 'flex',
      }}
    >
      {/* In history mode the status bar (and its move count) describes the
          graduated session — NOT whatever newer cancelled/expired retry may
          technically be "latest" (gap-4: badge must read 已完成, not 已取消,
          while completed history is on screen). 半场会话案: 'half' mode reads
          the same way off halfSession — its own expired/cancelled label
          already comes free from LiveStatusBar's existing status switch
          below, the badge added in the content branch is the *additional*
          "半场·未收官/中断" framing, not a replacement for it. */}
      <LiveStatusBar
        session={mode === 'history' ? historySession : mode === 'half' ? halfSession : session}
        movesCount={
          mode === 'history' ? historyMoves.length : mode === 'half' ? halfMoves.length : moves.length
        }
        onClose={onClose}
        onCollapse={onCollapse}
        onCancel={() => cancelMut.mutate()}
        viewMode={viewMode}
        onToggleView={() =>
          setViewMode((v) => (v === 'current' ? 'history' : 'current'))
        }
        historyMode={mode === 'history' || mode === 'half'}
      />

      {/* 召唤状态机 v3 现病修复: 桥断/心跳丢失时不再弹召唤卡打断上课节奏——只在
          状态条下出一条细横幅。沿用 useAgentBridge() 的 `online`（同一条
          bridge_states.online_until 心跳判定，SummonAgentCard 原先也读这
          个信号），只在 'live' 分支（会话真的在进行中）显示；'summon' 分支
          没有活跃会话可言，不存在"掉线"这回事。 */}
      {mode === 'live' && !online && <LiveDisconnectBanner />}

      <div
        className="flex flex-col flex-1"
        style={{
          padding: '18px 16px',
          gap: '14px',
          overflowY: 'auto',
          minHeight: 0,
        }}
      >
        {mode === 'summon' && (
          <SummonAgentCard
            lessonTitle={lesson.title}
            contextId={lessonId as unknown as string}
          />
        )}
        {mode === 'live' &&
          (classroom || viewMode === 'history' ? (
            // Classroom right column: move history flows naturally (brief
            // "move 历史自然流 + 当前卡") — MoveStream always renders here
            // (classroom's column is tall enough that a separate one-card view
            // isn't needed), doubling as the current card when viewMode is
            // 'current'. 课堂列显隐案/课堂跟随滚动案: viewMode still matters even though the
            // component choice doesn't change — it drives MoveStream's scroll
            // anchor (current = sticky-bottom live feed, history = jumps to
            // the first move on entry), which is what the restored
            // Current/History toggle actually switches between in classroom.
            <MoveStream moves={moves} responses={responses} mode={viewMode} />
          ) : (
            <CurrentMoveCard moves={moves} awaiting={session?.awaiting_role ?? 'none'} />
          ))}
        {mode === 'history' && historySession && (
          // 已毕业的会话：只读呈现 completed live 的完整 moves+responses。
          // 完课历史列表案: 一课多场完课历史不再只取最近一场——
          // completedSessions（衍生自合并后的 sessionsListQ, 见上方"会话列表合流案
          // 尾巴"合并说明）一旦看到 >1 场 completed 就切到 LiveHistoryStack
          // （倒序堆叠, 最近一场默认展开, 更早场次折叠为一行标题, 点击懒加载
          // 该场全景）。单场（含 sessionsListQ 还没回来的那一瞬间）落回原样
          // ——这条分支和下面的 LiveHistory 调用与改造前逐字节相同, "零变化"
          // 就是字面意思。LiveHistory (2026-07-18) wraps MoveStream with the
          // lesson-grade annotation machinery — 划线/笔记/进卡组/笔记面板,
          // anchored per move; LiveHistoryStack mounts one LiveHistory
          // (and therefore one useAnnotations host) per EXPANDED session
          // only — collapsing a row unmounts its annotation host same as
          // never having expanded it.
          <>
            {completedSessions.length > 1 ? (
              <LiveHistoryStack
                sessions={completedSessions}
                hostTitle={lesson.title}
              />
            ) : (
              <LiveHistory
                sessionId={historySession.id}
                moves={historyMoves}
                responses={historyResponses}
                hostTitle={lesson.title}
              />
            )}

            {/* 学习者追加裁决 (同批 完课历史列表案): 历史堆叠尾部的次要入口——次要样式
                (小字/淡按钮, 不抢戏), 复用 LiveStatusBar 的 History/Current
                toggle 同款文字按钮语言。点击就地复活分支 3 组件, 再点一次
                收起 (mode==='live' 后也自动收起, 见上方 effect)。 */}
            <button
              type="button"
              onClick={() => setReSummonRevealed((v) => !v)}
              className="self-start text-[11px] uppercase tracking-[0.05em] font-medium text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
              style={{ marginTop: '4px', padding: '2px 0' }}
            >
              {reSummonRevealed
                ? t('lesson.live.reSummonCollapseLabel')
                : t('lesson.live.reSummonLabel')}
            </button>

            {reSummonRevealed && (
              <SummonAgentCard
                variant="again"
                lessonTitle={lesson.title}
                contextId={lessonId as unknown as string}
              />
            )}
          </>
        )}
        {mode === 'half' && halfSession && (
          // 半场会话案: 半场记录——没有 completed 会话可看, 但这场
          // expired/cancelled 留下了真实内容 (moves>0), 不该跟着状态机一起
          // 蒸发进 'summon'。渲染管线跟 'history' 分支同款 (同一个
          // LiveHistory, 同一套批注机器), 只多两处标记这不是"已毕业": 一个
          // 安静的状态徽 (标头, 不渲染成事故红——只是 tertiary 小字 + 细边框
          // 药丸, 跟别处徽章一个量级), 和默认展开的 re-summon 入口 (规格点
          // 3: 半场 + 重启并存呈现, 用"接着讲"而不是"再开一堂"的措辞)。
          <>
            <div className="flex items-center" style={{ gap: '6px' }}>
              <span
                className="text-[10px] uppercase tracking-[0.06em] font-medium text-[var(--ls-text-tertiary)]"
                style={{
                  padding: '2px 8px',
                  borderRadius: '999px',
                  border: '1px solid var(--ls-border)',
                }}
              >
                {halfSession.status === 'expired'
                  ? t('lesson.live.halfBadgeExpired')
                  : t('lesson.live.halfBadgeCancelled')}
              </span>
            </div>

            <LiveHistory
              sessionId={halfSession.id}
              moves={halfMoves}
              responses={halfResponses}
              hostTitle={lesson.title}
            />

            <button
              type="button"
              onClick={() => setReSummonRevealed((v) => !v)}
              className="self-start text-[11px] uppercase tracking-[0.05em] font-medium text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
              style={{ marginTop: '4px', padding: '2px 0' }}
            >
              {reSummonRevealed
                ? t('lesson.live.reSummonCollapseLabel')
                : t('lesson.live.reSummonLabel')}
            </button>

            {reSummonRevealed && (
              <SummonAgentCard
                variant="half"
                lessonTitle={lesson.title}
                contextId={lessonId as unknown as string}
              />
            )}
          </>
        )}
      </div>

      {/* Input footer (only when active + awaiting learner) */}
      {session?.status === 'active' && session.awaiting_role === 'learner' && (
        <LearnerInputFooter
          session={session}
          lastMove={moves[moves.length - 1]}
        />
      )}

      {session?.status === 'active' && session.awaiting_role === 'agent' && (
        <div
          className="border-t border-[var(--ls-border)] flex items-center"
          style={{ padding: '12px 16px', gap: '10px', flexShrink: 0 }}
        >
          <span
            className="inline-flex items-center"
            style={{ gap: '4px' }}
          >
            <LiveDot delay="0ms" />
            <LiveDot delay="180ms" />
            <LiveDot delay="360ms" />
          </span>
          <span className="text-[12px] text-[var(--ls-text-tertiary)]">
            {agentLabel}{t('lesson.live.thinkingSuffix')}
          </span>
        </div>
      )}

      {/* 下课铃 (设计单§四 + 五.2) — 只在进行中的 Live 房常驻 (终态会话
          mode 不是 'live', 铃不渲染); 位置在两个输入 footer 之下、面板最底
          一条细缝, 常驻低调不抢回复区的戏。升显性 (老师发出收课邀请时高亮)
          留待收课邀请的结构化 move 落地 — 现有 MoveType 里 REFLECT 兼任
          课中 pedagogy beat 与收尾, 不是可靠的"邀请"信号, 不硬造。 */}
      {mode === 'live' && session?.status === 'active' && (
        <LiveCloseBell session={session} />
      )}

      {/* Close summary (总结/复盘/下一步) belongs to the graduated session —
          keyed off historySession (gap-4), not the possibly-newer cancelled
          "latest". Only in history mode: mid-'live' there's nothing closed
          yet, and 'summon' has no completed session by definition.

          复归 (2026-07-26, 学习者本人当面裁定) —— 曾把这三段整块退役,
          理由是"内部 id 会上学习者的屏"。撤销依据是实测: bench 库 14 场有内容
          的会话里, teacher_reflection / next_action 含内部 id 的 0 场
          (100% 干净), summary 3 场 (21%); 而换上去顶替它们的
          agent_observation 9 份里 3 份含 id (33%)。方向反了 —— 退役了两段
          干净的, 换上一段更脏的。
          内部 id 的根因在写入层 (agent 收课时的书写习惯, 由工具描述另行整改),
          不在渲染层: 这里不做也不许做任何 id 检测 / 过滤 / 剥离。
          分工原则 (同批): 课文页 = 上课现场, 收课三段是当场写的, 归这里;
          评估与观察 = 回顾档案, 归 Journal。同一份内容只存在于一处。 */}
      {mode === 'history' && historySession && (
        <LiveSessionClose session={historySession} />
      )}
    </section>
  );
}

function LiveStatusBar({
  session,
  movesCount,
  onClose,
  onCollapse,
  onCancel,
  viewMode,
  onToggleView,
  historyMode = false,
}: {
  session: LiveSession | null;
  movesCount: number;
  onClose?: () => void;
  onCollapse?: () => void;
  onCancel: () => void;
  viewMode: 'current' | 'history';
  onToggleView: () => void;
  /** 召唤状态机 v3: true once this lesson's live has graduated to a completed
   *  history session — the Current/History toggle stops being meaningful
   *  (LiveTeaching always renders the full MoveStream in that branch, the
   *  toggle would flip nothing), so it's hidden here rather than left
   *  dangling as a no-op control. */
  historyMode?: boolean;
}) {
  const { t } = useT();
  const isActive = session?.status === 'active';
  // 课堂列显隐案 — the classroom (split-Focus) live column used to hide this
  // toggle entirely (content there is always MoveStream regardless of
  // viewMode — see LiveTeaching's content ternary), which meant Focus had no
  // way to distinguish "current" from "history". Now viewMode also drives
  // MoveStream's scroll anchor (current = sticky-bottom, history = jumps to
  // the first move — 课堂跟随滚动案), so the toggle is meaningful in classroom too
  // and shown there with the same control language as non-Focus.
  const showHistoryToggle = !!session && movesCount > 0 && !historyMode;
  return (
    <div
      className="flex items-center justify-between border-b border-[var(--ls-border)] flex-wrap"
      style={{ padding: '12px 16px', gap: '10px', flexShrink: 0 }}
    >
      <div className="flex items-center" style={{ gap: '8px' }}>
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{
            background:
              isActive
                ? 'var(--ls-corroborated)'
                : 'var(--ls-text-tertiary)',
          }}
        />
        <span className="text-[11px] leading-4 tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)] font-medium">
          {!session
            ? t('lesson.live.statusReady')
            : session.status === 'active'
              ? `${t('lesson.live.statusAwaitingPrefix')}${session.awaiting_role}`
              : session.status === 'completed'
                ? t('lesson.live.statusCompleted')
                : session.status === 'cancelled'
                  ? t('lesson.live.statusCancelled')
                  : t('lesson.live.statusExpired')}
        </span>
      </div>
      <div className="flex items-center" style={{ gap: '10px' }}>
        <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)] tabular-nums">
          {movesCount}{movesCount === 1 ? t('lesson.live.moveCountSingular') : t('lesson.live.moveCountPlural')}
        </span>
        {showHistoryToggle && (
          <button
            type="button"
            onClick={onToggleView}
            title={viewMode === 'current' ? t('lesson.live.showFullHistoryTitle') : t('lesson.live.backToCurrentTitle')}
            className="text-[11px] uppercase tracking-[0.05em] font-medium text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)]"
          >
            {viewMode === 'current' ? t('lesson.live.historyLabel') : t('lesson.live.currentLabel')}
          </button>
        )}
        {isActive && (
          <button
            type="button"
            onClick={onCancel}
            title={t('lesson.live.cancelSessionTitle')}
            className="text-[var(--ls-text-tertiary)] hover:text-[var(--ls-risk)] text-[11px] uppercase tracking-[0.05em] font-medium"
          >
            {t('lesson.live.endButton')}
          </button>
        )}
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title={t('lesson.live.collapseToRailTitle')}
            className="text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] text-[11px] uppercase tracking-[0.05em] font-medium"
          >
            ⟨⟨
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t('lesson.live.closePanelAriaLabel')}
            className="text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors"
            style={{
              fontSize: '14px',
              lineHeight: 1,
              width: '20px',
              height: '20px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * LiveDisconnectBanner — 召唤状态机 v3 现病修复. A live session in progress
 * (mode 'live') used to pop the summon card the instant the agent bridge's
 * heartbeat went stale (`useAgentBridge()`'s `online` flag), interrupting
 * the lesson's rhythm mid-class. That card is for the "nobody has ever
 * summoned anyone yet" scenario (mode 'summon') — a mid-class disconnect is
 * a different situation entirely: there IS a teacher, they're just
 * temporarily unreachable, and the learner's own answers are safely
 * persisted server-side regardless. This is a thin, non-interactive strip
 * instead: says so, gets out of the way, disappears the moment `online`
 * flips back true (no action needed from the learner either way).
 */
function LiveDisconnectBanner() {
  const { t } = useT();
  return (
    <div
      className="border-b border-[var(--ls-border)] text-[12px] leading-4 text-[var(--ls-text-secondary)]"
      style={{
        padding: '8px 16px',
        flexShrink: 0,
        background: 'var(--ls-bg-subtle)',
      }}
    >
      {t('lesson.live.disconnectBanner')}
    </div>
  );
}

/**
 * LiveRailTab — the ~40px collapsed state of the live panel (三折布局案).
 * Sits beside LiveTeaching (which stays mounted, CSS-hidden) so a click
 * here expands without losing chat state or an in-progress draft. Visual
 * language borrows AppShell's sidebar collapse: a thin bordered strip,
 * vertical label, sticky to match the full panel's own sticky treatment.
 */
function LiveRailTab({ onExpand }: { onExpand: () => void }) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onExpand}
      title={t('lesson.live.expandTitle')}
      className="flex-none border border-[var(--ls-border)] hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)] flex flex-col items-center"
      style={{
        width: `${RAIL_W}px`,
        height: '100%',
        borderRadius: '10px',
        padding: '14px 0',
        gap: '10px',
      }}
    >
      <span className="text-[12px] leading-none" style={{ color: 'var(--ls-text-tertiary)' }}>
        ‹
      </span>
      <span
        style={{
          writingMode: 'vertical-rl',
          transform: 'rotate(180deg)',
          fontSize: '11px',
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: 'var(--ls-text-secondary)',
          fontWeight: 500,
          flex: '1 1 auto',
        }}
      >
        {t('lesson.tab.live')}
      </span>
      <span
        className="w-1.5 h-1.5 rounded-full flex-none"
        style={{ background: 'var(--ls-text-tertiary)' }}
      />
    </button>
  );
}

// LiveStartCTA 整体退役 (学习者裁决, 2026-07-20): 学习者侧 Start Session
// 按钮的开课动作没了, 这个组件原来的三段提示文案(walkthrough/previousEnded/
// halfResume)全都只是给那颗按钮铺垫的——按钮没了, 铺垫也就没了独立存在的
// 价值; SummonAgentCard 的"人话+机器行"已经完整承担"叫老师"这件事, 不需要
// 再留一层文案壳复述同一件事。三处调用点(summon / history 内 re-summon /
// half 内 re-summon)现在都只渲染 SummonAgentCard。对应的 i18n 键
// (previousEndedHint/walkthroughPrefix/walkthroughSuffix/startingEllipsis/
// mockModeNote/halfResumeHint) 一并从 dict.ts 退役——lesson.live.startButton
// 留用, 头部 pill 的处女课标签还在读它。

const MOVE_TYPE_LABEL_KEY: Record<string, DictKey> = {
  FRAME: 'lesson.live.moveType.frame',
  ASK: 'lesson.live.moveType.ask',
  EXPLAIN: 'lesson.live.moveType.explain',
  PROBE: 'lesson.live.moveType.probe',
  HINT: 'lesson.live.moveType.hint',
  CHALLENGE: 'lesson.live.moveType.challenge',
  REFLECT: 'lesson.live.moveType.reflect',
};

const MOVE_TYPE_COLOR: Record<string, string> = {
  FRAME: 'var(--ls-text-tertiary)',
  ASK: 'var(--ls-structure)',
  EXPLAIN: 'var(--ls-text-secondary)',
  PROBE: 'var(--ls-hypothesis)',
  HINT: 'var(--ls-text-tertiary)',
  CHALLENGE: 'var(--ls-risk)',
  REFLECT: 'var(--ls-corroborated)',
};

/**
 * CurrentMoveCard — Hub iOS Guided Teaching parity (Stage 7e-cards).
 *
 * Shows ONLY the latest move card. After the learner answers, the card
 * stays put (no echo of their response) and the awaiting=agent thinking
 * dots take over in the footer; once a new move arrives the card swaps.
 * Past moves + responses live in the History view (toggle in status bar).
 */
function CurrentMoveCard({
  moves,
  awaiting,
}: {
  moves: TeachingMove[];
  awaiting: AwaitingRole;
}) {
  const { identity } = useIdentity();
  const agentLabel = identity ? cleanAgentName(identity.agent.display_name) : 'Agent';
  const { t } = useT();
  const current = moves.length > 0 ? moves[moves.length - 1]! : null;

  if (!current) {
    // No moves yet — session just started, agent owes FRAME.
    return (
      <div className="flex flex-col items-start" style={{ gap: '8px' }}>
        <span className="text-[10px] uppercase tracking-[0.08em] font-medium text-[var(--ls-text-tertiary)]">
          {t('lesson.live.preparingLabel')}
        </span>
        <div className="text-[14px] leading-[22px] text-[var(--ls-text-secondary)]">
          {awaiting === 'agent'
            ? `${agentLabel}${t('lesson.live.agentPreparingSuffix')}`
            : t('lesson.live.waitingFirstMove')}
        </div>
      </div>
    );
  }

  return (
    <div key={current.id} className="flex flex-col live-card-enter" style={{ gap: '10px' }}>
      <div className="flex items-baseline" style={{ gap: '8px' }}>
        <span
          className="text-[10px] uppercase tracking-[0.08em] font-medium"
          style={{ color: MOVE_TYPE_COLOR[current.move_type] ?? 'var(--ls-text-tertiary)' }}
        >
          {MOVE_TYPE_LABEL_KEY[current.move_type] ? t(MOVE_TYPE_LABEL_KEY[current.move_type]!) : current.move_type}
        </span>
        <span className="text-[10px] text-[var(--ls-text-tertiary)] tabular-nums">
          #{current.seq}
        </span>
      </div>
      <div
        className="text-[15px] leading-[24px] text-[var(--ls-text)]"
        style={{ whiteSpace: 'pre-wrap' }}
      >
        {current.content}
      </div>
    </div>
  );
}

function MoveStream({
  moves,
  responses,
  mode = 'current',
}: {
  moves: TeachingMove[];
  responses: TeachingResponse[];
  /** 课堂跟随滚动案 — 'current' sticks to the bottom as moves stream in (existing
   *  behavior, unchanged); 'history' lands on the first move instead, since
   *  opening History means "review from the start", not "see the latest". */
  mode?: 'current' | 'history';
}) {
  const { t } = useT();
  // Index responses by move_id so we can render them inline beneath their move.
  const responsesByMove = useMemo(() => {
    const m = new Map<TeachingMoveId, TeachingResponse[]>();
    for (const r of responses) {
      const existing = m.get(r.move_id) ?? [];
      existing.push(r);
      m.set(r.move_id, existing);
    }
    return m;
  }, [responses]);

  const scrollStartRef = useRef<HTMLDivElement>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mode === 'history') {
      scrollStartRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' });
    } else {
      scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [mode, moves.length, responses.length]);

  return (
    <>
      <div ref={scrollStartRef} />
      {moves.map((m) => (
        <div key={m.id} className="flex flex-col" style={{ gap: '8px' }}>
          {/* Move card */}
          <div className="flex flex-col" style={{ gap: '6px' }}>
            <div className="flex items-baseline" style={{ gap: '8px' }}>
              <span
                className="text-[10px] uppercase tracking-[0.08em] font-medium"
                style={{ color: MOVE_TYPE_COLOR[m.move_type] ?? 'var(--ls-text-tertiary)' }}
              >
                {MOVE_TYPE_LABEL_KEY[m.move_type] ? t(MOVE_TYPE_LABEL_KEY[m.move_type]!) : m.move_type}
              </span>
              <span className="text-[10px] text-[var(--ls-text-tertiary)] tabular-nums">
                #{m.seq}
              </span>
            </div>
            {/* data-ls-live-move-seq (第三种宿主, 2026-07-18): per-move anchor
                scope marker for live-hosted annotations — useAnnotations'
                live branches serialize/resolve inside exactly this element,
                and its seq becomes the record's page_index (server 约定).
                Only the move's own prose is annotatable; the type/seq label
                above and learner responses below are outside the marker on
                purpose. Harmless in non-history renders (capture only runs
                where LiveHistory mounts the hook). */}
            <div
              className="text-[14px] leading-[22px] text-[var(--ls-text)]"
              style={{ whiteSpace: 'pre-wrap' }}
              data-ls-live-move-seq={m.seq}
            >
              {m.content}
            </div>
          </div>

          {/* Response(s) for this move */}
          {(responsesByMove.get(m.id) ?? []).map((r) => (
            <div
              key={r.id}
              className="border-l-2"
              style={{
                borderColor: 'var(--ls-border-strong)',
                paddingLeft: '12px',
                marginLeft: '4px',
              }}
            >
              <div className="text-[10px] uppercase tracking-[0.08em] font-medium text-[var(--ls-text-tertiary)]">
                {t('lesson.live.youPrefix')}{r.input_type === 'continue' ? t('lesson.live.continued') : r.input_type === 'question' ? t('lesson.live.asked') : t('lesson.live.answered')}
              </div>
              <div
                className="text-[13px] leading-5 text-[var(--ls-text-secondary)]"
                style={{ marginTop: '3px', whiteSpace: 'pre-wrap' }}
              >
                {r.content || t('lesson.live.continuePlaceholderContent')}
              </div>
            </div>
          ))}
        </div>
      ))}
      <div ref={scrollEndRef} />
    </>
  );
}

/**
 * LiveHistory — 教学记录挂批注 (第三种宿主, 学习者需求 2026-07-18).
 *
 * Wraps the history branch's read-only MoveStream with the same annotation
 * machinery PagedLesson mounts around a lesson page: highlight capture
 * (pill + color palette + note), click→overlay (recolor / note / To pool /
 * delete), and the collapsible notes panel. All four pieces are the
 * existing components — the only new part is the host ({ kind: 'live' })
 * and its per-move anchoring convention (page_index = move seq,
 * data-ls-live-move-seq markers rendered by MoveStream itself).
 *
 * Mounted ONLY in LiveTeaching's 'history' branch (completed session). The
 * in-progress 'live' branch never mounts this — content there is still
 * streaming, so anchors would drift ("锚会漂"); the completed record is
 * frozen text, the same stability contract a lesson page offers.
 */
function LiveHistory({
  sessionId,
  moves,
  responses,
  hostTitle,
}: {
  sessionId: LiveSessionId;
  moves: TeachingMove[];
  responses: TeachingResponse[];
  /** For AnnotationOverlay's To-pool provenance label — lesson title, same
   *  human-readable role as PagedLesson's `lesson.title`. */
  hostTitle: string;
}) {
  const { pairId } = usePair();
  const containerRef = useRef<HTMLDivElement>(null);
  const host = useMemo<AnnotationHost>(() => ({ kind: 'live', id: sessionId }), [sessionId]);
  // pageIndex arg is 0 as a placeholder — live hosts ignore it on both the
  // capture and paint paths (per-move scoping via data-ls-live-move-seq).
  const annotations = useAnnotations(containerRef, host, 0, pairId);

  // Overlay ownership — same division as PagedLesson: this component owns
  // which annotation is active and where to float the panel (click coords),
  // AnnotationOverlay renders it and does its own writes.
  const [activeAnnotationId, setActiveAnnotationId] = useState<AnnotationId | null>(null);
  const [overlayPos, setOverlayPos] = useState<{ left: number; top: number } | null>(null);
  const activeAnnotation =
    activeAnnotationId != null
      ? (annotations.allAnnotations.find((a) => a.id === activeAnnotationId) ?? null)
      : null;

  // Session switch (course-rail navigation between graduated lessons): a
  // stale overlay pointing at unmounted DOM makes no sense — same instinct
  // as PagedLesson's page-change reset.
  useEffect(() => {
    setActiveAnnotationId(null);
  }, [sessionId]);

  // Dismiss overlay on outside click / Escape — verbatim the PagedLesson
  // idiom; AnnotationOverlay's own onMouseDown stopPropagation keeps
  // interactions inside it from reaching this document-level listener.
  useEffect(() => {
    if (!activeAnnotationId) return;
    const onMouseDown = () => setActiveAnnotationId(null);
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') setActiveAnnotationId(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activeAnnotationId]);

  return (
    <>
      {annotations.pending && (
        <AnnotationPill
          pending={annotations.pending}
          onConfirmColor={(color) => annotations.confirm({ color })}
          onConfirmNote={(color, note) => annotations.confirm({ color, note })}
        />
      )}

      {activeAnnotation && overlayPos && (
        <AnnotationOverlay
          annotation={activeAnnotation}
          left={overlayPos.left}
          top={overlayPos.top}
          host={host}
          pairId={pairId}
          hostTitle={hostTitle}
          onClose={() => setActiveAnnotationId(null)}
        />
      )}

      <div
        ref={containerRef}
        className="flex flex-col"
        style={{ gap: '14px' }}
        onClick={(e) => {
          // Same drag-release guard as PagedLesson: a selection release also
          // fires 'click' — skip hit-testing while a real selection is live
          // so this never fights the mouseup→pending capture.
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed) return;
          const hitId = annotations.hitTest(e.clientX, e.clientY);
          if (hitId) {
            setActiveAnnotationId(hitId);
            setOverlayPos({ left: e.clientX, top: e.clientY });
          } else {
            setActiveAnnotationId(null);
          }
        }}
      >
        <MoveStream moves={moves} responses={responses} mode="history" />
      </div>

      {/* 场评 (LiveSessionEvaluationBlock, "本场评价" + 折叠区"教学观察" +
          引用行) 撤出课文页 —— 2026-07-26 学习者裁定去重: "它们既在课程页面
          呈现, 也在 Journal 页面百分之百同样复现, 没有必要有两份。" 同一份
          live_session_evaluations 三通道数据由 Journal 的 Live 条目
          (journal/entries/LiveEntryCard.tsx) 继续承担, 那边一字不动。
          分工原则: 课文页 = 上课现场 (收课三段是当场写的, 见 LiveTeaching
          尾部); Journal = 回顾档案 (评估与观察)。同一份内容只存在于一处。
          结课后的去向指引由 SelfStudy 尾部的 LessonClosureNote 给出。 */}

      <AnnotationNotesPanel
        annotations={annotations.allAnnotations}
        orphanIds={annotations.orphanIds}
        // Every move is mounted at once in history mode, so the return path
        // is always scrollToAnnotation (no page flip to make) — same
        // "callback reads fewer params than declared" pattern the panel's
        // own doc comment blesses. showPageLabel off: "Page N" would be a
        // lie for a move seq.
        onJumpToPage={(_pageIndex, id) => annotations.scrollToAnnotation(id)}
        showPageLabel={false}
      />
    </>
  );
}

/**
 * LiveHistoryStack — 一课多场完课历史的倒序堆叠 (完课历史列表案).
 *
 * Renders every completed session for this lesson, newest first (the list
 * arrives pre-sorted by started_at desc — client-filtered to status
 * 'completed' from the single shared sessionsListQ fetch, see 会话列表合流案 merge
 * note above LiveTeaching's sessionsListQ declaration). Only mounted by
 * LiveTeaching when that list has more than one entry — the ≤1 case keeps
 * rendering a
 * bare <LiveHistory> exactly as before this ticket, so a lesson with a
 * single completed session sees zero behavioral or visual change.
 *
 * The newest session starts expanded (current behavior, preserved); every
 * older one starts folded to a one-line summary row and lazy-loads its full
 * moves/responses (and mounts its own <LiveHistory> — annotation host
 * included) only once expanded. Expansion state is local and per-lesson
 * (reset whenever the newest session's id changes, i.e. a fresh completion
 * or a lesson switch), same "don't leak state across lessons" instinct
 * LiveHistory itself applies to its overlay on sessionId change.
 */
function LiveHistoryStack({
  sessions,
  hostTitle,
}: {
  sessions: LiveSessionListItem[];
  hostTitle: string;
}) {
  const newestId = sessions[0]?.id;
  const [expandedIds, setExpandedIds] = useState<Set<LiveSessionId>>(
    () => new Set(newestId ? [newestId] : [])
  );
  useEffect(() => {
    setExpandedIds(new Set(newestId ? [newestId] : []));
  }, [newestId]);

  return (
    <div className="flex flex-col" style={{ gap: '20px' }}>
      {sessions.map((s) => (
        <LiveHistoryStackItem
          key={s.id}
          session={s}
          expanded={expandedIds.has(s.id)}
          onToggle={() =>
            setExpandedIds((prev) => {
              const next = new Set(prev);
              if (next.has(s.id)) next.delete(s.id);
              else next.add(s.id);
              return next;
            })
          }
          hostTitle={hostTitle}
        />
      ))}
    </div>
  );
}

/**
 * LiveHistoryStackItem — one row of LiveHistoryStack.
 *
 * Collapsed: a single folded-row button (date + goal/preview + move count)
 * in the file's established "secondary text button" language (小字,
 * uppercase tertiary — same idiom as LiveStatusBar's History/Current
 * toggle). No network cost beyond what the list query already paid for
 * (move_count travels with the list item).
 *
 * Expanded: fetches the session's full view (moves + responses) under the
 * SAME ['live-session-full', id] query key every other full-session read in
 * this file uses — for the newest (already-expanded-by-default) row this
 * dedupes for free against LiveTeaching's own completedFullQ; for an older
 * row clicked open, this is exactly the lazy load the brief asks for. Only
 * mounts <LiveHistory> (and therefore only mounts that session's own
 * useAnnotations host) while expanded — collapsing unmounts it, same as
 * never having opened it.
 */
function LiveHistoryStackItem({
  session,
  expanded,
  onToggle,
  hostTitle,
}: {
  session: LiveSessionListItem;
  expanded: boolean;
  onToggle: () => void;
  hostTitle: string;
}) {
  const repo = useRepository();
  const { t } = useT();
  const fullQ = useQuery({
    queryKey: ['live-session-full', session.id],
    queryFn: () =>
      repo ? repo.getLiveSessionFullView(session.id) : Promise.resolve(null),
    enabled: !!repo && expanded,
  });

  const dateLabel = new Date(session.started_at).toLocaleDateString();

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="flex flex-col items-start w-full text-left"
        style={{
          padding: '10px 12px',
          borderRadius: '8px',
          border: '1px solid var(--ls-border)',
          background: 'transparent',
          gap: '3px',
        }}
      >
        <span className="text-[11px] text-[var(--ls-text-tertiary)] tabular-nums">
          {dateLabel}
        </span>
        <span
          className="text-[13px] text-[var(--ls-text-secondary)]"
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '100%',
          }}
        >
          {session.goal || session.context_preview || t('lesson.live.historyStackUntitled')}
        </span>
        <span className="text-[10px] text-[var(--ls-text-tertiary)]">
          {session.move_count}
          {session.move_count === 1
            ? t('lesson.live.moveCountSingular')
            : t('lesson.live.moveCountPlural')}
        </span>
      </button>
    );
  }

  return (
    <div className="flex flex-col" style={{ gap: '10px' }}>
      <button
        type="button"
        onClick={onToggle}
        title={t('lesson.live.reSummonCollapseLabel')}
        className="self-start text-[11px] text-[var(--ls-text-tertiary)] tabular-nums hover:text-[var(--ls-text)]"
      >
        {dateLabel}
      </button>
      {fullQ.data ? (
        <LiveHistory
          sessionId={session.id}
          moves={fullQ.data.moves}
          responses={fullQ.data.responses}
          hostTitle={hostTitle}
        />
      ) : (
        <div className="text-[12px] text-[var(--ls-text-tertiary)]" style={{ padding: '4px 2px' }}>
          {t('contract.loading')}
        </div>
      )}
    </div>
  );
}

// LiveSessionEvaluationBlock 整体撤出课文页 (2026-07-26 学习者去重裁定) ——
// 它渲染的三样东西 ("本场评价" 正文 / 折叠区 "教学观察" / evidence 引用行)
// 在 Journal 的 Live 条目里 100% 同源同样复现 (journal/entries/LiveEntryCard.tsx
// 读的就是同一份 live_session_evaluations 三通道数据, 同一套分层规则)。
// 一份内容两处呈现 = 两处要维护、两处会不一致, 学习者原话 "没有必要有两份"。
// 撤的是课文页这一份, Journal 那份保持现状不动。
// 数据与端点零改动: repo.getLiveSessionEvaluation / HttpRepository 都还在,
// Journal 侧继续用。

function LearnerInputFooter({
  session,
  lastMove,
}: {
  session: LiveSession;
  lastMove: TeachingMove | undefined;
}) {
  const repo = useRepository();
  const qc = useQueryClient();
  const { t } = useT();
  const { identity } = useIdentity();
  const agentLabel = identity ? cleanAgentName(identity.agent.display_name) : 'Agent';
  const [draft, setDraft] = useState('');

  const submitMut = useMutation({
    mutationFn: async (args: {
      content: string;
      input_type: 'text' | 'continue' | 'question';
    }) => {
      if (!repo || !lastMove) throw new Error('no move to respond to');
      return repo.submitTeachingResponse({
        session_id: session.id,
        move_id: lastMove.id,
        content: args.content,
        input_type: args.input_type,
        client_response_id: `cli_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 8)}`,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['live-session-full', session.id] });
      setDraft('');
    },
    onError: (e) => console.error('[submitTeachingResponse]', e),
  });

  if (!lastMove) return null;

  const kind = lastMove.response_kind;
  const canSubmitText = draft.trim().length > 0 && !submitMut.isPending;

  return (
    <div
      className="border-t border-[var(--ls-border)]"
      style={{ padding: '12px 16px', flexShrink: 0 }}
    >
      {kind === 'text' ? (
        <>
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              const el = e.target;
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 320) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (canSubmitText)
                  submitMut.mutate({ content: draft.trim(), input_type: 'text' });
              }
            }}
            placeholder={t('lesson.live.answerPlaceholder')}
            rows={3}
            className="w-full rounded-[var(--ls-radius-control)] border border-[var(--ls-border)] bg-[var(--ls-bg)] px-3 py-2 text-[14px] leading-6 placeholder:text-[var(--ls-text-tertiary)] focus:outline-none focus:border-[var(--ls-border-strong)]"
            style={{ overflowY: 'auto' }}
          />
          <div className="flex items-center" style={{ marginTop: '8px', gap: '8px' }}>
            <button
              type="button"
              onClick={() =>
                submitMut.mutate({ content: draft.trim(), input_type: 'text' })
              }
              disabled={!canSubmitText}
              className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                height: '30px',
                padding: '0 14px',
                borderRadius: '6px',
                fontSize: '12px',
                lineHeight: '1',
              }}
            >
              {t('quiz.submit')}
            </button>
            <button
              type="button"
              onClick={() => {
                const text = draft.trim();
                if (!text) return;
                submitMut.mutate({ content: text, input_type: 'question' });
              }}
              disabled={!canSubmitText}
              className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                height: '30px',
                padding: '0 12px',
                borderRadius: '6px',
                fontSize: '12px',
                lineHeight: '1',
              }}
            >
              {t('lesson.followUp')}
            </button>
          </div>
        </>
      ) : kind === 'continue' ? (
        <div className="flex items-center" style={{ gap: '8px' }}>
          <button
            type="button"
            onClick={() =>
              submitMut.mutate({ content: '', input_type: 'continue' })
            }
            disabled={submitMut.isPending}
            className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium disabled:opacity-40"
            style={{
              height: '32px',
              padding: '0 16px',
              borderRadius: '6px',
              fontSize: '12px',
              lineHeight: '1',
            }}
          >
            {t('lesson.live.continueButton')}
          </button>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter' && draft.trim()) {
                submitMut.mutate({
                  content: draft.trim(),
                  input_type: 'question',
                });
              }
            }}
            placeholder={t('lesson.continuePlaceholder')}
            className="flex-1 border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[13px] focus:outline-none focus:border-[var(--ls-border-strong)]"
            style={{
              height: '32px',
              padding: '0 10px',
              borderRadius: '6px',
            }}
          />
        </div>
      ) : (
        <div className="text-[12px] text-[var(--ls-text-tertiary)]">
          {agentLabel}{t('lesson.live.autoContinueSuffix')}
        </div>
      )}
    </div>
  );
}

/**
 * LiveCloseBell — 下课铃 (首跑入学设计单 §四/§五.2).
 *
 * 按铃 = 落一行 learner 收课宣告, 不是杀进程 — 决定下课的是学习者, 合上
 * 帷幕的是老师 (agent 收到宣告后照约定流程走 summary/反思/complete)。语义唯一
 * = 结束 (设计单裁定, 五.2): 暂停不走这里 — 半场机制即暂停通道, 对话即界面,
 * 确认文案把这条路指清楚。
 *
 * 两段式行内确认 (Cards.tsx confirmingReset 先例, 军规无 window.confirm):
 * 铃按钮就地换成说明 + 确认/取消对。宣告成功后进"已宣告·等老师收官"态 —
 * 铃变已按, 不可重按; declared 的真相源优先读 session 行上的
 * learner_close_declared_at (fullQ 1s 轮询带回来), 本地 state 只补写入与
 * 下一次轮询之间的窗口。终态 409 (课在指尖下收官/被取消) 安静提示, 面板
 * 本身几秒内会被轮询翻出 'live' 分支。
 */
function LiveCloseBell({ session }: { session: LiveSession }) {
  const repo = useRepository();
  const onboardingRepo = repo as (Repository & OnboardingRepo) | null;
  const qc = useQueryClient();
  const { t } = useT();
  const [confirming, setConfirming] = useState(false);
  const [localDeclaredAt, setLocalDeclaredAt] = useState<string | null>(null);
  const [failedNote, setFailedNote] = useState<'terminal' | 'generic' | null>(null);

  const declaredAt = learnerCloseDeclaredAt(session) ?? localDeclaredAt;

  const declareMut = useMutation({
    mutationFn: async () => {
      if (!onboardingRepo) throw new Error('no repo');
      return onboardingRepo.declareSessionClose(session.id);
    },
    onSuccess: (r) => {
      setConfirming(false);
      setFailedNote(null);
      setLocalDeclaredAt(r.declared_at);
      qc.invalidateQueries({ queryKey: ['live-session-full', session.id] });
    },
    onError: (e) => {
      setConfirming(false);
      setFailedNote(e instanceof SessionTerminalError ? 'terminal' : 'generic');
    },
  });

  return (
    <div
      className="border-t border-[var(--ls-border)]"
      style={{ padding: '8px 16px', flexShrink: 0 }}
    >
      {declaredAt ? (
        // 已按态 — 幂等容错: 重按无意义, 铃只剩安静的一行事实。
        <div className="flex items-center justify-end" style={{ gap: '6px' }}>
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: 'var(--ls-text-tertiary)' }}
          />
          <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]">
            {t('lesson.live.bellDeclared')}
          </span>
        </div>
      ) : confirming ? (
        <div className="flex flex-col" style={{ gap: '6px' }}>
          <span className="text-[12px] leading-[18px] text-[var(--ls-text-secondary)]">
            {t('lesson.live.bellConfirmBody')}
          </span>
          <span className="inline-flex items-center" style={{ gap: '10px' }}>
            <button
              type="button"
              onClick={() => declareMut.mutate()}
              disabled={declareMut.isPending}
              className="text-[12px] font-medium text-[var(--ls-text)] hover:opacity-80 disabled:opacity-40"
            >
              {declareMut.isPending
                ? t('lesson.live.bellDeclaring')
                : t('lesson.live.bellConfirm')}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-[12px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
            >
              {t('cards.cancel')}
            </button>
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-end" style={{ gap: '10px' }}>
          {failedNote && (
            <span
              className="text-[11px] leading-4"
              style={{
                color:
                  failedNote === 'terminal'
                    ? 'var(--ls-text-tertiary)'
                    : 'var(--ls-risk)',
              }}
            >
              {failedNote === 'terminal'
                ? t('lesson.live.bellFailedTerminal')
                : t('lesson.live.bellFailed')}
            </span>
          )}
          <button
            type="button"
            onClick={() => setConfirming(true)}
            title={t('lesson.live.bellTitle')}
            className="text-[11px] uppercase tracking-[0.05em] font-medium text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
          >
            {t('lesson.live.bellLabel')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * LiveSessionClose / CloseBlock — 收课三段 (SUMMARY / TEACHER REFLECTION /
 * NEXT ACTION), 读 live_sessions 的 summary / teacher_reflection /
 * next_action。曾整块退役, 2026-07-26 学习者本人裁定复归, 依据与分工
 * 原则见上面调用点的长注释。
 *
 * 渲染层对文本不做任何加工 —— 不检测、不过滤、不剥离内部 id。写什么显示
 * 什么; 写脏了在写入层治 (工具描述), 不在这里遮。
 */
function LiveSessionClose({ session }: { session: LiveSession }) {
  const { t } = useT();
  return (
    <div
      className="border-t border-[var(--ls-border)] flex flex-col"
      style={{
        padding: '14px 16px',
        gap: '10px',
        flexShrink: 0,
        maxHeight: '45vh',
        overflowY: 'auto',
        minHeight: 0,
      }}
    >
      {session.summary && (
        <CloseBlock label={t('lesson.live.summaryLabel')} body={session.summary} />
      )}
      {session.teacher_reflection && (
        <CloseBlock label={t('lesson.live.teacherReflectionLabel')} body={session.teacher_reflection} />
      )}
      {session.next_action && (
        <CloseBlock label={t('lesson.live.nextActionLabel')} body={session.next_action} />
      )}
    </div>
  );
}

function CloseBlock({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] font-medium text-[var(--ls-text-tertiary)]">
        {label}
      </div>
      <div
        className="text-[13px] leading-5 text-[var(--ls-text-secondary)]"
        style={{ marginTop: '3px' }}
      >
        {body}
      </div>
    </div>
  );
}

function LiveDot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block animate-pulse"
      style={{
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: 'var(--ls-text-tertiary)',
        animationDelay: delay,
      }}
    />
  );
}

/* ============================== LESSON MINDMAP =========================== */

function LessonMindmapEmbed({ lessonId }: { lessonId: LessonId }) {
  const repo = useRepository();
  const qc = useQueryClient();
  const { identity } = useIdentity();
  const agentLabel = identity ? cleanAgentName(identity.agent.display_name) : 'Agent';
  const { t } = useT();

  const mindmapsQ = useQuery({
    queryKey: ['mindmaps-lesson', lessonId],
    queryFn: () => (repo ? repo.getMindmapsForLesson(lessonId) : Promise.resolve([])),
    enabled: !!repo,
  });

  const mindmap = mindmapsQ.data?.[0];

  const resetMut = useMutation({
    mutationFn: () => {
      if (!repo || !mindmap) throw new Error('no mindmap');
      return repo.resetMindmap(mindmap.id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mindmaps-lesson', lessonId] }),
  });

  const restoreMut = useMutation({
    mutationFn: () => {
      if (!repo || !mindmap) throw new Error('no mindmap');
      return repo.restoreMindmapFromSeed(mindmap.id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mindmaps-lesson', lessonId] }),
  });

  if (!mindmap) return null;

  return (
    <section
      className="border border-[var(--ls-border)]"
      style={{ marginTop: '32px', padding: '18px 20px', borderRadius: '10px' }}
    >
      <div
        className="flex items-center justify-between flex-wrap"
        style={{ marginBottom: '14px', gap: '10px' }}
      >
        <div className="flex flex-col" style={{ gap: '2px' }}>
          <div className="text-[11px] font-medium leading-4 tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)]">
            {t('lesson.mindmapEmbed.heading')}
          </div>
          <div className="font-semibold text-[15px] leading-6">{mindmap.title}</div>
        </div>
        <div className="flex flex-wrap items-center" style={{ gap: '8px' }}>
          {mindmap.has_been_reset && (
            <button
              type="button"
              onClick={() => restoreMut.mutate()}
              disabled={restoreMut.isPending}
              className="inline-flex items-center border border-[var(--ls-border-strong)] text-[var(--ls-text-secondary)] font-medium hover:bg-[var(--ls-panel)] disabled:opacity-50 transition-colors duration-[var(--ls-duration-fast)]"
              style={{ height: '28px', padding: '0 10px', borderRadius: '6px', fontSize: '11px', lineHeight: '1' }}
            >
              {t('lesson.mindmapEmbed.restoreAgentVersion')}
            </button>
          )}
          {!mindmap.has_been_reset && mindmap.content.nodes.length > 0 && (
            <button
              type="button"
              onClick={() => resetMut.mutate()}
              disabled={resetMut.isPending}
              className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-tertiary)] font-medium hover:bg-[var(--ls-panel)] disabled:opacity-50 transition-colors duration-[var(--ls-duration-fast)]"
              style={{ height: '28px', padding: '0 10px', borderRadius: '6px', fontSize: '11px', lineHeight: '1' }}
            >
              {t('lesson.mindmapEmbed.clearAndRedo')}
            </button>
          )}
        </div>
      </div>

      <MindmapEmbed mindmap={mindmap} />

      <div className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]" style={{ marginTop: '12px' }}>
        {agentLabel}{t('lesson.mindmapEmbed.generatedPrefix')}<a href="/mindmap" className="hover:underline" style={{ color: 'var(--ls-structure)' }}>{t('mindmap.title')}</a>{t('lesson.mindmapEmbed.generatedSuffix')}
      </div>
    </section>
  );
}

/* ============================ EXERCISE SECTION =========================== */

// To-pool payload mapping (入池动作案) — same title/content/source_*/reason
// shape Review.tsx (入池按钮案) and Cards.tsx (卡片入池案) use for their own "To pool"
// actions; duplicated here rather than imported since those pages are out
// of this job's file domain and don't export it. `reason` reuses the
// exercise-source convention value already on record in
// PendingMindmapCard's doc comment (packages/contracts/src/mindmap.ts) and
// already exercised by annotation/AnnotationOverlay.tsx's own manual-click
// "To pool" action for its 'learner_highlight' counterpart — precedent is
// a fixed convention label, not a literal "this was actually missed twice"
// signal.
const EXERCISE_TITLE_MAX = 60;
// Content isn't length-constrained anywhere in the schema/repo layer and no
// existing "To pool" payload truncates it (AnnotationOverlay's `content`
// is the raw note/selection, full length) — but the pending-pool list
// (Mindmap.tsx) renders `content` as plain wrapping text with no
// line-clamp, and reference answers can run to paragraph length, so this
// job caps it to keep the pool preview scannable. Self-determined; not a
// brief-mandated number.
const EXERCISE_CONTENT_MAX = 200;

function truncateForPool(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function pendingExercisePayload(exercise: Exercise, lessonTitle: string) {
  const answer = exercise.reference_answer?.trim();
  return {
    title: truncateForPool(exercise.prompt, EXERCISE_TITLE_MAX),
    content: truncateForPool(answer || exercise.prompt, EXERCISE_CONTENT_MAX),
    source_type: 'exercise' as const,
    source_id: exercise.id as unknown as string,
    source_title: lessonTitle,
    reason: 'exercise_repeated_miss',
  };
}

function ExerciseSection({ lesson }: { lesson: LessonModel }) {
  const repo = useRepository();
  const { learnerId, pairId } = usePair();
  const qc = useQueryClient();
  const { t } = useT();

  const exQ = useQuery({
    queryKey: ['exercises', lesson.id],
    queryFn: () => (repo ? repo.getExercises(lesson.id) : Promise.resolve([])),
    enabled: !!repo,
  });
  const subQ = useQuery({
    queryKey: ['submissions', learnerId],
    queryFn: () =>
      repo && learnerId ? repo.getExerciseSubmissions(learnerId) : Promise.resolve([]),
    enabled: !!repo && !!learnerId,
    refetchInterval: 4_000,
  });

  // Pending pool dedup (入池动作案) — same read-only reuse of the Mindmap
  // pool's repo methods Cards.tsx (卡片入池案) / Review.tsx (入池按钮案) already rely on;
  // shared ['pending-cards', pairId] query key keeps all three pages'
  // pool state in sync without a bespoke fetch. Lives here (list level),
  // not in ExerciseCard, so the query runs once per lesson rather than
  // once per exercise — same shape as Cards.tsx's single top-level
  // pendingQ feeding every CardRow.
  const pendingQ = useQuery({
    queryKey: ['pending-cards', pairId],
    queryFn: () => (repo && pairId ? repo.getPendingCards(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });
  const pooledExerciseIds = useMemo(() => {
    const s = new Set<string>();
    for (const p of pendingQ.data ?? []) {
      if (p.source_type === 'exercise' && p.source_id) s.add(p.source_id);
    }
    return s;
  }, [pendingQ.data]);
  const toPoolMut = useMutation({
    mutationFn: (ex: Exercise) => {
      if (!repo || !pairId) throw new Error('no repo/pair');
      return repo.addPendingCard(pairId, pendingExercisePayload(ex, lesson.title));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pending-cards', pairId] }),
  });

  const exercises = exQ.data ?? [];
  const submissions = subQ.data ?? [];

  if (exercises.length === 0) return null;

  return (
    <section style={{ marginTop: '32px' }}>
      <div
        className="text-[11px] font-medium leading-4 tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)]"
        style={{ marginBottom: '14px' }}
      >
        {t('lesson.exercises.headingPrefix')}{exercises.length}
      </div>
      <div className="flex flex-col" style={{ gap: '14px' }}>
        {exercises.map((ex) => (
          <ExerciseCard
            key={ex.id}
            exercise={ex}
            submissions={submissions.filter((s) => s.exercise_id === ex.id)}
            pooled={pooledExerciseIds.has(ex.id as unknown as string)}
            toPoolPending={
              toPoolMut.isPending &&
              (toPoolMut.variables?.id as unknown as string) === (ex.id as unknown as string)
            }
            onToPool={() => toPoolMut.mutate(ex)}
          />
        ))}
      </div>
    </section>
  );
}

function ExerciseCard({
  exercise,
  submissions,
  pooled,
  toPoolPending,
  onToPool,
}: {
  exercise: Exercise;
  submissions: ExerciseSubmission[];
  pooled: boolean;
  toPoolPending: boolean;
  onToPool: () => void;
}) {
  const repo = useRepository() as (Repository & ConfidenceCaptureRepo & ProgressRepo) | null;
  const { learnerId } = usePair();
  const qc = useQueryClient();
  const { identity } = useIdentity();
  const agentLabel = identity ? cleanAgentName(identity.agent.display_name) : 'Agent';
  const { t } = useT();
  const confidenceModeEnabled = useConfidenceModeEnabled();

  const latest = useMemo(() => {
    const active = submissions
      .filter((s) => s.status !== 'draft')
      .sort((a, b) => (b.submitted_at ?? '').localeCompare(a.submitted_at ?? ''));
    return active[0];
  }, [submissions]);

  const [draft, setDraft] = useState('');
  // Learner Model 批1 (LEARNER-MODEL-BRIEF §3/§9 考场条款) — 可跳过 (undefined
  // = skipped), 只住这个评估表面, 从不出现在 Live Teaching / 课文正文里.
  const [confidence, setConfidence] = useState<ConfidenceLevel | undefined>(undefined);

  // §3 反刍窗口 — edit a submitted-but-ungraded
  // answer in place (PATCH, not a new submission). Separate from resubmit
  // (post-graded, new history entry): no status flip, no history branch,
  // the grading queue just sees the updated text next time an agent picks
  // it up. (withdraw-to-draft retired — see button block below.)
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [alreadyGradedMsg, setAlreadyGradedMsg] = useState<string | null>(null);
  const editMut = useMutation({
    mutationFn: () => {
      if (!repo || !latest) throw new Error('no submission');
      return repo.editSubmission(latest.id, editDraft);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['submissions', learnerId] });
      setEditing(false);
    },
    onError: (e) => {
      if (e instanceof AlreadyGradedError) {
        setAlreadyGradedMsg(e.message);
        qc.invalidateQueries({ queryKey: ['submissions', learnerId] });
      } else {
        console.error('[editSubmission]', e);
      }
    },
  });

  const submitMut = useMutation({
    mutationFn: () => {
      if (!repo || !learnerId) throw new Error('no repo');
      return repo.submitExerciseWithConfidence({
        exercise_id: exercise.id,
        learner_id: learnerId,
        learner_answer: draft,
        confidence,
        // 置信度去数字化 去数字化: 第四档自定义百分比已移除, 精确值改由选中档位
        // 的固定锚定值派生 (0.35/0.65/0.9 → 存 35/65/90), 不再是学习者自己
        // 打的数字.
        confidence_pct: confidence ? CONFIDENCE_ANCHOR_PCT[confidence] : undefined,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['submissions', learnerId] });
      setDraft('');
      setConfidence(undefined);
    },
  });

  const [resubmitDraft, setResubmitDraft] = useState('');
  const [showResubmit, setShowResubmit] = useState(false);
  const resubmitMut = useMutation({
    mutationFn: () => {
      if (!repo || !latest) throw new Error('no submission');
      return repo.resubmitExercise(latest.id, resubmitDraft);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['submissions', learnerId] });
      setResubmitDraft('');
      setShowResubmit(false);
    },
  });

  const status = latest?.status ?? 'draft';

  return (
    <div
      className="border border-[var(--ls-border)] bg-[var(--ls-bg)]"
      style={{ padding: '18px 20px', borderRadius: '10px' }}
    >
      <div className="flex items-center justify-between flex-wrap" style={{ marginBottom: '10px', gap: '10px' }}>
        <div className="text-[11px] font-medium leading-4 tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)]">
          {t('lesson.exercises.orderPrefix')}{exercise.order}
        </div>
        {/* 入池动作案: To pool sits in this meta row, next to the status
            badge — both are ambient state, not the primary action line
            (Submit / Edit / Re-submit below stays untouched). Grouped
            together on the right so the badge — the more important of the
            two signals — keeps the outermost, most-noticed slot. */}
        <div className="flex items-center" style={{ gap: '10px' }}>
          <ToPoolButton pooled={pooled} pending={toPoolPending} onClick={onToPool} />
          <StatusBadge status={status} />
        </div>
      </div>

      <p className="text-[14px] leading-[22px] text-[var(--ls-text)]" style={{ marginBottom: '14px' }}>
        {exercise.prompt}
      </p>

      {!latest && (
        <>
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              const el = e.target;
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 320) + 'px';
            }}
            placeholder={t('lesson.exercises.answerPlaceholder')}
            rows={4}
            className="w-full border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[14px] leading-6 placeholder:text-[var(--ls-text-tertiary)] focus:outline-none focus:border-[var(--ls-border-strong)] resize-y"
            style={{ padding: '10px 12px', borderRadius: '6px', overflowY: 'auto' }}
          />
          {confidenceModeEnabled && (
            <div style={{ marginTop: '10px' }}>
              <ConfidencePicker
                level={confidence}
                onLevelChange={setConfidence}
              />
            </div>
          )}
          <div className="flex flex-wrap" style={{ marginTop: '10px', gap: '10px' }}>
            <button
              type="button"
              onClick={() => submitMut.mutate()}
              disabled={!draft.trim() || submitMut.isPending}
              className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity duration-[var(--ls-duration-fast)]"
              style={{ height: '34px', padding: '0 16px', borderRadius: '6px', fontSize: '13px', lineHeight: '1' }}
            >
              {t('quiz.submit')}
            </button>
            <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)] self-center">
              {t('lesson.exercises.batchGradeNote')}
            </span>
          </div>
        </>
      )}

      {latest && (status === 'submitted' || status === 'pending_grade') && !editing && (
        <>
          <div
            className="border border-[var(--ls-border)] bg-[var(--ls-bg-subtle)] text-[13px] leading-5"
            style={{ padding: '10px 12px', borderRadius: '8px' }}
          >
            {latest.learner_answer}
          </div>
          <div className="flex flex-wrap items-center" style={{ marginTop: '10px', gap: '10px' }}>
            {/* §3 反刍窗口 — single edit entry point:
                PATCHes the answer in place (stays 'submitted', no status
                flip, no history branch). withdraw-to-draft retired —
                阅卷铃制度下批改只在摇铃后发生,原本防的竞态已不存在。 */}
            <button
              type="button"
              onClick={() => {
                setEditDraft(latest.learner_answer);
                setAlreadyGradedMsg(null);
                setEditing(true);
              }}
              className="text-[12px] font-medium text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)] transition-colors"
            >
              {t('lesson.exercises.editAnswerButton')}
            </button>
            <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]">
              {status === 'pending_grade'
                ? t('lesson.exercises.gradingNow')
                : t('lesson.exercises.submittedWaiting')}
            </span>
          </div>
          {alreadyGradedMsg && (
            <div className="text-[11px] text-[var(--ls-risk)]" style={{ marginTop: '8px' }}>
              {alreadyGradedMsg}
            </div>
          )}
        </>
      )}

      {latest && (status === 'submitted' || status === 'pending_grade') && editing && (
        <div className="flex flex-col" style={{ gap: '8px' }}>
          <textarea
            value={editDraft}
            onChange={(e) => {
              setEditDraft(e.target.value);
              const el = e.target;
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 320) + 'px';
            }}
            rows={4}
            className="w-full border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[14px] leading-6 focus:outline-none focus:border-[var(--ls-border-strong)] resize-y"
            style={{ padding: '10px 12px', borderRadius: '6px', overflowY: 'auto' }}
          />
          <div className="flex flex-wrap" style={{ gap: '8px' }}>
            <button
              type="button"
              onClick={() => editMut.mutate()}
              disabled={!editDraft.trim() || editMut.isPending}
              className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 disabled:opacity-40 transition-opacity duration-[var(--ls-duration-fast)]"
              style={{ height: '30px', padding: '0 12px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
            >
              {editMut.isPending ? t('lesson.exercises.savingEllipsis') : t('lesson.exercises.editSaveButton')}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
              style={{ height: '30px', padding: '0 12px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
            >
              {t('cards.cancel')}
            </button>
          </div>
        </div>
      )}

      {latest && status === 'graded' && (
        <>
          <div
            className="border border-[var(--ls-border)] bg-[var(--ls-bg-subtle)] text-[13px] leading-5"
            style={{ padding: '10px 12px', borderRadius: '8px', marginBottom: '12px' }}
          >
            <div
              className="text-[11px] font-medium leading-4 tracking-[0.04em] uppercase text-[var(--ls-text-tertiary)]"
              style={{ marginBottom: '6px' }}
            >
              {t('lesson.exercises.yourAnswerLabel')}
            </div>
            {latest.learner_answer}
          </div>
          <div
            className="border border-[var(--ls-border-strong)] bg-[var(--ls-bg)] text-[13px] leading-[22px]"
            style={{ padding: '12px 14px', borderRadius: '8px' }}
          >
            <div className="flex items-center justify-between flex-wrap" style={{ gap: '8px', marginBottom: '6px' }}>
              <div className="text-[11px] font-medium leading-4 tracking-[0.04em] uppercase" style={{ color: 'var(--ls-corroborated)' }}>
                {agentLabel}{t('lesson.exercises.feedbackSuffix')}
              </div>
              {typeof latest.agent_score === 'number' && (
                <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)] tabular-nums">
                  {t('lesson.exercises.scorePrefix')}{(latest.agent_score * 100).toFixed(0)}%
                </span>
              )}
            </div>
            <div>{latest.agent_feedback ?? '—'}</div>
          </div>
          <div className="flex flex-wrap items-center" style={{ marginTop: '12px', gap: '10px' }}>
            {!showResubmit ? (
              <button
                type="button"
                onClick={() => setShowResubmit(true)}
                className="inline-flex items-center border border-[var(--ls-border-strong)] text-[var(--ls-text)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
                style={{ height: '30px', padding: '0 12px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
              >
                {t('lesson.exercises.resubmitButton')}
              </button>
            ) : (
              <div className="w-full flex flex-col" style={{ gap: '8px' }}>
                <textarea
                  value={resubmitDraft}
                  onChange={(e) => {
                    setResubmitDraft(e.target.value);
                    const el = e.target;
                    el.style.height = 'auto';
                    el.style.height = Math.min(el.scrollHeight, 320) + 'px';
                  }}
                  placeholder={t('lesson.exercises.newAttemptPlaceholder')}
                  rows={3}
                  className="w-full border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[14px] leading-6 placeholder:text-[var(--ls-text-tertiary)] focus:outline-none focus:border-[var(--ls-border-strong)] resize-y"
                  style={{ padding: '10px 12px', borderRadius: '6px', overflowY: 'auto' }}
                />
                <div className="flex flex-wrap" style={{ gap: '8px' }}>
                  <button
                    type="button"
                    onClick={() => resubmitMut.mutate()}
                    disabled={!resubmitDraft.trim() || resubmitMut.isPending}
                    className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 disabled:opacity-40 transition-opacity duration-[var(--ls-duration-fast)]"
                    style={{ height: '30px', padding: '0 12px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
                  >
                    {t('lesson.exercises.submitNewVersion')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowResubmit(false);
                      setResubmitDraft('');
                    }}
                    className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
                    style={{ height: '30px', padding: '0 12px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
                  >
                    {t('cards.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// ToPoolButton — 入池动作案's "To Pending Pool" action for exercises, same
// three-state pill (To pool / Adding… / In pool) and dimensions as
// Review.tsx's ToPoolButton; duplicated rather than imported since
// Review.tsx is out of this job's file domain and doesn't export it.
// ============================================================================

function ToPoolButton({
  pooled,
  pending,
  onClick,
}: {
  pooled: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pooled || pending}
      title={
        pooled
          ? t('lesson.exercises.alreadyInPoolTitle')
          : t('lesson.exercises.sendToPoolTitle')
      }
      className="flex-none inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      style={{
        height: '22px',
        padding: '0 9px',
        borderRadius: '999px',
        fontSize: '10px',
        lineHeight: '1',
      }}
    >
      {pooled ? t('cards.inPool') : pending ? t('cards.adding') : t('annotation.toPool')}
    </button>
  );
}

function StatusBadge({ status }: { status: ExerciseSubmission['status'] }) {
  const { t } = useT();
  const map: Record<
    ExerciseSubmission['status'],
    { labelKey: DictKey; color: string }
  > = {
    draft: { labelKey: 'lesson.exercises.status.draft', color: 'var(--ls-text-tertiary)' },
    submitted: { labelKey: 'lesson.exercises.status.submitted', color: 'var(--ls-structure)' },
    pending_grade: { labelKey: 'lesson.exercises.status.grading', color: 'var(--ls-hypothesis)' },
    graded: { labelKey: 'lesson.exercises.status.graded', color: 'var(--ls-corroborated)' },
  };
  const { labelKey, color } = map[status];
  const label = t(labelKey);
  return (
    <span
      className="inline-flex items-center border tracking-[0.04em] uppercase font-medium"
      style={{
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: '10px',
        lineHeight: '14px',
        borderColor: color,
        color,
        gap: '6px',
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

/* ==================== ASYNC TEACHING LOOP (§2/§4/§6) =================== */
//
// 2026-07-11 施工批 — prerequisite map +
// informed-skip banner (§2), declare-completed checklist (§6). Patch
// rendering (§4) lives in PagedLesson.tsx (it needs page-anchor resolution,
// which is that component's own turf).
//
// §5's loop-back receipt card (itemized "N change(s)" changelog) was
// retired 2026-07-22 (行项退役案) — product ruling: the itemized rows
// (exercise_feedback/journal_entry/etc.) were bookkeeping verbs dressed as
// content, zero learner value. LessonStatusBadge's 已回课 pill (rendered in
// this page's header, see the `state={currentLessonProgress?.state}` call
// near the top of the file) already communicates closure on its own — no
// replacement UI needed. The receipt data itself (lesson_loop_receipts /
// getLessonLoopReceipts) is untouched server-side; this was display-only
// retirement.

/**
 * PrerequisiteBanner — §2 知情跳过. "前置" is deliberately the simplest
 * available signal (immediately-preceding lesson in course order) rather
 * than a real prerequisite DAG: the brief's own instruction was "先勘察前端
 * 现有的课程结构数据源, 够用就用 lessons order 相邻关系, 别为此新造后端" —
 * there is no prerequisite graph anywhere in the schema (考纲登记簿's
 * syllabus_mappings is topic↔asset coverage, not lesson↔lesson prerequisite),
 * so course order is the honest fallback, not a placeholder for something
 * richer that already exists.
 *
 * Condition is `progress.state !== 'closed'` on that previous lesson — this
 * reads slightly broader than the brief's literal "有未批改提交" (which would
 * require fetching the prerequisite's own exercises + submissions just for
 * this banner), but it's the same condition the brief's own example banner
 * text names directly ("本课的前置《X》尚未回课") and it never false-negatives
 * (any ungraded-submission case is necessarily state !== 'closed' too).
 * Documented as a deliberate scope simplification, not an oversight.
 */
function PrerequisiteBanner({
  lessons,
  currentLessonId,
  progress,
}: {
  lessons: LessonModel[];
  currentLessonId: LessonId;
  progress: LessonProgress[];
}) {
  const { t } = useT();
  const sorted = useMemo(() => [...lessons].sort((a, b) => a.order - b.order), [lessons]);
  const currentIdx = sorted.findIndex((l) => l.id === currentLessonId);
  const prereq = currentIdx > 0 ? sorted[currentIdx - 1] : null;
  const prereqProgress = prereq ? progress.find((p) => p.lesson_id === prereq.id) : undefined;
  const notLoopedBack = !!prereq && prereqProgress?.state !== 'closed';

  const dismissKey = prereq ? `learn-shell:prereq-banner-dismissed:${currentLessonId}:${prereq.id}` : null;
  const [dismissed, setDismissed] = useState(() => {
    if (!dismissKey) return false;
    try {
      return localStorage.getItem(dismissKey) === '1';
    } catch {
      return false;
    }
  });

  if (!notLoopedBack || dismissed) return null;

  return (
    <div
      className="flex items-center justify-between border border-[var(--ls-border)] bg-[var(--ls-bg-subtle)]"
      style={{ borderRadius: '8px', padding: '10px 16px', marginBottom: '16px', gap: '12px' }}
    >
      <span className="text-[12px] leading-[18px] text-[var(--ls-text-secondary)]">
        {t('lesson.prereq.bannerPrefix')}
        <Link
          to={`/courses/${prereq!.course_id}/lessons/${prereq!.id}`}
          className="hover:underline"
          style={{ color: 'var(--ls-text)' }}
        >
          {prereq!.title}
        </Link>
        {t('lesson.prereq.bannerSuffix')}
      </span>
      <button
        type="button"
        aria-label={t('lesson.prereq.dismissAria')}
        onClick={() => {
          setDismissed(true);
          if (dismissKey) {
            try {
              localStorage.setItem(dismissKey, '1');
            } catch {
              /* ignore */
            }
          }
        }}
        className="flex-none text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors"
        style={{ fontSize: '14px', lineHeight: 1, width: '20px', height: '20px' }}
      >
        ×
      </button>
    </div>
  );
}

/**
 * DeclareCompletedSection — §6 学习者宣布已学完. A quiet text-button entry
 * point (not a CTA-styled button — this is a self-report, not an
 * achievement) that expands an inline checklist preview, never a modal:
 * brief is explicit ("轻量, 非模态大动画") and the house rule is even more
 * explicit (证书的诞生不比翻页更隆重) — same register applies here.
 */
function DeclareCompletedSection({
  lesson,
  progress,
  pagesRead,
  pagesTotal,
  currentPageIndex,
}: {
  lesson: LessonModel;
  progress?: LessonProgress;
  pagesRead: number;
  pagesTotal: number;
  /** 0-based, 迁移 0037 — forwarded to declareLessonCompleted as
   *  current_page_index (server unions it into the persisted pages_visited
   *  footprint before computing the checklist's real pages_read). */
  currentPageIndex: number;
}) {
  const { t } = useT();
  const repo = useRepository() as (Repository & ProgressRepo) | null;
  const { pairId, learnerId } = usePair();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  // 阅卷铃条款 — declare 落盘成功到 course-progress 重取落地之间的
  // 空档里, progress prop 还是旧状态; 这个本地位补上那几百毫秒, 让铃在确认
  // 成功的当口就响, 不等重取。
  const [justDeclared, setJustDeclared] = useState(false);

  const exQ = useQuery({
    queryKey: ['exercises', lesson.id],
    queryFn: () => (repo ? repo.getExercises(lesson.id) : Promise.resolve([])),
    enabled: !!repo && expanded,
  });
  const subQ = useQuery({
    queryKey: ['submissions', learnerId],
    queryFn: () => (repo && learnerId ? repo.getExerciseSubmissions(learnerId) : Promise.resolve([])),
    enabled: !!repo && !!learnerId && expanded,
  });
  const exercises = exQ.data ?? [];
  const exerciseIds = new Set(exercises.map((e) => e.id as unknown as string));
  const submittedCount = new Set(
    (subQ.data ?? [])
      .filter((s) => s.status !== 'draft' && exerciseIds.has(s.exercise_id as unknown as string))
      .map((s) => s.exercise_id)
  ).size;

  const declareMut = useMutation({
    mutationFn: () => {
      if (!repo || !pairId) throw new Error('no repo');
      return repo.declareLessonCompleted(pairId, lesson.id, {
        pages_total: pagesTotal || null,
        current_page_index: pagesTotal > 0 ? currentPageIndex : null,
        gaps: [],
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['course-progress', pairId, lesson.course_id] });
      setExpanded(false);
      setJustDeclared(true);
    },
  });

  const alreadyDeclared = progress?.state === 'completed_declared';

  // 按钮升档判定 (阅卷铃条款 件一) — "可宣布"的信号: 全部页面已读。页数用
  // 本挂载最高水位 (pagesRead) 与服务端足迹 (progress.pages_visited, 迁移
  // 0037) 取并, 换设备/重进也认账; 越界的陈年页码 (课文改短后) 过滤掉。
  // 不新增 gating: 按钮任何时候都可点 (带缺口宣布本来就合法), 升档只管
  // "该亮的时刻亮"。已宣布后回落安静档 — 那时的主角是阅卷铃, 不是重宣布。
  const visitedCount =
    pagesTotal > 0
      ? new Set([
          ...Array.from({ length: Math.min(pagesRead, pagesTotal) }, (_, i) => i),
          ...(progress?.pages_visited ?? []).filter((p) => p >= 0 && p < pagesTotal),
        ]).size
      : 0;
  const declarable = pagesTotal > 0 && visitedCount >= pagesTotal;
  const promoted = declarable && !alreadyDeclared && !justDeclared;

  // 阅卷铃可见期 = completed_declared 且回路未收口。'closed' 时整个 section
  // 不渲染 (SelfStudy 的门), 所以这里只需认 completed_declared / 刚宣布成功
  // 两种脸 — 回路收口状态前端本来就能从 progress.state 读到, 不新增请求。
  const bellVisible = alreadyDeclared || justDeclared;

  return (
    <section
      className="border-t border-[var(--ls-border)]"
      style={{ marginTop: '32px', paddingTop: '16px' }}
    >
      {bellVisible && (
        <div style={{ marginBottom: '16px', maxWidth: '560px' }}>
          <SummonAgentCard
            lessonTitle={lesson.title}
            contextId={lesson.id as unknown as string}
            variant="grading"
          />
        </div>
      )}

      {alreadyDeclared && progress?.declared_at && (
        <div className="text-[11px] text-[var(--ls-text-tertiary)]" style={{ marginBottom: '8px' }}>
          {t('lesson.progress.declaredAtPrefix')}
          {new Date(progress.declared_at).toLocaleDateString()}
        </div>
      )}

      {!expanded ? (
        // 升档 (阅卷铃条款 件一): 全部页面读完后, 入口从安静文字档提到实心
        // 主按钮档 — 与核对单里确认键同一档 (bg-text/text-bg), 不造新色,
        // 不加动画; 未读完/已宣布时维持原来的安静文字档。
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={
            promoted
              ? 'inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 transition-opacity duration-[var(--ls-duration-fast)]'
              : 'text-[12px] font-medium text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)] transition-colors'
          }
          style={
            promoted
              ? { height: '30px', padding: '0 14px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }
              : undefined
          }
        >
          {alreadyDeclared ? t('lesson.progress.redeclareButton') : t('lesson.progress.declareButton')}
        </button>
      ) : (
        <div
          className="border border-[var(--ls-border)]"
          style={{ borderRadius: '8px', padding: '14px 16px', maxWidth: '420px' }}
        >
          <div
            className="text-[10px] uppercase tracking-[0.08em] font-medium text-[var(--ls-text-tertiary)]"
            style={{ marginBottom: '8px' }}
          >
            {t('lesson.progress.checklistHeading')}
          </div>
          <div className="flex flex-col text-[13px] leading-5 text-[var(--ls-text)]" style={{ gap: '4px' }}>
            {pagesTotal > 0 && (
              <div>
                {t('lesson.progress.checklistPagesPrefix')}
                {pagesRead}/{pagesTotal}
                {t('lesson.progress.checklistPagesRead')}
              </div>
            )}
            {exercises.length > 0 && (
              <div>
                {t('lesson.progress.checklistExercisesPrefix')}
                {submittedCount}/{exercises.length}
                {t('lesson.progress.checklistExercisesSubmitted')}
              </div>
            )}
          </div>
          <div
            className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]"
            style={{ marginTop: '10px' }}
          >
            {t('lesson.progress.checklistGapNote')}
          </div>
          <div className="flex items-center" style={{ marginTop: '12px', gap: '10px' }}>
            <button
              type="button"
              onClick={() => declareMut.mutate()}
              disabled={declareMut.isPending}
              className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 disabled:opacity-40 transition-opacity duration-[var(--ls-duration-fast)]"
              style={{ height: '30px', padding: '0 14px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
            >
              {declareMut.isPending ? t('lesson.progress.declaringEllipsis') : t('lesson.progress.confirmButton')}
            </button>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
              style={{ height: '30px', padding: '0 12px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
            >
              {t('cards.cancel')}
            </button>
          </div>
          {declareMut.isError && (
            <div className="text-[11px] text-[var(--ls-risk)]" style={{ marginTop: '8px' }}>
              {t('lesson.progress.declareError')}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * LessonClosureNote — 结课的显性标识 + 去 Journal 的路 (2026-07-26 学习者裁定)。
 *
 * 三块评估内容 (Live 场评 / 折叠区教学观察 / 课级总评) 撤出课文页之后, 这里
 * 顶上的不是第四块内容, 是一条"闭环完成"的状态行: 学习者原话 "要在结课之后
 * 留一个导向 Journal 页面的链接, 就是要让我有一个结课完成的显性标识"。一个,
 * 不是三个 —— 撤掉的三块统一由它替代。
 *
 * 门槛: 只在 progress.state === 'closed' 时挂载 (门在调用点, SelfStudy 尾部
 * 原来 PostLessonEvaluationBlock 的位置 —— 收尾区, footer 之前)。未结课时
 * 那个位置本来就是 DeclareCompletedSection 的地盘, 两者天然互斥。
 *
 * 视觉零新造: 徽章直接复用 LessonStatusBadge —— 就是页头那颗"已回课"pill
 * (--ls-corroborated + 圆点 + 10px uppercase), 同一个组件同一个词, 不另造
 * 一套"完成"话术; 链接照抄本文件既有的 hover:underline + --ls-structure
 * (见 LessonMindmapEmbed 的思维导图链接 / PrerequisiteBanner 的前置课链接)。
 *
 * 跳转目标: /sessions (Journal), 带 ?course= 预选该课所属课程的筛选 chip ——
 * 落地即是这门课的时间线, 而不是全部课程混排。零新后端: course 参数由
 * JournalPage 自己解析成它本来就有的 CourseFilter 状态初值。
 * 没做到条目级锚点是有意的: Journal 的课条目由 post_lesson_evaluations
 * 派生 (date = evaluation.created_at), 跟 lesson_progress.closed_at 不同源,
 * 且"3-课阈值"下一节已结课的课可能根本没有课条目 —— 按 closed_at 造锚点会
 * 时不时指向空处, 比落在列表上更糟。
 */
function LessonClosureNote({ lesson }: { lesson: LessonModel }) {
  const { t } = useT();
  return (
    <section
      className="border-t border-[var(--ls-border)] flex items-center flex-wrap"
      style={{ marginTop: '18px', paddingTop: '14px', gap: '10px' }}
    >
      <LessonStatusBadge state="closed" />
      <Link
        to={`/sessions?course=${lesson.course_id}`}
        className="hover:underline text-[12px] leading-[18px]"
        style={{ color: 'var(--ls-structure)' }}
      >
        {t('lesson.closure.journalLink')}
      </Link>
    </section>
  );
}

/* ============================ REVISION PILL ============================== */

/**
 * RevisionPill — update_lesson (课文修订机制) minimal-visibility UI. Shows only
 * when the lesson has at least one teaching-kind revision (迁移 0033 双轨
 * 修订: axes.teaching_revision > 1) — a lesson that's only ever been touched
 * by technical revisions (格式/门禁/重构/错别字) shows no pill at all, same
 * "隐身" treatment as its history entries below. Click expands a popover
 * with the lesson's teaching revision history — "病历本" (病历本机制): every
 * `lesson_revisions` row of kind='teaching', newest first (server defaults
 * `GET .../revisions` to kind=teaching — 迁移 0033), each with its reason,
 * evidence (when present), and timestamp. Pill itself is untouched; only the
 * popover content grew from a single latest-reason blurb into a scrollable
 * history list. evidence-visible, never silent (within the teaching track).
 *
 * Visual language borrows StatusBadge's pill (border + color + dot) —
 * shares its exact box model via components/StatusPill.tsx now (2026-07-29
 * header-pill misalignment fix) rather than hand-copying the style object.
 * The anchor below is `relative inline-flex items-center`, NOT
 * `inline-block` — see StatusPill.tsx's header comment for why that
 * distinction is load-bearing (inline-block blockifies to `block` as a
 * flex item and re-introduces a line-box/strut offset around the button;
 * inline-flex blockifies to `flex`, which has no such strut).
 */
function RevisionPill({ lesson }: { lesson: LessonWithAxes }) {
  const repo = useRepository();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const revision = lesson.axes?.teaching_revision ?? 1;

  const revisionsQ = useQuery({
    queryKey: ['lesson-revisions', lesson.id],
    queryFn: () =>
      repo ? repo.getLessonRevisions(lesson.id) : Promise.resolve([]),
    enabled: !!repo && open,
  });

  if (revision <= 1) return null;

  const color = 'var(--ls-structure)';

  return (
    <span className="relative inline-flex items-center">
      <StatusPillButton color={color} onClick={() => setOpen((o) => !o)}>
        {t('lesson.revision.badgePrefix')}{revision}
      </StatusPillButton>

      {open && (
        <div
          className="absolute z-10 border border-[var(--ls-border-strong)] bg-[var(--ls-bg)]"
          style={{
            top: 'calc(100% + 6px)',
            left: 0,
            width: '320px',
            padding: '12px 14px',
            borderRadius: '8px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          }}
        >
          <div
            className="text-[10px] uppercase tracking-[0.05em] font-medium text-[var(--ls-text-tertiary)]"
            style={{ marginBottom: '8px' }}
          >
            {t('lesson.revision.historyHeading')}
          </div>
          {revisionsQ.isLoading ? (
            <div className="text-[12px] text-[var(--ls-text-tertiary)]">{t('contract.loading')}</div>
          ) : revisionsQ.data && revisionsQ.data.length > 0 ? (
            <div
              className="flex flex-col"
              style={{ gap: '10px', maxHeight: '260px', overflowY: 'auto' }}
            >
              {revisionsQ.data.map((rev) => (
                <div
                  key={rev.id}
                  className="border-b border-[var(--ls-border)] last:border-b-0"
                  style={{ paddingBottom: '10px' }}
                >
                  <div
                    className="text-[10px] uppercase tracking-[0.05em] font-medium tabular-nums"
                    style={{ color }}
                  >
                    v{rev.revision} → v{rev.revision + 1}
                  </div>
                  <div
                    className="text-[13px] leading-[20px] text-[var(--ls-text)]"
                    style={{ marginTop: '4px' }}
                  >
                    {rev.reason}
                  </div>
                  {rev.evidence && (
                    <div
                      className="text-[12px] leading-[18px] text-[var(--ls-text-secondary)]"
                      style={{ marginTop: '4px' }}
                    >
                      {rev.evidence}
                    </div>
                  )}
                  <div
                    className="text-[11px] text-[var(--ls-text-tertiary)]"
                    style={{ marginTop: '4px' }}
                  >
                    {new Date(rev.revised_at).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[12px] text-[var(--ls-text-tertiary)]">
              {t('lesson.revision.noRecordFound')}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
