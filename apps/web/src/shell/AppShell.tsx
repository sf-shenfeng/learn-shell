import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useHotkeys } from 'react-hotkeys-hook';
import { useQuery } from '@tanstack/react-query';
import type { CourseId, TeachingContract } from '@learn-shell/contracts';
import PairProvider, { usePair } from './PairProvider';
import { useIdentity } from '../lib/identity';
import { resolvePairDisplayName } from '../lib/pairDisplay';
import RecentRail from './RecentRail';
import CommandPalette from './CommandPalette';
import Shortcuts from './Shortcuts';
import FloatingAskAgent from './FloatingAskAgent';
import PoolDrawer from '../pool/PoolDrawer';
import NotesDrawer from '../journal/NotesDrawer';
import FirstRun from '../pages/FirstRun';
import { usePrefersReducedMotion } from './FlipCard';
import Kbd from './Kbd';

const SIDEBAR_COLLAPSED_KEY = 'learn-shell:sidebar-collapsed';

// 手感调优（实机反馈: 收起/展开偏硬）: collapse 略快于 expand — 方向感
// 是"顺滑"的一部分，对称的开合时长反而读起来机械。数值落在 brief 给的
// 窗口内 (collapse 180–220ms / expand 220–280ms)。PoolDrawer.tsx 的抽屉
// 收纳用同一对数值，两处手感是同一套系统。
const SIDEBAR_COLLAPSE_MS = 200; // 收起（宽度 → 0）
const SIDEBAR_EXPAND_MS = 240; // 展开（宽度 → 230）
// 内容层的 opacity 淡出比容器的 width/transform 更快收尾，让文字在裁切边缘
// 追上来之前就已经基本隐去——避免"逐字被裁掉"的硬切感（原实现只同步了
// width 和 transform，没有淡出，文字是被裁边活活切掉的）。
const SIDEBAR_FADE_MS = 130;

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}
import { useT } from '../i18n';
import { getRepositoryMode, useRepository, useRepositoryState } from '../repository';

// 卡池抽屉化 二期: Pool's nav entry is removed — it's a drawer now, summoned
// via the RecentRail row or G P, not a top-level route. The 'nav.pool'
// i18n key stays in the dict unused (brief: dict keys may only be removed
// in files outside this task's domain, not added — leaving it is the safe
// no-op).
//
// Dashboard 裁撤案: Dashboard 裁撤 — 同一条 no-op 处理: 'nav.dashboard' 字典键留着
// 不删 (dict.ts 不在这批文件域内)，只摘掉这条 nav 入口 + 下面 G D 的 kbd 提示。
//
// 证书化 (2026-07-08): Contract 的立约入口职能已死 — 同一 no-op
// 处理: 'nav.contract' 字典键留着不删 (为已有 leftover 约定, 且这批文件域外)，
// 摘掉这条 nav 入口 + Shortcuts.tsx 里的 G T 映射。签好的合同现在活在
// Settings 的"证书"区块；待签的合同走 RecentRail 的"待签之约"行 + 下面
// PairHeader 的轻提示徽章，不再靠一个常驻 nav 入口撑场面。
const NAV_KEYS = [
  { to: '/lesson', key: 'nav.lesson' as const, kbd: 'G L' },
  { to: '/review', key: 'nav.review' as const, kbd: 'G R' },
  { to: '/cards', key: 'nav.cards' as const, kbd: 'G C' },
  // 批G (门牌): this nav seat ("高频回访面，
  // 过门牌法") reuses 'G D', freed up when Dashboard's own nav entry was cut
  // (Dashboard 裁撤案, see this file's other comments); D reads as "Document" here.
  // Documents 改名案: nav label renamed Reading → Documents (zh: 阅读 → 文档) so
  // the sidebar name, the G D mnemonic, and RecentRail's row tag (was
  // "Doc", Doc 命名统一) all point at the same word instead of three near-
  // misses; 'nav.reading' i18n key kept as-is (route/key rename is outside
  // this task's file domain), only its value changed.
  { to: '/documents', key: 'nav.reading' as const, kbd: 'G D' },
  // Documents 改名案: kbd G S → G J — "S" was Sessions' mnemonic from before this
  // route was absorbed into Journal (pages/Sessions.tsx now just re-exports
  // JournalPage; see its docblock + journal/JournalPage.tsx header). Sessions
  // isn't a live feature to hand G S back to, so it's simply retired (same
  // no-claimant fate as G T after Contract's nav entry was cut, above).
  { to: '/sessions', key: 'nav.sessions' as const, kbd: 'G J' },
  { to: '/quiz', key: 'nav.quiz' as const, kbd: 'G Q' },
  { to: '/mindmap', key: 'nav.mindmap' as const, kbd: 'G M' },
];

const SETTINGS_NAV = { to: '/settings', key: 'nav.settings' as const, kbd: 'G ,' };

export default function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 卡池抽屉化 二期: Pool drawer open/close — lifted here and threaded down
  // as plain props, same shape as paletteOpen/CommandPalette right above.
  // No new Context: both summon points (RecentRail's row, Shortcuts' G P)
  // are direct children of AppShell already, so prop-passing is the
  // "现有 shell 层 state 模式" the brief points at — a Context would just
  // duplicate what's already a one-hop wire.
  const [poolOpen, setPoolOpen] = useState(false);
  // 批F: Notes drawer open/close — same lifted-state shape as poolOpen right
  // above (RecentRail's "笔记" row + Shortcuts' G N both summon it, both
  // direct children of AppShell already, same one-hop prop wire, no Context).
  const [notesOpen, setNotesOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => readCollapsed());
  const { t } = useT();
  const location = useLocation();
  const prefersReducedMotion = usePrefersReducedMotion();

  // Direction-aware timing — see SIDEBAR_COLLAPSE_MS/SIDEBAR_EXPAND_MS above.
  // prefers-reduced-motion: transitions are dropped entirely (jump-cut),
  // same treatment FlipCard/RecordingBeads give motion elsewhere in the app.
  const sidebarMs = sidebarCollapsed ? SIDEBAR_COLLAPSE_MS : SIDEBAR_EXPAND_MS;
  const sidebarWidthTransition = prefersReducedMotion
    ? 'none'
    : `width ${sidebarMs}ms var(--ls-easing)`;
  const sidebarInnerTransition = prefersReducedMotion
    ? 'none'
    : `transform ${sidebarMs}ms var(--ls-easing), opacity ${SIDEBAR_FADE_MS}ms var(--ls-easing)`;
  const contentMaxWidthTransition = prefersReducedMotion
    ? 'none'
    : `max-width ${sidebarMs}ms var(--ls-easing)`;

  // 阅读留白案 — 实机反馈: "主课文部分距离左边栏、Live Teaching 距离右边栏其实都
  //还有余量……当我把左边栏收起来后，课文和 Live Teaching 也只是移动到了全
  // 屏画面的中间，内容并没有被放大，宽度也没有释放". The global 880px column
  // was sized for single-column prose pages; Lesson's self-study + live
  // panel layout wants real room. Only the Lesson detail route widens —
  // every other route keeps the original reading-width column untouched.
  const isLessonRoute = /^\/courses\/[^/]+\/lessons\/[^/]+/.test(location.pathname);
  // 批G: the reader route (not the /documents list) also widens a touch —
  // its H2/H3 sidebar TOC needs room
  // beside the prose column the same way Lesson's live panel does, just
  // less of it (no classroom split to make space for).
  const isDocumentReaderRoute = /^\/documents\/[^/]+/.test(location.pathname);
  // 批D 曾在这里给 Journal (/sessions) 单独放宽到 1080–1180px, 给时间线 +
  // "我的笔记"侧栏的双列布局腾地方。批F: 笔记区搬进 NotesDrawer (右缘抽屉,
  // 覆盖在内容之上, 不占正文行内的宽度) 之后, Journal 页回归"满宽纯传记"
  // (journal/JournalPage.tsx), 不再需要比其他纯文本页更宽的读版——这条
  // 特例连同它服务的双列布局一起撤掉, Journal 现在跟其余非 Lesson 路由一样
  // 吃默认的 880px 读版宽度。
  const contentMaxWidth = isLessonRoute
    ? sidebarCollapsed
      ? '1400px'
      : '1280px'
    : isDocumentReaderRoute
      ? '1040px'
      : '880px';

  // Persist sidebar collapsed state.
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [sidebarCollapsed]);

  // `\` toggles sidebar (escapes form inputs via enableOnFormTags: false default).
  useHotkeys('\\', () => setSidebarCollapsed((v) => !v));

  return (
    <PairProvider>
      <Shortcuts
        onTogglePalette={() => setPaletteOpen((o) => !o)}
        onTogglePool={() => setPoolOpen((o) => !o)}
        onToggleNotes={() => setNotesOpen((o) => !o)}
      />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <PoolDrawer open={poolOpen} onClose={() => setPoolOpen(false)} />
      <NotesDrawer open={notesOpen} onClose={() => setNotesOpen(false)} />

      <div className="flex h-screen bg-[var(--ls-bg)] text-[var(--ls-text)]">
        {/* ============== Sidebar ============== */}
        {/* Outer = layout slot that animates width 230→0 to make room.
            Inner = fixed 230 wide content that translates left in sync
            (same direction-aware duration as the outer width, so the two
            never drift apart mid-transition) plus a faster opacity fade,
            so the text is already gone before the overflow-hidden edge
            would otherwise crop it mid-glyph. Sidebar appears to slide out
            while main column smoothly takes the released space, without
            re-flowing the sidebar's own text. */}
        <aside
          className="flex-none overflow-hidden bg-[var(--ls-bg)] will-change-[width]"
          style={{ width: sidebarCollapsed ? '0px' : '230px', transition: sidebarWidthTransition }}
          aria-hidden={sidebarCollapsed}
        >
          <div
            className="border-r border-[var(--ls-border)] flex flex-col h-full will-change-transform"
            style={{
              width: '230px',
              padding: '16px 12px',
              transform: sidebarCollapsed ? 'translateX(-230px)' : 'translateX(0)',
              opacity: sidebarCollapsed ? 0 : 1,
              transition: sidebarInnerTransition,
            }}
          >
            {/* Logo */}
            <div className="flex items-center gap-[9px]" style={{ padding: '4px 8px 18px' }}>
              <LearnShellLogo reduceMotion={prefersReducedMotion} />
              <span className="font-semibold text-[14px] leading-[18px] tracking-[-0.01em]">
                {t('app.name')}
              </span>
            </div>

            {/* Main nav */}
            <div className="flex flex-col gap-[2px]">
              {NAV_KEYS.map((n) => (
                <NavItem key={n.to} to={n.to} label={t(n.key)} kbd={n.kbd} />
              ))}
            </div>

            {/* Recent — Recent 栏替换案, replaces Concepts */}
            <RecentRail onOpenPool={() => setPoolOpen(true)} onOpenNotes={() => setNotesOpen(true)} />

            {/* Settings + self-host status */}
            <div
              className="mt-auto flex flex-col gap-2 border-t border-[var(--ls-border)]"
              style={{ padding: '14px 4px 4px' }}
            >
              <NavItem
                to={SETTINGS_NAV.to}
                label={t(SETTINGS_NAV.key)}
                kbd={SETTINGS_NAV.kbd}
              />
              <div className="flex items-center gap-2 px-2.5 text-[11px] leading-4 text-[var(--ls-text-secondary)]">
                <span
                  className="w-[7px] h-[7px] rounded-full flex-none"
                  style={{ background: 'var(--ls-corroborated)' }}
                />
                <span>Self-host · v0.1</span>
              </div>
            </div>
          </div>
        </aside>

        {/* ============== Main column ============== */}
        <main className="flex-1 min-w-0 flex flex-col bg-[var(--ls-bg)]">
          <PairHeader
            onOpenPalette={() => setPaletteOpen(true)}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          />

          <div
            className="flex-1 overflow-y-auto"
            style={{ padding: '36px 40px 64px' }}
          >
            <div
              className="mx-auto"
              style={{ maxWidth: contentMaxWidth, transition: contentMaxWidthTransition }}
            >
              <OutletOrFirstRun />
            </div>
          </div>
        </main>
      </div>

      {/* Stage 7e: AdHoc floating panel — global, follows route */}
      <FloatingAskAgent />
    </PairProvider>
  );
}

/* -------------------------------------------------------------------------- */

// 焊缝修复: 首跑页的"先逛逛样板间"旁路标记 —— 只活一个浏览器会话
// (sessionStorage, 不是 localStorage): 关标签页/重开就该回到首跑页重新
// 判定, 不该把"逛过一次"记成永久放行。
const FIRST_RUN_DEMO_BYPASS_KEY = 'learn-shell:first-run-demo-bypass';

function readDemoBypass(): boolean {
  try {
    return sessionStorage.getItem(FIRST_RUN_DEMO_BYPASS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * OutletOrFirstRun — 首跑入学的挂载点。live 模式下确认"没有真 pair"
 * 时 (PairProvider.pairMissing, 焊缝修复后样板间不算数), 任何路由的正文都
 * 只是空库噪音 — 整个主栏让位给首跑页 (等你的 agent 来敲门 + 名字主权
 * 仪式)。侧栏/页眉/⌘K 保持原样 (模式切换、设置入口不被首跑页劫走)。pair
 * 出生后 PairProvider 的轻轮询自动翻回 false, Outlet 恢复, 无需刷新。必须
 * 是 PairProvider 的子组件才能读 usePair — 所以是这个小包装, 不是 AppShell
 * 顶层的分支。
 *
 * 焊缝修复续: 库里只有样板间时首跑页会一直挡着 (符合设计——样板间不算
 * 入学), 但学习者应该能先逛逛样板间再决定要不要接 agent。首跑页底部的
 * "先逛逛样板间"链接点一下就在本会话内放行 Outlet, 标记存 sessionStorage
 * (放行只活当前会话); 真 pair 出生 (pairMissing 翻 false) 后清掉标记, 免
 * 得万一之后又回到"只剩样板间"的状态时沿用一份过期的放行。
 */
function OutletOrFirstRun() {
  const { pairMissing, demoAvailable } = usePair();
  const [demoBypass, setDemoBypass] = useState<boolean>(() => readDemoBypass());

  useEffect(() => {
    if (!pairMissing && demoBypass) {
      try {
        sessionStorage.removeItem(FIRST_RUN_DEMO_BYPASS_KEY);
      } catch {
        /* ignore */
      }
      setDemoBypass(false);
    }
  }, [pairMissing, demoBypass]);

  const enterDemo = () => {
    try {
      sessionStorage.setItem(FIRST_RUN_DEMO_BYPASS_KEY, '1');
    } catch {
      /* ignore */
    }
    setDemoBypass(true);
  };

  if (pairMissing && !demoBypass) {
    return <FirstRun demoAvailable={demoAvailable} onEnterDemo={enterDemo} />;
  }
  return <Outlet />;
}

// 硬编码字符串诊断 diagnosis — the "CFA · Week 2" strings here used to be plain
// hardcoded JSX text (a leftover from the original design mockup), never
// wired to any contract/course query at all. That's why it "followed the
// wrong course": it didn't follow *any* course — it was static. There was
// no "picks the first/oldest contract" bug to fix; the fix is to actually
// resolve subject + week from whichever contract the current context
// implies (see PairHeader below). The other half of 硬编码字符串诊断 ("CONCEPTS 侧栏
// 跟错课") is moot — that sidebar was removed entirely in Recent 栏替换案 (ConceptsRail
// → RecentRail), which carries no per-course concept data at all anymore.
//
// "Week N" is a real derived value (elapsed weeks since the resolved
// contract's time_range.start), not a fabricated counter — same field the
// design's "Week 2" was presumably always meant to read from.
function contractWeekLabel(contract: TeachingContract | null | undefined): string | null {
  const start = contract?.time_range?.start;
  if (!start) return null;
  const startMs = new Date(start).getTime();
  if (Number.isNaN(startMs)) return null;
  const weeksElapsed = Math.floor(Math.max(0, Date.now() - startMs) / (7 * 86_400_000));
  return `Week ${weeksElapsed + 1}`;
}

function PairHeader({
  onOpenPalette,
  sidebarCollapsed,
  onToggleSidebar,
}: {
  onOpenPalette: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}) {
  useRepositoryState();
  const mode = getRepositoryMode();
  const repo = useRepository();
  const { pairId, pairLearnerDisplayName, pairAgentDisplayName } = usePair();
  const location = useLocation();
  const { t } = useT();
  // 顶栏名称数据驱动化: 顶栏 pair 名称数据驱动化 — 优先级链见 lib/pairDisplay.ts 顶部
  // 注释。placeholder 复用证书区块既有的 studentFallback/teacherFallback
  // 措辞（"学习者"/"Agent"），不新造一份几乎一样的字典键。
  const { identity } = useIdentity();
  const pairDisplay = resolvePairDisplayName(
    { identity, pairLearnerDisplayName, pairAgentDisplayName },
    {
      learner: t('settings.certificate.studentFallback'),
      agent: t('settings.certificate.teacherFallback'),
    }
  );
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  // Lesson-page context: course id comes straight off the URL — no need to
  // fetch the lesson first. Everywhere else (Quiz/Journal/Cards/...), fall
  // back to the pair's single active contract (existing getActiveContract
  // semantics) — a neutral pair-level default, never a *wrong* course's.
  const lessonMatch = location.pathname.match(/^\/courses\/([^/]+)\/lessons\//);
  const currentCourseId = lessonMatch?.[1] as CourseId | undefined;

  const scopedContractsQ = useQuery({
    queryKey: ['pair-header', 'contracts', pairId],
    queryFn: () => (repo && pairId ? repo.getAllContracts(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId && !!currentCourseId,
  });
  const activeContractQ = useQuery({
    queryKey: ['pair-header', 'active-contract', pairId],
    queryFn: () => (repo && pairId ? repo.getActiveContract(pairId) : Promise.resolve(null)),
    enabled: !!repo && !!pairId && !currentCourseId,
  });
  const contract = currentCourseId
    ? (scopedContractsQ.data ?? []).find((c) => c.course_id === currentCourseId)
    : (activeContractQ.data ?? undefined);

  const effectiveCourseId = currentCourseId ?? (contract?.course_id as CourseId | undefined);
  const courseQ = useQuery({
    queryKey: ['pair-header', 'course', effectiveCourseId],
    queryFn: () =>
      repo && effectiveCourseId ? repo.getCourse(effectiveCourseId) : Promise.resolve(null),
    enabled: !!repo && !!effectiveCourseId,
  });
  const subjectLabel = courseQ.data?.topic;
  const weekLabel = contractWeekLabel(contract);

  // 证书化 (2026-07-08): 待签之约的顶栏轻提示 — Contract 页的常驻 nav 入口
  // 死了之后，"有一份合同等你签字"这件事不能没处说。同 RecentRail 的
  // "待签之约"行共享 ['contracts', pairId] 缓存键 (不重复拉取)，取最早
  // 那份 proposed 合同 (先到先签)。小圆点 + chip，不弹窗——出现即可点，
  // 没有待签合同时这一块完全不渲染 (不是灰态占位)。
  const allContractsQ = useQuery({
    queryKey: ['contracts', pairId],
    queryFn: () => (repo && pairId ? repo.getAllContracts(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });
  const pendingContract = (allContractsQ.data ?? [])
    .filter((c) => c.setup_status === 'proposed')
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))[0];

  // DEMO/EMPTY/LIVE badge — read-only signal that mirrors the current data mode.
  // Mode switching itself lives in ⌘K palette (per design's IA).
  const modeBadge =
    mode === 'seeded'
      ? { label: 'DEMO', color: 'var(--ls-hypothesis)' }
      : mode === 'live'
        ? { label: 'LIVE', color: 'var(--ls-corroborated)' }
        : { label: 'EMPTY', color: 'var(--ls-text-tertiary)' };

  return (
    <header
      className="h-12 flex-none border-b border-[var(--ls-border)] flex items-center bg-[var(--ls-bg)]"
      style={{ padding: '0 18px 0 14px', gap: '12px' }}
    >
      <button
        type="button"
        onClick={onToggleSidebar}
        className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-md text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)] hover:bg-[var(--ls-panel)] text-[16px] flex-none transition-colors duration-[var(--ls-duration-fast)]"
        title={`${sidebarCollapsed ? t('appShell.showSidebar') : t('appShell.hideSidebar')} (\\)`}
        aria-label={sidebarCollapsed ? t('appShell.showSidebar') : t('appShell.hideSidebar')}
      >
        ☰
      </button>

      <div
        className="flex items-center min-w-0 overflow-hidden whitespace-nowrap"
        style={{ gap: '12px' }}
      >
        <span className="text-[13px] font-medium leading-5">
          {pairDisplay.learner} <span style={{ color: 'var(--ls-text-tertiary)' }}>×</span>{' '}
          {pairDisplay.agent}
        </span>
        {subjectLabel && (
          <>
            <span style={{ color: 'var(--ls-border-strong)' }} aria-hidden>
              ·
            </span>
            <span className="text-[13px] leading-5 text-[var(--ls-text-secondary)]">
              {subjectLabel}
            </span>
          </>
        )}
        {weekLabel && (
          <>
            <span style={{ color: 'var(--ls-border-strong)' }} aria-hidden>
              ·
            </span>
            <span className="text-[13px] leading-5 text-[var(--ls-text-secondary)]">
              {weekLabel}
            </span>
          </>
        )}

        {pendingContract && (
          <NavLink
            to={`/contract/${pendingContract.id}`}
            className="inline-flex items-center gap-1.5 px-2.5 py-[3px] border rounded-full text-[11px] leading-[14px] flex-none hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
            style={{ borderColor: 'var(--ls-hypothesis)', color: 'var(--ls-hypothesis)' }}
            title={t('header.pendingContract.hint')}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: 'var(--ls-hypothesis)' }}
            />
            {t('contract.awaitingSignature')}
          </NavLink>
        )}

        <span
          className="px-1.5 py-[2px] border rounded-[4px] text-[10px] leading-[14px] tracking-[0.06em] flex-none cursor-default"
          style={{ borderColor: modeBadge.color, color: modeBadge.color }}
          title={`${t('appShell.dataModePrefix')}${mode}${t('appShell.dataModeSuffix')}`}
        >
          {modeBadge.label}
        </span>
      </div>

      <div className="ml-auto flex items-center flex-none" style={{ gap: '14px' }}>
        <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)] tracking-[0.02em] tabular-nums">
          {today}
        </span>
        <button
          onClick={onOpenPalette}
          className="flex items-center gap-1.5 px-2.5 py-[5px] border border-[var(--ls-border)] rounded-md text-[var(--ls-text-tertiary)] hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
          title={t('appShell.openCommandPalette')}
        >
          <span className="text-[12px] leading-4">{t('appShell.search')}</span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>
    </header>
  );
}

function NavItem({
  to,
  label,
  kbd,
}: {
  to: string;
  label: string;
  kbd: string;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center justify-between gap-2.5 px-2.5 py-[7px]
         rounded-[var(--ls-radius-control)]
         text-[13px] font-medium leading-5
         transition-colors duration-[var(--ls-duration-fast)]
         ${
           isActive
             ? 'bg-[var(--ls-panel)] text-[var(--ls-text)]'
             : 'text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)]'
         }`
      }
    >
      <span>{label}</span>
      <Kbd>{kbd}</Kbd>
    </NavLink>
  );
}

/**
 * Learn Shell 正式标 (2026-07-22 定稿; 2026-07-24 hover geometry)。
 *
 * 静止时, 3×3×3 的 27 粒沿体对角线重合成原稿的 19 个等距格位; 每粒继承
 * 所在格位的 ink / tertiary 身份, 所以 0° 的形、色、点径仍逐字等于原稿。
 * hover 时只做一件事: 立方体绕自己的 y 轴向右转。每帧用同一份三维坐标
 * 同时重算投影和固定右上前光源下的亮度——没有 rotateZ、笔顺或独立灯效。
 *
 * 有限透视无法天然保持原稿那 7 组严格重合点, 因而采用“原稿静止锚点 +
 * pinhole 投影位移差”: Sθ = B + Π(Rθp) - Π(p)。θ=0 时位移严格为零;
 * 一旦转动, 近点位移自然大于远点, 而不是用逐点手调伪造视差。
 */
type LogoVec3 = readonly [number, number, number];
type LogoVec2 = readonly [number, number];

type LogoParticle = {
  id: string;
  point: LogoVec3;
  restCx: number;
  restCy: number;
  restProjection: LogoVec2;
  restLight: number;
  lit: boolean;
  depth: number;
  cell: string;
  restOccluded: boolean;
};

const LOGO_TARGET_YAW_DEG = 18;
const LOGO_ENTER_MS = 400;
const LOGO_RETURN_MS = 400;
const LOGO_GRID_STEP = 4.5;
const LOGO_PROJECT_SCALE = LOGO_GRID_STEP * Math.sqrt(3 / 2);
const LOGO_FOCAL_DISTANCE = 8;
const LOGO_LIGHT_RESPONSE = 0.68;
const LOGO_MIN_BRIGHTNESS = 0.82;
const LOGO_MAX_BRIGHTNESS = 1.0; // 她裁 7/24：封顶静止亮度，只许背光变暗，永无高光点

const LOGO_RIGHT: LogoVec3 = [1 / Math.sqrt(2), 0, -1 / Math.sqrt(2)];
const LOGO_UP: LogoVec3 = [-1 / Math.sqrt(6), 2 / Math.sqrt(6), -1 / Math.sqrt(6)];
const LOGO_FRONT: LogoVec3 = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];

function logoDot(a: LogoVec3, b: LogoVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalizeLogoVector(v: LogoVec3): LogoVec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

// Fixed right / up / front light. Its position never animates; only the cube
// turns underneath it. The vertical weight follows the brief's quiet top light,
// while the right/front terms make yaw legible at 20px.
const LOGO_LIGHT = normalizeLogoVector([
  0.55 * LOGO_RIGHT[0] + 0.7 * LOGO_UP[0] + 0.45 * LOGO_FRONT[0],
  0.55 * LOGO_RIGHT[1] + 0.7 * LOGO_UP[1] + 0.45 * LOGO_FRONT[1],
  0.55 * LOGO_RIGHT[2] + 0.7 * LOGO_UP[2] + 0.45 * LOGO_FRONT[2],
]);

const LOGO_REST_X: Record<number, number> = {
  [-2]: 2.21,
  [-1]: 6.1,
  0: 10,
  1: 13.9,
  2: 17.79,
};

// L + S, written once across the 19 projected cells. Every 3D particle at a
// shared cell inherits the same identity, so overlap cannot change its color.
const LOGO_LIT_CELLS = new Set([
  '0,-4',
  '-1,-3',
  '-2,-2',
  '2,-2',
  '-1,-1',
  '1,-1',
  '0,0',
  '2,0',
  '2,2',
  '1,3',
  '0,4',
]);

function projectLogoPoint(point: LogoVec3): LogoVec2 {
  const depth = logoDot(point, LOGO_FRONT);
  const perspective = LOGO_FOCAL_DISTANCE / (LOGO_FOCAL_DISTANCE - depth);
  return [
    LOGO_PROJECT_SCALE * logoDot(point, LOGO_RIGHT) * perspective,
    -LOGO_PROJECT_SCALE * logoDot(point, LOGO_UP) * perspective,
  ];
}

function rotateLogoPoint(point: LogoVec3, yawRad: number): LogoVec3 {
  const [x, y, z] = point;
  const cos = Math.cos(yawRad);
  const sin = Math.sin(yawRad);
  return [x * cos + z * sin, y, -x * sin + z * cos];
}

const LOGO_PARTICLES: LogoParticle[] = (() => {
  const particles: LogoParticle[] = [];
  for (let x = -1; x <= 1; x += 1) {
    for (let y = -1; y <= 1; y += 1) {
      for (let z = -1; z <= 1; z += 1) {
        const point: LogoVec3 = [x, y, z];
        const q = x - z;
        const r = x + z - 2 * y;
        const cell = `${q},${r}`;
        particles.push({
          id: `${x}:${y}:${z}`,
          point,
          restCx: LOGO_REST_X[q]!,
          restCy: 10 + 2.25 * r,
          restProjection: projectLogoPoint(point),
          restLight: logoDot(point, LOGO_LIGHT),
          lit: LOGO_LIT_CELLS.has(cell),
          depth: x + y + z,
          cell,
          restOccluded: false,
        });
      }
    }
  }
  const frontDepthByCell = new Map<string, number>();
  particles.forEach((particle) => {
    frontDepthByCell.set(
      particle.cell,
      Math.max(frontDepthByCell.get(particle.cell) ?? -Infinity, particle.depth)
    );
  });
  particles.forEach((particle) => {
    // Along a resting sight-line, only the nearest opaque sphere is visible.
    // Hidden particles fade in only as yaw physically separates them; this
    // avoids repeated anti-alias coverage changing the exact 19-dot rest mark.
    particle.restOccluded = particle.depth < frontDepthByCell.get(particle.cell)!;
  });
  // 她裁 7/24：只保留静止可见的 19 粒——被投影重合遮住的 8 粒在 20px 下
  // 是噪声不是纵深；主视差由 19 粒的差异位移承担，盒子视为实心。
  const visible = particles.filter((particle) => !particle.restOccluded);
  // Stable far → near painter's order. The 18° travel is too small to invert
  // layers, so no DOM reorder is needed inside the animation frame.
  return visible.sort(
    (a, b) =>
      a.depth - b.depth ||
      a.point[0] - b.point[0] ||
      a.point[1] - b.point[1] ||
      a.point[2] - b.point[2]
  );
})();

function supportsFineHover(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches
  );
}

function LearnShellLogo({ reduceMotion }: { reduceMotion: boolean }) {
  const [reducedHover, setReducedHover] = useState(false);
  const circleRefs = useRef<Array<SVGCircleElement | null>>([]);
  const animationFrameRef = useRef<number | null>(null);
  const yawRef = useRef(0);

  const cancelAnimation = () => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  };

  const drawYaw = (yawDeg: number) => {
    yawRef.current = yawDeg;
    const atRest = Math.abs(yawDeg) < 0.0001;
    const yawRad = (yawDeg * Math.PI) / 180;

    LOGO_PARTICLES.forEach((particle, index) => {
      const circle = circleRefs.current[index];
      if (!circle) return;
      if (atRest) {
        // Removing both properties, rather than writing identity values, keeps
        // the resting compositor path exactly the same as the static original.
        circle.removeAttribute('transform');
        circle.style.removeProperty('filter');
        return;
      }

      const rotated = rotateLogoPoint(particle.point, yawRad);
      const projected = projectLogoPoint(rotated);
      const dx = projected[0] - particle.restProjection[0];
      const dy = projected[1] - particle.restProjection[1];
      circle.setAttribute('transform', `translate(${dx.toFixed(4)} ${dy.toFixed(4)})`);

      // Relative calibration makes every particle exactly 1.0 at rest, while
      // preserving a single fixed light model throughout the turn.
      const lightDelta = logoDot(rotated, LOGO_LIGHT) - particle.restLight;
      const brightness = Math.min(
        LOGO_MAX_BRIGHTNESS,
        Math.max(LOGO_MIN_BRIGHTNESS, Math.exp(LOGO_LIGHT_RESPONSE * lightDelta))
      );
      circle.style.filter = `brightness(${brightness.toFixed(4)})`;

    });
  };

  const animateIn = () => {
    cancelAnimation();
    const fromYaw = yawRef.current;
    const startedAt = performance.now();
    const frame = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / LOGO_ENTER_MS);
      const easeOut = 1 - (1 - progress) ** 3;
      drawYaw(fromYaw + (LOGO_TARGET_YAW_DEG - fromYaw) * easeOut);
      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(frame);
      } else {
        animationFrameRef.current = null;
      }
    };
    animationFrameRef.current = requestAnimationFrame(frame);
  };

  const animateHome = () => {
    cancelAnimation();
    const fromYaw = yawRef.current;
    if (Math.abs(fromYaw) < 0.0001) {
      drawYaw(0);
      return;
    }

    const startedAt = performance.now();
    const dampingRatio = 0.8;
    const naturalFrequency = 20;
    const dampedFrequency = naturalFrequency * Math.sqrt(1 - dampingRatio ** 2);
    const phaseWeight = dampingRatio / Math.sqrt(1 - dampingRatio ** 2);
    const frame = (now: number) => {
      const elapsedMs = now - startedAt;
      const t = elapsedMs / 1000;
      // ζ=.8 yields one ≈1.5% overshoot; ω₀=20 settles inside 400ms.
      const spring =
        Math.exp(-dampingRatio * naturalFrequency * t) *
        (Math.cos(dampedFrequency * t) + phaseWeight * Math.sin(dampedFrequency * t));
      drawYaw(fromYaw * spring);
      if (elapsedMs < LOGO_RETURN_MS) {
        animationFrameRef.current = requestAnimationFrame(frame);
      } else {
        drawYaw(0);
        animationFrameRef.current = null;
      }
    };
    animationFrameRef.current = requestAnimationFrame(frame);
  };

  const handlePointerEnter = (event: ReactPointerEvent<SVGSVGElement>) => {
    // Read the capability at interaction time. Some embedded browsers publish
    // their pointer media features after first paint; a mount-time snapshot can
    // therefore be stale. Touch (including synthesized mouse hover on a
    // hover:none device) remains inert.
    if (event.pointerType === 'touch' || !supportsFineHover()) return;
    if (reduceMotion) {
      setReducedHover(true);
      return;
    }
    animateIn();
  };

  const handlePointerLeave = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType === 'touch') return;
    if (reduceMotion) {
      setReducedHover(false);
      return;
    }
    animateHome();
  };

  useEffect(() => {
    if (!reduceMotion) return;
    cancelAnimation();
    drawYaw(0);
    // These functions only close over stable refs/constants; rerunning for
    // every render would interrupt an in-flight animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  useEffect(
    () => () => {
      cancelAnimation();
    },
    []
  );

  const ink = 'var(--ls-text)';
  const dim = 'var(--ls-text-tertiary)';

  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      className="flex-none"
      aria-label="Learn Shell"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerLeave}
      style={{
        filter: reduceMotion && reducedHover ? 'brightness(1.05)' : undefined,
        transition: reduceMotion ? 'filter 150ms ease-out' : undefined,
      }}
    >
      {/* Keep the full 20px mark easy to hover without changing one pixel. */}
      <rect width="20" height="20" fill="transparent" aria-hidden="true" />
      {LOGO_PARTICLES.map((particle, index) => (
        <circle
          key={particle.id}
          ref={(node) => {
            circleRefs.current[index] = node;
          }}
          cx={particle.restCx}
          cy={particle.restCy}
          r={0.47}
          fill={particle.lit ? ink : dim}
          opacity={particle.restOccluded ? 0 : undefined}
        />
      ))}
    </svg>
  );
}
