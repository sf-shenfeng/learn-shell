// NotesDrawer — "我的笔记" 抽屉 (批F, 7/7 深夜验收: 批E 把它做成了寄生在
// Journal 排版里的无界滚动侧栏/顶部抽屉——收起时左边冒出可点条、Journal 主列
// 却不回弹，架构错位。拍板重构：笔记区抽屉化，与 Pending Pool 完全同级同
// 逻辑 — apps/web/src/pool/PoolDrawer.tsx 是唯一样板。
//
//   - 实现模式/时长常量/开合手感/Esc/遮罩行为逐项照抄 PoolDrawer：右缘滑出，
//     backdrop opacity + panel translateX，同一对 DRAWER_COLLAPSE_MS(200) /
//     DRAWER_EXPAND_MS(240，收起快于展开的"方向感"手感，两处是同一套系统)，
//     Esc 监听同款 input/textarea/contentEditable 守卫，prefers-reduced-motion
//     同款跳切处理。宽度也照抄 Pool 的 `min(440px, 92vw)` — 内容本就是简单的
//     纵向卡片流，没有理由另起一个尺寸。
//   - 数据获取不再由 JournalPage 代管——批E item 0 那次"面板要不要占位/时间线
//     该不该收窄"的布局决策，连同它所服务的双列布局一起，在批F 里整个消失了。
//     现在这个组件自己调用 useJournalNotes()（PoolDrawer 自己调 getPendingCards
//     同一个道理），与 RecentRail 的笔记行各自独立调用、共享同一批 React
//     Query key（['journal-courses',...] 等），互不重复请求。
//   - 抽屉"内脏"（NoteCard 操作集/五色分组/色点筛选/排序/搜索/自由笔记/
//     孤儿区）是批D/批E 原样搬运——PanelBody 往下的所有子组件、其注释、其
//     行为，只字未改，只是从 JournalNotesPanel.tsx 的两种壳（WideSidebar 的
//     40px 收纳 rail + NarrowDrawer 的顶部折叠段，连同它们各自的 localStorage
//     / useNarrowViewport 依赖）搬进这具新壳。旧壳与 useNarrowViewport.ts 一并
//     删除；批E 遗留的 `learn-shell:journal:notes-panel-collapsed` key 随之
//     作废（没有代码再读写它）。
//   - 跳转原文/重挂 两个深链 Link 现在都会先关抽屉再跳转——同 Pool 的
//     RowLinkButton 惯例 (onNavigate)，这里就是 NotesDrawer 自己的 onClose，
//     一路 prop-drill 到 NoteCard（跟 pairId/pooledIds/deckOptions 走的是
//     同一条既有drilling路径，不是新发明一条）。

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Flashcard, PairId } from '@learn-shell/contracts';
import { useT } from '../i18n';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';
import { usePrefersReducedMotion } from '../shell/FlipCard';
import Kbd from '../shell/Kbd';
import { isOrphaned } from '../annotation/orphan';
import { ANNOTATION_COLORS, annotationColorHex } from '../annotation/palette';
import {
  useJournalNotes,
  useJournalRepo,
  buildLessonPageLink,
  buildLessonLiveLink,
  buildDocumentLink,
  type JournalNoteEntry,
  type JournalNotesData,
} from './useJournalNotes';
import {
  filterEntries,
  groupByColor,
  groupByCourse,
  sortByTime,
  type SortMode,
  type JournalColorGroup,
  type JournalCourseGroup,
} from './noteGrouping';
import { formatNoteDate } from './format';

// Same split as PoolDrawer.tsx DRAWER_COLLAPSE_MS/DRAWER_EXPAND_MS (which
// itself mirrors AppShell's sidebar) — collapsing a beat quicker than
// expanding is the house feel, reused verbatim, not re-tuned for this drawer.
const DRAWER_COLLAPSE_MS = 200; // closing
const DRAWER_EXPAND_MS = 240; // opening

const TITLE_MAX = 60;
const NEW_DECK_SENTINEL = '__new_deck__';

function truncate(s: string, n: number): string {
  const trimmed = s.trim();
  return trimmed.length > n ? `${trimmed.slice(0, n).trimEnd()}…` : trimmed;
}

export default function NotesDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useT();
  const repo = useRepository();
  const prefersReducedMotion = usePrefersReducedMotion();
  const notesData = useJournalNotes();

  const drawerMs = open ? DRAWER_EXPAND_MS : DRAWER_COLLAPSE_MS;
  const backdropTransition = prefersReducedMotion
    ? 'none'
    : `opacity ${drawerMs}ms var(--ls-easing)`;
  const panelTransition = prefersReducedMotion
    ? 'none'
    : `transform ${drawerMs}ms var(--ls-easing)`;

  // Esc closes — identical guard to PoolDrawer's: only listens while open,
  // no-ops when focus is in a form control, so it composes independently
  // with Focus mode's / Mindmap's / annotation's own Escape handling.
  useEffect(() => {
    if (!open) return;
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
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const totalCount = notesData.entries.length + notesData.orphans.length;

  return (
    <>
      {/* =================== Backdrop =================== */}
      <div
        onClick={onClose}
        aria-hidden={!open}
        className="fixed inset-0"
        style={{
          zIndex: 50,
          background: 'rgba(0,0,0,0.3)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: backdropTransition,
        }}
      />

      {/* =================== Panel =================== */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('journal.notes.title')}
        aria-hidden={!open}
        className="fixed top-0 right-0 bottom-0 flex flex-col bg-[var(--ls-bg)]"
        style={{
          zIndex: 50,
          width: 'min(440px, 92vw)',
          borderLeft: '1px solid var(--ls-border)',
          boxShadow: '-24px 0 56px -12px rgba(0,0,0,0.25)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: panelTransition,
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        {/* Header — same kbd-hint dialect as PoolDrawer's (卡池常驻行案's G P
            chip), G N here. */}
        <div
          className="flex-none flex items-start justify-between"
          style={{ padding: '20px 20px 14px' }}
        >
          <div>
            <div className="flex items-baseline" style={{ gap: '8px' }}>
              <h1
                className="font-bold"
                style={{
                  margin: 0,
                  fontSize: '20px',
                  lineHeight: '28px',
                  letterSpacing: '-0.02em',
                }}
              >
                {t('journal.notes.title')}
              </h1>
              <Kbd>G N</Kbd>
            </div>
            <div
              className="text-[var(--ls-text-tertiary)]"
              style={{ fontSize: '13px', lineHeight: '20px', marginTop: '2px' }}
            >
              {totalCount === 0
                ? t('journal.notes.waystation')
                : `${totalCount}${t('journal.notes.countSuffix')}`}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('journal.notes.closeAriaLabel')}
            title={t('journal.notes.closeTitle')}
            className="flex-none text-[16px] text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)] leading-none w-7 h-7 flex items-center justify-center rounded-md hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto" style={{ padding: '0 20px 20px' }}>
          {!repo ? (
            <p className="text-sm text-[var(--ls-text-secondary)]">
              Empty mode · no notes yet.
            </p>
          ) : (
            <>
              {notesData.isLoading && (
                <p className="text-sm text-[var(--ls-text-tertiary)]">Loading…</p>
              )}
              {!notesData.isLoading && !notesData.hasContent && (
                <div
                  className="text-center text-[var(--ls-text-tertiary)]"
                  style={{
                    border: '1px solid var(--ls-border)',
                    borderRadius: '8px',
                    padding: '40px 16px',
                    fontSize: '13px',
                    lineHeight: '20px',
                  }}
                >
                  {t('journal.notes.emptyState')}
                </div>
              )}
              {!notesData.isLoading && notesData.hasContent && (
                <PanelBody data={notesData} onNavigate={onClose} />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ============================================================================
// 以下: 批D/批E 原班内容，只搬家不改动（除了新加的 onNavigate 一路下钻，见
// 文件头注释）。
// ============================================================================

function PanelBody({ data, onNavigate }: { data: JournalNotesData; onNavigate: () => void }) {
  const { t } = useT();
  const repo = useRepository();
  const { pairId } = usePair();

  const [sortMode, setSortMode] = useState<SortMode>('color');
  const [activeColors, setActiveColors] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  // Lifted once for every row in the panel (rather than one query per
  // NoteCard) — same ['pending-cards', pairId] / ['flashcards-all', pairId]
  // keys AnnotationOverlay/PoolDrawer/Cards already share, so this doesn't
  // cost a new fetch either.
  const pendingQ = useQuery({
    queryKey: ['pending-cards', pairId],
    queryFn: () => (repo && pairId ? repo.getPendingCards(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });
  const pooledIds = useMemo(
    () =>
      new Set(
        (pendingQ.data ?? [])
          .filter((p) => p.source_type === 'annotation')
          .map((p) => p.source_id ?? '')
      ),
    [pendingQ.data]
  );

  const flashcardsQ = useQuery({
    queryKey: ['flashcards-all', pairId],
    queryFn: () => (repo && pairId ? repo.getAllFlashcards(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });
  const deckOptions = useMemo(
    () => Array.from(new Set((flashcardsQ.data ?? []).map((c) => c.deck_id as unknown as string))).sort(),
    [flashcardsQ.data]
  );

  const toggleColor = (key: string) => {
    setActiveColors((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Item 5's dots need to stay visible (and clickable) for every color that
  // has *any* matching note, regardless of which colors are currently
  // active — so the color grouping itself is only search-filtered; the
  // active-color set instead decides which groups' note lists render
  // (still "与分组共存": the dot/count never disappears, only the list
  // beneath collapses). Course/time views have no per-item dot affordance,
  // so they apply the color filter directly.
  const searchFiltered = useMemo(
    () => filterEntries(data.entries, { search, colors: new Set() }),
    [data.entries, search]
  );
  const fullyFiltered = useMemo(
    () => filterEntries(data.entries, { search, colors: activeColors }),
    [data.entries, search, activeColors]
  );
  const filteredOrphans = useMemo(
    () => filterEntries(data.orphans, { search, colors: activeColors }),
    [data.orphans, search, activeColors]
  );

  const colorGroups = useMemo(() => groupByColor(searchFiltered), [searchFiltered]);
  const courseGroups = useMemo(
    () => groupByCourse(fullyFiltered, t('journal.notes.freeNoteLabel')),
    [fullyFiltered, t]
  );
  const timeSorted = useMemo(
    () => sortByTime(fullyFiltered, sortMode === 'time-asc' ? 'asc' : 'desc'),
    [fullyFiltered, sortMode]
  );

  const nothingToShow =
    (sortMode === 'color' ? colorGroups.length === 0 : fullyFiltered.length === 0) &&
    filteredOrphans.length === 0;

  return (
    <div className="flex flex-col" style={{ gap: '14px' }}>
      <AddNoteControl open={addOpen} onOpenChange={setAddOpen} />

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t('journal.notes.searchPlaceholder')}
        className="w-full bg-[var(--ls-bg)] text-[var(--ls-text)] border border-[var(--ls-border)] placeholder:text-[var(--ls-text-tertiary)] focus:outline-none focus:border-[var(--ls-border-strong)]"
        style={{ height: '26px', padding: '0 8px', borderRadius: '6px', fontSize: '12px' }}
      />

      <div className="flex items-center" style={{ gap: '6px' }}>
        <span
          className="text-[var(--ls-text-tertiary)]"
          style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em' }}
        >
          {t('journal.notes.sortLabel')}
        </span>
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          className="bg-[var(--ls-bg)] text-[var(--ls-text)] border border-[var(--ls-border)] focus:outline-none"
          style={{ height: '24px', padding: '0 6px', borderRadius: '5px', fontSize: '11px' }}
        >
          <option value="color">{t('journal.notes.sortByColor')}</option>
          <option value="course">{t('journal.notes.sortByCourse')}</option>
          <option value="time-desc">{t('journal.notes.sortTimeDesc')}</option>
          <option value="time-asc">{t('journal.notes.sortTimeAsc')}</option>
        </select>
      </div>

      {sortMode === 'color' && (
        <ColorGroupsView
          groups={colorGroups}
          activeColors={activeColors}
          onToggleColor={toggleColor}
          pairId={pairId}
          pooledIds={pooledIds}
          deckOptions={deckOptions}
          onNavigate={onNavigate}
        />
      )}
      {sortMode === 'course' && (
        <CourseGroupsView
          groups={courseGroups}
          pairId={pairId}
          pooledIds={pooledIds}
          deckOptions={deckOptions}
          onNavigate={onNavigate}
        />
      )}
      {(sortMode === 'time-asc' || sortMode === 'time-desc') && (
        <FlatListView
          entries={timeSorted}
          pairId={pairId}
          pooledIds={pooledIds}
          deckOptions={deckOptions}
          onNavigate={onNavigate}
        />
      )}

      {nothingToShow && (
        <p className="text-[12px] text-[var(--ls-text-tertiary)]">{t('journal.notes.noResults')}</p>
      )}

      {filteredOrphans.length > 0 && (
        <OrphanSectionView
          orphans={filteredOrphans}
          pairId={pairId}
          pooledIds={pooledIds}
          deckOptions={deckOptions}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}

// ============================================================================
// Item 4 — 添加自由笔记
// ============================================================================

function AddNoteControl({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useT();
  const journalRepo = useJournalRepo();
  const { pairId } = usePair();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');

  const createMut = useMutation({
    mutationFn: () => {
      if (!journalRepo || !pairId) throw new Error('no repo/pair');
      return journalRepo.createFreeNote({ pair_id: pairId, note: draft.trim() });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['journal-free-notes', pairId] });
      // 轻量计数案: RecentRail's "笔记" row count query is separate now — keep
      // it in sync with free-note creation too.
      qc.invalidateQueries({ queryKey: ['notes-count', pairId] });
      setDraft('');
      onOpenChange(false);
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="text-left text-[12px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
      >
        {t('journal.notes.addNote')}
      </button>
    );
  }

  return (
    <div className="flex flex-col" style={{ gap: '6px' }}>
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('annotation.notePlaceholder')}
        rows={3}
        className="w-full text-[12px] leading-5 border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] placeholder:text-[var(--ls-text-tertiary)] focus:outline-none focus:border-[var(--ls-border-strong)] resize-y"
        style={{ padding: '8px 10px', borderRadius: '6px' }}
      />
      <div className="flex items-center" style={{ gap: '10px' }}>
        <button
          type="button"
          onClick={() => createMut.mutate()}
          disabled={!draft.trim() || createMut.isPending}
          className="text-[12px] font-medium disabled:opacity-40"
          style={{ color: 'var(--ls-structure)' }}
        >
          {createMut.isPending ? t('annotation.saving') : t('annotation.save')}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft('');
            onOpenChange(false);
          }}
          className="text-[12px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
        >
          {t('annotation.cancel')}
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Item 6 — 三种排序视图 (按颜色 / 按课程 / 按时间)
// ============================================================================

function ColorGroupsView({
  groups,
  activeColors,
  onToggleColor,
  pairId,
  pooledIds,
  deckOptions,
  onNavigate,
}: {
  groups: JournalColorGroup[];
  activeColors: Set<string>;
  onToggleColor: (key: string) => void;
  pairId: PairId | null;
  pooledIds: Set<string>;
  deckOptions: string[];
  onNavigate: () => void;
}) {
  const { t } = useT();
  return (
    <div className="flex flex-col" style={{ gap: '18px' }}>
      {groups.map((g) => {
        const active = activeColors.size === 0 || activeColors.has(g.key);
        return (
          <div key={g.key}>
            {/* 组头只有色点 + 计数 — 颜色即分类学, 不配文字标签.
                批E item 5: 色点本身就是筛选开关 — 点击加入/移出 activeColors,
                再点取消 (多选); 不管是否被筛掉, 色点+计数永远都在, 只是下面
                的笔记列表在筛掉时收起. */}
            <button
              type="button"
              onClick={() => onToggleColor(g.key)}
              aria-pressed={activeColors.has(g.key)}
              title={t('journal.notes.changeColor')}
              className="flex items-center"
              style={{ gap: '8px', marginBottom: '8px', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              <span
                aria-hidden
                style={{
                  width: '9px',
                  height: '9px',
                  borderRadius: '50%',
                  background: g.hex,
                  flexShrink: 0,
                  outline: activeColors.has(g.key) ? '2px solid var(--ls-text)' : 'none',
                  outlineOffset: '2px',
                }}
              />
              <span className="text-[var(--ls-text-tertiary)] tabular-nums" style={{ fontSize: '12px' }}>
                {g.notes.length}
              </span>
            </button>
            {active && (
              <div className="flex flex-col" style={{ gap: '8px' }}>
                {g.notes.map((entry) => (
                  <NoteCard
                    key={entry.annotation.id}
                    entry={entry}
                    pairId={pairId}
                    pooledIds={pooledIds}
                    deckOptions={deckOptions}
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CourseGroupsView({
  groups,
  pairId,
  pooledIds,
  deckOptions,
  onNavigate,
}: {
  groups: JournalCourseGroup[];
  pairId: PairId | null;
  pooledIds: Set<string>;
  deckOptions: string[];
  onNavigate: () => void;
}) {
  return (
    <div className="flex flex-col" style={{ gap: '18px' }}>
      {groups.map((g) => (
        <div key={g.key}>
          <div style={{ marginBottom: '8px' }}>
            <div className="font-medium" style={{ fontSize: '12px' }}>
              {g.label}
            </div>
            {g.sublabel && (
              <div className="text-[var(--ls-text-tertiary)]" style={{ fontSize: '11px', marginTop: '1px' }}>
                {g.sublabel}
              </div>
            )}
          </div>
          <div className="flex flex-col" style={{ gap: '8px' }}>
            {g.notes.map((entry) => (
              <NoteCard
                key={entry.annotation.id}
                entry={entry}
                pairId={pairId}
                pooledIds={pooledIds}
                deckOptions={deckOptions}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FlatListView({
  entries,
  pairId,
  pooledIds,
  deckOptions,
  onNavigate,
}: {
  entries: JournalNoteEntry[];
  pairId: PairId | null;
  pooledIds: Set<string>;
  deckOptions: string[];
  onNavigate: () => void;
}) {
  return (
    <div className="flex flex-col" style={{ gap: '8px' }}>
      {entries.map((entry) => (
        <NoteCard
          key={entry.annotation.id}
          entry={entry}
          pairId={pairId}
          pooledIds={pooledIds}
          deckOptions={deckOptions}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}

function OrphanSectionView({
  orphans,
  pairId,
  pooledIds,
  deckOptions,
  onNavigate,
}: {
  orphans: JournalNoteEntry[];
  pairId: PairId | null;
  pooledIds: Set<string>;
  deckOptions: string[];
  onNavigate: () => void;
}) {
  const { t } = useT();
  return (
    <div style={{ borderTop: '1px dashed var(--ls-border)', paddingTop: '14px' }}>
      <div className="flex items-center" style={{ gap: '8px', marginBottom: '8px' }}>
        <span className="font-semibold" style={{ fontSize: '13px', color: 'var(--ls-risk)' }}>
          {t('journal.notes.orphanTitle')}
        </span>
        <span className="text-[var(--ls-text-tertiary)] tabular-nums" style={{ fontSize: '12px' }}>
          {orphans.length}
        </span>
      </div>
      <div className="flex flex-col" style={{ gap: '8px' }}>
        {orphans.map((entry) => (
          <NoteCard
            key={entry.annotation.id}
            entry={entry}
            pairId={pairId}
            pooledIds={pooledIds}
            deckOptions={deckOptions}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Item 3 — 每条笔记的操作集 (编辑 / 换色 / 入池 / 生成闪卡 / 删除), 参照课文侧
// AnnotationOverlay.tsx 既有动作的实现与风格. 同一个 NoteCard 服务于按颜色/
// 按课程/按时间三种排序视图, 以及孤儿区 — 差别只在头部的身份行 (孤儿的
// "来自 X" + 失联原因, 自由笔记的"自由笔记"标签, 普通锚定笔记什么都不加)
// 和底部的链接 (锚定笔记跳原文 / 孤儿重挂 / 自由笔记无链接, item 4).
// 批F: 两个跳转链接现在都带 onNavigate (=NotesDrawer 的 onClose) — 同 Pool
// 的 RowLinkButton 惯例, 跳转前先关抽屉.
// ============================================================================

function NoteCard({
  entry,
  pairId,
  pooledIds,
  deckOptions,
  onNavigate,
}: {
  entry: JournalNoteEntry;
  pairId: PairId | null;
  pooledIds: Set<string>;
  deckOptions: string[];
  onNavigate: () => void;
}) {
  const { t, lang } = useT();
  const repo = useRepository();
  const qc = useQueryClient();
  const {
    annotation,
    lessonId,
    lessonTitle,
    courseId,
    courseTopic,
    documentId,
    documentTitle,
    liveSessionId,
    isFree,
  } = entry;
  const orphan = isOrphaned(annotation);
  const excerpt = annotation.selected_text ? truncate(annotation.selected_text, 80) : null;
  // 批G: the host's display name, whichever kind this entry is — used
  // everywhere a generic "provenance label" is needed (pool source_title,
  // flashcard deck default) instead of assuming lessonTitle.
  const hostTitle = documentTitle ?? lessonTitle ?? t('journal.notes.freeNoteLabel');

  const [panel, setPanel] = useState<'view' | 'edit' | 'color' | 'flashcard' | 'delete'>('view');
  const [noteDraft, setNoteDraft] = useState(annotation.note ?? '');

  function invalidate() {
    if (isFree) {
      qc.invalidateQueries({ queryKey: ['journal-free-notes', pairId] });
    } else if (liveSessionId) {
      // 第三种宿主 — MUST be checked before the lessonId branch: live entries
      // carry their lesson's metadata for grouping (useJournalNotes.ts), so
      // falling through to the lesson keys would refresh the wrong caches
      // and leave the live panel + this drawer stale (批注计数同步案 判例 same class).
      qc.invalidateQueries({ queryKey: ['journal-live-annotations', liveSessionId] });
      qc.invalidateQueries({ queryKey: ['annotations', 'live', liveSessionId] });
    } else if (documentId) {
      qc.invalidateQueries({ queryKey: ['journal-doc-annotations', documentId] });
      qc.invalidateQueries({ queryKey: ['annotations', 'document', documentId] });
    } else if (lessonId) {
      qc.invalidateQueries({ queryKey: ['journal-annotations', lessonId] });
      qc.invalidateQueries({ queryKey: ['annotations', 'lesson', lessonId] });
    }
  }

  const updateNoteMut = useMutation({
    mutationFn: (note: string | null) => repo!.updateAnnotation(annotation.id, { note }),
    onSuccess: () => {
      invalidate();
      setPanel('view');
    },
  });
  const updateColorMut = useMutation({
    mutationFn: (color: string) => repo!.updateAnnotation(annotation.id, { color }),
    onSuccess: () => {
      invalidate();
      setPanel('view');
    },
  });
  const deleteMut = useMutation({
    mutationFn: () => repo!.deleteAnnotation(annotation.id),
    onSuccess: () => {
      invalidate();
      // 轻量计数案: a delete changes the total, unlike the note/color edits
      // `invalidate()` also serves — those don't add/remove a row, so they
      // deliberately don't touch this key.
      qc.invalidateQueries({ queryKey: ['notes-count', pairId] });
    },
  });

  // "加入 Pending Pool" — 接课文侧 AnnotationOverlay 的 toPoolMut 同一语义
  // (source_type: 'annotation', 同一后端), front/back 派生同一条约定 (见下
  // generateFlashcardMut 的注释).
  const pooled = pooledIds.has(annotation.id as unknown as string);
  const toPoolMut = useMutation({
    mutationFn: () => {
      if (!repo || !pairId) throw new Error('no repo/pair');
      const raw = annotation.selected_text || annotation.note || '';
      const title = raw.length > TITLE_MAX ? raw.slice(0, TITLE_MAX - 1) + '…' : raw;
      return repo.addPendingCard(pairId, {
        title,
        content: annotation.note?.trim() || annotation.selected_text,
        source_type: 'annotation',
        source_id: annotation.id as unknown as string,
        source_title: isFree ? t('journal.notes.freeNoteLabel') : hostTitle,
        reason: 'learner_highlight',
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pending-cards', pairId] }),
  });

  // "生成闪卡" — 参照 pool 的"升级成闪卡"路径 (PoolDrawer.tsx UpgradePanel,
  // 读参考不 import): front 取划选文本, 没有划选文本 (自由笔记) 则退到笔记
  // 本身; back 取笔记, 没有笔记 (纯高亮) 则退到划选文本 — 跟 toPoolMut 的
  // content 派生同一条约定, 保证两条入口对"同一条笔记该长什么样"意见一致.
  const generateFlashcardMut = useMutation({
    mutationFn: (deck: string) => {
      if (!repo || !pairId) throw new Error('no repo/pair');
      const rawFront = annotation.selected_text || annotation.note || '';
      const front = rawFront.length > TITLE_MAX ? rawFront.slice(0, TITLE_MAX - 1) + '…' : rawFront;
      const back = annotation.note?.trim() || annotation.selected_text;
      return repo.createFlashcard({
        pair_id: pairId,
        deck_id: deck as Flashcard['deck_id'],
        concept_id: null,
        front,
        back,
        tags: [],
        source_refs: [],
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['flashcards-all', pairId] }),
  });

  return (
    <div style={{ border: '1px solid var(--ls-border)', borderRadius: '8px', padding: '10px 12px' }}>
      {/* 身份行: 孤儿 = 来源课/文档 + 失联原因; 自由笔记 = 身份标签; 普通锚定
          笔记什么都不加 (下面直接是引文). */}
      {orphan && !isFree && (
        <>
          <div className="text-[11px] text-[var(--ls-text-tertiary)]">
            {t('journal.notes.sourcePrefix')}
            {hostTitle}
          </div>
          <div className="text-[11px] text-[var(--ls-text-secondary)]" style={{ marginTop: '2px' }}>
            {t('journal.notes.orphanReason')}
          </div>
        </>
      )}
      {isFree && (
        <div
          className="text-[10px] uppercase tracking-[0.05em] text-[var(--ls-text-tertiary)]"
          style={{ marginBottom: '2px' }}
        >
          {t('journal.notes.freeNoteLabel')}
        </div>
      )}

      {excerpt && (
        <div className="text-[13px] leading-[19px] text-[var(--ls-text)]" style={{ overflowWrap: 'break-word', marginTop: orphan || isFree ? '4px' : 0 }}>
          "{excerpt}"
        </div>
      )}

      {panel === 'edit' ? (
        <div className="flex flex-col" style={{ gap: '6px', marginTop: '6px' }}>
          <textarea
            autoFocus
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder={t('annotation.notePlaceholder')}
            rows={3}
            className="w-full text-[12px] leading-5 border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] placeholder:text-[var(--ls-text-tertiary)] focus:outline-none focus:border-[var(--ls-border-strong)] resize-y"
            style={{ padding: '6px 8px', borderRadius: '6px' }}
          />
          <div className="flex items-center" style={{ gap: '10px' }}>
            <button
              type="button"
              onClick={() => updateNoteMut.mutate(noteDraft.trim() || null)}
              disabled={updateNoteMut.isPending || (isFree && !noteDraft.trim())}
              className="text-[11px] font-medium disabled:opacity-40"
              style={{ color: 'var(--ls-structure)' }}
            >
              {updateNoteMut.isPending ? t('annotation.saving') : t('annotation.save')}
            </button>
            <button
              type="button"
              onClick={() => {
                setNoteDraft(annotation.note ?? '');
                setPanel('view');
              }}
              className="text-[11px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
            >
              {t('annotation.cancel')}
            </button>
          </div>
        </div>
      ) : (
        annotation.note && (
          <div
            className="text-[12px] leading-[17px] text-[var(--ls-text-secondary)]"
            style={{ marginTop: '2px', overflowWrap: 'break-word' }}
          >
            {annotation.note}
          </div>
        )
      )}

      {panel === 'color' && (
        <div className="flex items-center" style={{ gap: '6px', marginTop: '6px' }}>
          {ANNOTATION_COLORS.map((c) => (
            <button
              key={c.key}
              type="button"
              title={c.key}
              onClick={() => updateColorMut.mutate(c.key)}
              style={{
                width: '14px',
                height: '14px',
                borderRadius: '50%',
                background: c.hex,
                border: annotation.color === c.key ? '2px solid var(--ls-text)' : '1px solid var(--ls-border)',
                cursor: 'pointer',
                padding: 0,
              }}
            />
          ))}
        </div>
      )}

      {panel === 'flashcard' && (
        <GenerateFlashcardControl
          deckOptions={deckOptions}
          defaultDeck={courseTopic ?? hostTitle}
          pending={generateFlashcardMut.isPending}
          success={generateFlashcardMut.isSuccess}
          onConfirm={(deck) => generateFlashcardMut.mutate(deck)}
          onClose={() => {
            generateFlashcardMut.reset();
            setPanel('view');
          }}
        />
      )}

      <div className="flex items-center flex-wrap" style={{ gap: '8px', marginTop: '8px' }}>
        <span className="text-[10px] uppercase tracking-[0.05em] text-[var(--ls-text-tertiary)]">
          {formatNoteDate(annotation.created_at, lang)}
        </span>
        {/* 第三种宿主 (2026-07-18): live entries carry lessonId too, so this
            branch must come before the lesson ones. No "第 N 页" chip —
            page_index is a move seq here, "Page N" would be a lie — and the
            link lands on the lesson page (its Live Teaching history panel is
            where the record lives), without ?page= for the same reason. */}
        {!isFree && liveSessionId && lessonId && courseId && (
          <Link
            to={buildLessonLiveLink(courseId, lessonId)}
            onClick={onNavigate}
            className="hover:underline"
            style={{ fontSize: '11px', fontWeight: 500, color: 'var(--ls-structure)' }}
          >
            {t('journal.notes.jumpToLiveRecord')}
          </Link>
        )}
        {!isFree && !liveSessionId && !orphan && lessonId && courseId && (
          <>
            <span className="text-[10px] uppercase tracking-[0.05em] text-[var(--ls-text-tertiary)]">
              {t('journal.notes.pagePrefix')}
              {annotation.page_index + 1}
              {t('journal.notes.pageSuffix')}
            </span>
            <Link
              to={buildLessonPageLink(courseId, lessonId, annotation.page_index)}
              onClick={onNavigate}
              className="hover:underline"
              style={{ fontSize: '11px', fontWeight: 500, color: 'var(--ls-structure)' }}
            >
              {t('journal.notes.jumpToLesson')}
            </Link>
          </>
        )}
        {!isFree && !liveSessionId && orphan && lessonId && courseId && (
          <Link
            to={buildLessonPageLink(courseId, lessonId, annotation.page_index)}
            onClick={onNavigate}
            className="hover:underline"
            style={{ fontSize: '11px', fontWeight: 500, color: 'var(--ls-structure)' }}
          >
            {t('journal.notes.reanchor')}
          </Link>
        )}
        {/* 批G: document-hosted entries — no page concept (continuous
            scroll, brief §4), so no "第 N 页" chip, just the jump link. */}
        {!isFree && documentId && (
          <Link
            to={buildDocumentLink(documentId)}
            onClick={onNavigate}
            className="hover:underline"
            style={{ fontSize: '11px', fontWeight: 500, color: 'var(--ls-structure)' }}
          >
            {orphan ? t('journal.notes.reanchor') : t('journal.notes.jumpToDocument')}
          </Link>
        )}
      </div>

      {panel === 'delete' ? (
        <div className="flex items-center" style={{ gap: '10px', marginTop: '8px' }}>
          <button
            type="button"
            onClick={() => deleteMut.mutate()}
            disabled={deleteMut.isPending}
            className="text-[11px] font-medium disabled:opacity-40"
            style={{ color: 'var(--ls-risk)' }}
          >
            {deleteMut.isPending ? t('journal.notes.deleting') : t('annotation.confirmDelete')}
          </button>
          <button
            type="button"
            onClick={() => setPanel('view')}
            className="text-[11px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
          >
            {t('annotation.cancel')}
          </button>
        </div>
      ) : (
        <div className="flex items-center flex-wrap" style={{ gap: '10px', marginTop: '8px' }}>
          <button
            type="button"
            onClick={() => setPanel(panel === 'edit' ? 'view' : 'edit')}
            className="text-[11px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
          >
            {t('annotation.note')}
          </button>
          <button
            type="button"
            onClick={() => setPanel(panel === 'color' ? 'view' : 'color')}
            title={t('journal.notes.changeColor')}
            aria-label={t('journal.notes.changeColor')}
            style={{
              width: '11px',
              height: '11px',
              borderRadius: '50%',
              background: annotationColorHex(annotation.color),
              border: '1px solid var(--ls-border)',
              padding: 0,
              cursor: 'pointer',
            }}
          />
          <button
            type="button"
            onClick={() => toPoolMut.mutate()}
            disabled={pooled || toPoolMut.isPending}
            className="text-[11px] text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)] disabled:opacity-40"
          >
            {pooled
              ? t('annotation.pooled')
              : toPoolMut.isPending
                ? t('annotation.poolingInProgress')
                : t('annotation.toPool')}
          </button>
          <button
            type="button"
            onClick={() => setPanel(panel === 'flashcard' ? 'view' : 'flashcard')}
            className="text-[11px] text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)]"
          >
            {t('journal.notes.generateFlashcard')}
          </button>
          <button
            type="button"
            onClick={() => setPanel('delete')}
            className="text-[11px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-risk)]"
          >
            {t('annotation.delete')}
          </button>
        </div>
      )}
    </div>
  );
}

function GenerateFlashcardControl({
  deckOptions,
  defaultDeck,
  pending,
  success,
  onConfirm,
  onClose,
}: {
  deckOptions: string[];
  defaultDeck: string;
  pending: boolean;
  success: boolean;
  onConfirm: (deck: string) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [deck, setDeck] = useState(defaultDeck);
  const [newDeckMode, setNewDeckMode] = useState(
    deckOptions.length === 0 || !deckOptions.includes(defaultDeck)
  );
  const canConfirm = deck.trim().length > 0 && !pending;

  if (success) {
    return (
      <div className="flex items-center" style={{ gap: '8px', marginTop: '6px' }}>
        <span className="text-[11px]" style={{ color: 'var(--ls-structure)' }}>
          {t('journal.notes.flashcardGenerated')}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
        >
          {t('journal.notes.done')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center flex-wrap" style={{ gap: '6px', marginTop: '6px' }}>
      <span
        className="text-[var(--ls-text-tertiary)]"
        style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em' }}
      >
        {t('cards.deck')}
      </span>
      {newDeckMode || deckOptions.length === 0 ? (
        <input
          type="text"
          value={deck}
          onChange={(e) => setDeck(e.target.value)}
          placeholder={t('journal.notes.deckPlaceholder')}
          className="bg-[var(--ls-bg)] text-[var(--ls-text)] border border-[var(--ls-border)] focus:outline-none"
          style={{ height: '24px', padding: '0 8px', borderRadius: '5px', fontSize: '11px', width: '110px' }}
        />
      ) : (
        <select
          value={deck}
          onChange={(e) => {
            if (e.target.value === NEW_DECK_SENTINEL) {
              setNewDeckMode(true);
              setDeck('');
            } else {
              setDeck(e.target.value);
            }
          }}
          className="bg-[var(--ls-bg)] text-[var(--ls-text)] border border-[var(--ls-border)] focus:outline-none"
          style={{ height: '24px', padding: '0 6px', borderRadius: '5px', fontSize: '11px' }}
        >
          {deckOptions.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
          <option value={NEW_DECK_SENTINEL}>{t('journal.notes.newDeckOption')}</option>
        </select>
      )}
      <button
        type="button"
        onClick={() => onConfirm(deck.trim())}
        disabled={!canConfirm}
        className="text-[11px] font-medium disabled:opacity-40"
        style={{ color: 'var(--ls-structure)' }}
      >
        {pending ? t('journal.notes.generatingFlashcard') : t('journal.notes.generateFlashcard')}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="text-[11px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
      >
        {t('annotation.cancel')}
      </button>
    </div>
  );
}
