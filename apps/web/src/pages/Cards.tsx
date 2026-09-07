import type { FlashcardActivationRepo } from '../repository/flashcardActivationExt';
// Stage 7e-cards · v3 (2026-07-21): management IA for the 562-card era.
// (v2 was the design-HTML reproduction: stat tiles + chips + deck/tag
// grouping in one long scroll — fine at 40 cards, unbrowsable at 562.)
//
// IA now:
//   - Left scope tree: course → lesson hierarchy (card → lesson resolves
//     via flashcard.concept_id → lesson.concept_ids, backfilled 2026-07-21;
//     lesson → course via lesson.course_id). Ungrouped bucket last, same
//     UNGROUPED_COURSE_KEY sentinel as review/DeckRail.tsx. Accordion
//     vocabulary borrowed from DeckRail (▸ rotate, Set-of-open-keys).
//   - Toolbar: text search (front+back) + state chips (All/Due/Paused/Rest)
//     + sort select (due date asc / lesson order / recently created).
//   - Compact windowed rows (content-visibility: auto): dot · front ·
//     deck chip (→ /review?deck=) · due/paused chip · chevron; click
//     expands inline to the v2 edit affordances (suspend/reset/pool/delete).
//   - Bulk ops: select mode + select-all-in-scope; bulk pause/unpause and
//     move-to-deck via existing PATCH endpoints only (Promise.all + a small
//     n/N progress count).
//   - Scoped review: every tree node and the scope header link to /review
//     with the honest param (?course= / ?lesson= / ?deck=); an unscoped
//     custom filter links to bare /review. Never bare all-due from a
//     scoped context (入口主权条款: entry intent outranks page default).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useHotkeys } from 'react-hotkeys-hook';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Flashcard, Repository } from '@learn-shell/contracts';
import { cardLessonId, isActiveCard, isDueReviewCard, isIndependentCard } from '../lib/cardEligibility';
import { UNGROUPED_COURSE_KEY } from '../review/DeckRail';
import { StateDot, type StateDotShape } from '../components/StateDot';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';
import { useT } from '../i18n';
import type { DictKey } from '../i18n/dict';
import type { FlashcardImportRepo, FlashcardImportResult } from '../repository/flashcardImportExt';

type Filter = 'all' | 'due' | 'paused' | 'rest';
type SortMode = 'due' | 'lesson' | 'created';
type CardState = 'New' | 'Learning' | 'Review' | 'Mastered';

// Scope = the selected node of the left tree. 'ungrouped' is the trailing
// bucket for cards whose concept_id doesn't resolve to any lesson (or is
// null) — same sentinel semantics as DeckRail's UNGROUPED_COURSE_KEY.
type Scope =
  | { kind: 'all' }
  | { kind: 'course'; id: string }
  | { kind: 'lesson'; id: string }
  | { kind: 'ungrouped' }
  | { kind: 'unresolved' }
  | { kind: 'independent-deck'; id: string };

// Windowing for 562+ rows — CSS-only, no virtualization library: rows
// off-screen skip layout/paint entirely; the intrinsic-size hint keeps the
// scrollbar honest (~47px = one collapsed row). 'auto' keeps the browser's
// last-rendered measurement once a row has been on screen, so expanded
// rows don't snap back to the estimate.
const rowWindowStyle: React.CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 47px',
};

// Display-label lookup for the internal CardState/'Suspended' union — the
// union values themselves stay English (used as keys/logic), only the
// rendered text goes through the dict.
const STATE_LABEL_KEY: Record<CardState | 'Suspended', DictKey> = {
  New: 'cards.state.new',
  Learning: 'cards.state.learning',
  Review: 'cards.state.review',
  Mastered: 'cards.state.mastered',
  Suspended: 'cards.state.suspended',
};

const WEAK_LAPSES = 2; // design model uses lapses; we don't track lapses, fall back to retrievability
const WEAK_R_THRESHOLD = 0.5;
const MASTERED_R_THRESHOLD = 0.85;

// Shared input chrome for the "+ Add card" panel — matches the search input
// (height 34 / border ls-border / radius 6 / 13px) already used above.
const fieldInputStyle: React.CSSProperties = {
  height: '34px',
  padding: '0 12px',
  border: '1px solid var(--ls-border)',
  borderRadius: '6px',
  fontSize: '13px',
  lineHeight: '1',
  width: '100%',
};

// Sentinel option value for "New deck…" in the deck select (新建卡组哨兵项 增强,
// 2026-07-05 点名). Decks stay derived entities — a deck is born with
// its first card, never pre-created empty — so "creating" one is just
// typing a fresh deck_id at card-creation time.
const NEW_DECK_SENTINEL = '__new_deck__';

// ---------------------------------------------------------------------------
// Card derivations
// ---------------------------------------------------------------------------

function cardState(c: Flashcard): CardState {
  const { retrievability, review_count } = c.fsrs_state;
  if (review_count === 0) return 'New';
  if (retrievability >= MASTERED_R_THRESHOLD && review_count >= 5) return 'Mastered';
  if (review_count < 3) return 'Learning';
  return 'Review';
}

function isDue(c: Flashcard, nowMs: number): boolean {
  return new Date(c.fsrs_state.due_at).getTime() <= nowMs;
}

function isWeak(c: Flashcard): boolean {
  // Design uses `lapses >= 2`; FSRS schema doesn't track lapses separately,
  // so we approximate via low retrievability.
  return c.fsrs_state.retrievability < WEAK_R_THRESHOLD;
}

function isMastered(c: Flashcard): boolean {
  return cardState(c) === 'Mastered';
}

// 圆点统一案 二次裁定 (实机截图复核, 2026-07-22): CardRow 这排点是 ROW 家族
// 的原始视觉参照物本身——之前用字体字形画圆 (○/◐/●/◉), 不同字重/字体下
// 墨迹直径不稳定, 就是"字体画圆漂移"要治的病根。改用 ../components/StateDot
// 的三态 CSS 几何圆 (ring/half/solid), 颜色/语义原样保留 (dotForCard 的
// 每个分支只换了 glyph→shape, color 一个字符没动):
//   ⏸ 暂停 (tertiary 灰)     → 不是圆, 不进 StateDot, 仍是文本图标字形
//                               (暂停条没有"画圆漂移"问题, 硬套 ring/half/
//                               solid 反而丢失"暂停"这个含义)
//   ○ New (tertiary 灰)      → ring   (空心 = 还没学)
//   ◐ Learning (hypothesis)  → half   (半实心 = 学习中)
//   ◉ Review (structure 蓝)  → solid  (三态里只有 ring/half/solid, ◉ 视觉上
//                               "墨迹占满" 比 ring/half 更接近 solid; 跟
//                               Mastered 的 solid 靠颜色区分——structure 蓝
//                               vs corroborated 绿, 不是形状)
//   ● Mastered (corroborated 绿) → solid (满实心 = 学完钦定)
type CardDotSpec =
  | { kind: 'dot'; shape: StateDotShape; color: string }
  | { kind: 'icon'; glyph: string; color: string };

function dotForCard(c: Flashcard): CardDotSpec {
  if (c.paused) return { kind: 'icon', glyph: '⏸', color: 'var(--ls-text-tertiary)' };
  const st = cardState(c);
  if (st === 'Mastered') return { kind: 'dot', shape: 'solid', color: 'var(--ls-corroborated)' };
  if (st === 'New') return { kind: 'dot', shape: 'ring', color: 'var(--ls-text-tertiary)' };
  if (st === 'Learning') return { kind: 'dot', shape: 'half', color: 'var(--ls-hypothesis)' };
  return { kind: 'dot', shape: 'solid', color: 'var(--ls-structure)' };
}

function formatDue(c: Flashcard, nowMs: number): { label: string; color: string } {
  if (!isActiveCard(c) || c.paused) return { label: '—', color: 'var(--ls-text-tertiary)' };
  const ms = new Date(c.fsrs_state.due_at).getTime() - nowMs;
  if (ms <= 0) {
    const abs = -ms;
    const h = Math.round(abs / 3_600_000);
    if (h < 24) return { label: 'today', color: 'var(--ls-risk)' };
    const d = Math.round(abs / 86_400_000);
    return { label: `${d}d ago`, color: 'var(--ls-risk)' };
  }
  const h = Math.round(ms / 3_600_000);
  if (h < 24) return { label: `${h}h`, color: 'var(--ls-text-tertiary)' };
  const d = Math.round(ms / 86_400_000);
  return { label: `${d}d`, color: 'var(--ls-text-tertiary)' };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Cards() {
  const { t, lang } = useT();
  const repo = useRepository();
  // Both concrete repos (Mock/Http) implement FlashcardImportRepo too — see
  // repository/flashcardImportExt.ts's header for why it's a local additive
  // interface instead of living on Repository itself.
  const importRepo = repo as (Repository & FlashcardImportRepo) | null;
  const { pairId } = usePair();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const allQ = useQuery({
    queryKey: ['flashcards-all', pairId],
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    queryFn: () =>
      repo && pairId ? repo.getAllFlashcards(pairId) : Promise.resolve([]),
    enabled: !!repo && !!pairId,
  });

  const [filter, setFilter] = useState<Filter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('due');
  const [scope, setScope] = useState<Scope>({ kind: 'all' });
  const [query, setQuery] = useState('');
  const [openCard, setOpenCard] = useState<string | null>(null);

  // ------------------------- Add card (Task 1) -------------------------
  const [addOpen, setAddOpen] = useState(false);
  const [addFront, setAddFront] = useState('');
  const [addBack, setAddBack] = useState('');
  const [addDeck, setAddDeck] = useState('');
  const [addConcept, setAddConcept] = useState('');
  // "New deck…" mode — lives here (not in AddCardPanel) because the
  // auto-prefill effect below would otherwise stuff deckOptions[0] right
  // back into the field the moment new-deck mode clears it.
  const [newDeckMode, setNewDeckMode] = useState(false);

  // ------------------------- Markdown import (2026-07-08 定案) -------------------------
  const [importOpen, setImportOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  // ------------------------- Select mode (多选模式案) -------------------------
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  // 键盘覆盖率审计补丁 (open-source sprint ①线): Esc exits select mode and
  // clears the selection — identical to SelectionBar's onCancel below, just
  // reachable without a mouse. This page never had any keyboard bindings
  // before this patch; default react-hotkeys-hook behavior already skips
  // form tags (search input, add-card fields), so Esc here can't fight
  // typing. No-op outside select mode.
  useHotkeys(
    'escape',
    () => {
      if (!selectMode) return;
      setSelectMode(false);
      setSelectedIds(new Set());
    },
    [selectMode]
  );

  // ------------------------- Pending pool (卡片入池案) -------------------------
  // Read-only reuse of the Mindmap side's Pending Pool repo methods — Cards
  // page just needs to know which flashcards have already been tossed in,
  // so the "To pool" action can dedupe against the real pool instead of a
  // client-only guess.
  const pendingQ = useQuery({
    queryKey: ['pending-cards', pairId],
    queryFn: () => (repo && pairId ? repo.getPendingCards(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });
  const pooledFlashcardIds = useMemo(() => {
    const s = new Set<string>();
    for (const p of pendingQ.data ?? []) {
      if (p.source_type === 'flashcard' && p.source_id) s.add(p.source_id);
    }
    return s;
  }, [pendingQ.data]);

  const cards = allQ.data ?? [];
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    const tick = () => { if (!document.hidden) setNowMs(Date.now()); };
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  // ------------------------- Scope tree data (v3) -------------------------
  // Rides the exact query keys Review.tsx / Courses.tsx already use
  // (['courses', pairId] / ['lessons', courseId]) so this costs no new
  // fetches when the learner arrives from either page. Card → lesson resolves via
  // the only provenance bridge a card has: flashcard.concept_id →
  // lesson.concept_ids (backfilled 2026-07-21) → lesson.course_id.
  const coursesQ = useQuery({
    queryKey: ['courses', pairId],
    queryFn: () => (repo && pairId ? repo.getCourses(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });
  const courses = coursesQ.data ?? [];
  const lessonsQs = useQueries({
    queries: courses.map((c) => ({
      queryKey: ['lessons', c.id],
      queryFn: () => (repo ? repo.getLessons(c.id) : Promise.resolve([])),
      enabled: !!repo,
    })),
  });

  // concept_id → its lesson's coordinates. First-seen wins on a concept
  // that appears in multiple lessons — same tie rule as Review.tsx's
  // conceptToCourse map.
  type LessonLoc = {
    lessonId: string;
    lessonTitle: string;
    lessonOrder: number;
    courseId: string;
    courseIdx: number;
  };
  const conceptLoc = useMemo(() => {
    const m = new Map<string, LessonLoc>();
    courses.forEach((c, i) => {
      const lessons = lessonsQs[i]?.data ?? [];
      for (const lesson of lessons) {
        for (const conceptId of lesson.concept_ids) {
          const key = conceptId as unknown as string;
          if (!m.has(key)) {
            m.set(key, {
              lessonId: lesson.id as unknown as string,
              lessonTitle: lesson.title,
              lessonOrder: lesson.order,
              courseId: c.id as unknown as string,
              courseIdx: i,
            });
          }
        }
      }
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courses, lessonsQs]);

  // Use the server's concept → lesson join first. Legacy mock cards alone
  // fall back to the old inverse concept index.
  const lessonLoc = useMemo(() => {
    const m = new Map<string, LessonLoc>();
    courses.forEach((course, courseIdx) => {
      for (const lesson of lessonsQs[courseIdx]?.data ?? []) {
        m.set(lesson.id, {
          lessonId: lesson.id, lessonTitle: lesson.title, lessonOrder: lesson.order,
          courseId: course.id, courseIdx,
        });
      }
    });
    return m;
  }, [courses, lessonsQs]);
  const cardLoc = useMemo(() => {
    const m = new Map<string, LessonLoc>();
    for (const card of cards) {
      const legacy = card.concept_id ? conceptLoc.get(card.concept_id) : undefined;
      const lessonId = cardLessonId(card, legacy?.lessonId);
      const loc = lessonId ? lessonLoc.get(lessonId) : undefined;
      if (loc) m.set(card.id, loc);
    }
    return m;
  }, [cards, conceptLoc, lessonLoc]);

  // Tree nodes: courses (getCourses order) → lessons (lesson.order), only
  // nodes that actually hold cards; Ungrouped bucket last (DeckRail's
  // UNGROUPED_COURSE_KEY convention). Counts are total cards per node; due
  // counts feed the quiet "Review N" affordances.
  type TreeLesson = { lessonId: string; title: string; count: number; due: number };
  type TreeCourse = {
    courseId: string;
    topic: string;
    count: number;
    due: number;
    lessons: TreeLesson[];
  };
  const tree = useMemo(() => {
    const lessonAgg = new Map<string, { count: number; due: number }>();
    const courseAgg = new Map<string, { count: number; due: number }>();
    let independentCount = 0;
    let unresolvedCount = 0;
    for (const c of cards) {
      const loc =
        cardLoc.get(c.id);
      const cardDue = isDueReviewCard(c, nowMs) ? 1 : 0;
      if (!loc) {
        if (isIndependentCard(c)) independentCount++;
        else unresolvedCount++;
        continue;
      }
      const la = lessonAgg.get(loc.lessonId) ?? { count: 0, due: 0 };
      la.count++;
      la.due += cardDue;
      lessonAgg.set(loc.lessonId, la);
      const ca = courseAgg.get(loc.courseId) ?? { count: 0, due: 0 };
      ca.count++;
      ca.due += cardDue;
      courseAgg.set(loc.courseId, ca);
    }
    const courseNodes: TreeCourse[] = [];
    courses.forEach((c, i) => {
      const courseKey = c.id as unknown as string;
      const agg = courseAgg.get(courseKey);
      if (!agg) return;
      const lessons = (lessonsQs[i]?.data ?? [])
        .slice()
        .sort((a, b) => a.order - b.order)
        .flatMap((l) => {
          const la = lessonAgg.get(l.id as unknown as string);
          return la
            ? [
                {
                  lessonId: l.id as unknown as string,
                  title: l.title,
                  count: la.count,
                  due: la.due,
                },
              ]
            : [];
        });
      courseNodes.push({
        courseId: courseKey,
        topic: c.topic,
        count: agg.count,
        due: agg.due,
        lessons,
      });
    });
    return { courseNodes, independentCount, unresolvedCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, cardLoc, courses, lessonsQs, nowMs]);

  const independentDecks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of cards) {
      if (!cardLoc.has(card.id) && isIndependentCard(card)) {
        counts.set(card.deck_id, (counts.get(card.deck_id) ?? 0) + 1);
      }
    }
    return Array.from(counts, ([id, count]) => ({ id, count })).sort((a, b) => a.id.localeCompare(b.id));
  }, [cards, cardLoc]);

  // Deck select options for Add-card / Move-to-deck (unchanged axis:
  // deck_id, derived from the cards themselves).
  const deckOptions = useMemo(
    () => Array.from(new Set(cards.map((c) => c.deck_id))).sort(),
    [cards]
  );

  useEffect(() => {
    if (newDeckMode || addDeck || deckOptions.length === 0) return;
    setAddDeck(deckOptions[0]!);
  }, [newDeckMode, addDeck, deckOptions]);

  // ------------------------- Stats -------------------------
  const stats = useMemo(() => {
    const total = cards.length;
    let due = 0;
    let weak = 0;
    let mastered = 0;
    let suspended = 0;
    for (const c of cards) {
      if (!isActiveCard(c)) continue;
      if (c.paused) {
        suspended++;
        continue;
      }
      if (isDue(c, nowMs)) due++;
      if (isWeak(c)) weak++;
      if (isMastered(c)) mastered++;
    }
    return { total, due, weak, mastered, suspended };
  }, [cards, nowMs]);

  // ------------------------- Scope → filter → search → sort -------------------------
  const scopedCards = useMemo(() => {
    if (scope.kind === 'all') return cards;
    return cards.filter((c) => {
      const loc =
        cardLoc.get(c.id);
      if (scope.kind === 'ungrouped') return !loc;
      if (scope.kind === 'unresolved') return !loc && !isIndependentCard(c);
      if (scope.kind === 'independent-deck') return !loc && c.deck_id === scope.id;
      if (scope.kind === 'course') return loc?.courseId === scope.id;
      return loc?.lessonId === scope.id;
    });
  }, [cards, scope, cardLoc]);

  // Chip counts live inside the current scope (search-agnostic) — the
  // chips describe the scope, the search narrows within it.
  const scopeCounts = useMemo(() => {
    let due = 0;
    let paused = 0;
    let rest = 0;
    // All remains a management count. Due/Rest describe only activated
    // cards; dormant cards are retained and counted separately.
    let dormant = 0;
    for (const c of scopedCards) {
      if (!isActiveCard(c)) dormant++;
      if (c.paused) paused++;
      else if (isDueReviewCard(c, nowMs)) due++;
      else if (isActiveCard(c)) rest++;
    }
    return { all: scopedCards.length, due, paused, rest, dormant };
  }, [scopedCards, nowMs]);

  const visibleCards = useMemo(() => {
    let arr = scopedCards;
    if (filter === 'due') arr = arr.filter((c) => isDueReviewCard(c, nowMs));
    else if (filter === 'paused') arr = arr.filter((c) => c.paused);
    else if (filter === 'rest') arr = arr.filter((c) => isActiveCard(c) && !c.paused && !isDue(c, nowMs));
    if (query.trim()) {
      const q = query.toLowerCase();
      arr = arr.filter(
        (c) => c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q)
      );
    }
    const sorted = arr.slice();
    if (sortMode === 'due') {
      sorted.sort(
        (a, b) =>
          new Date(a.fsrs_state.due_at).getTime() - new Date(b.fsrs_state.due_at).getTime()
      );
    } else if (sortMode === 'lesson') {
      // Course order (getCourses) → lesson.order → created_at. Cards that
      // don't resolve to a lesson sink to the end.
      const key = (c: Flashcard) => {
        const loc =
          cardLoc.get(c.id);
        return loc
          ? { ci: loc.courseIdx, lo: loc.lessonOrder }
          : { ci: Number.MAX_SAFE_INTEGER, lo: 0 };
      };
      sorted.sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        if (ka.ci !== kb.ci) return ka.ci - kb.ci;
        if (ka.lo !== kb.lo) return ka.lo - kb.lo;
        return a.created_at.localeCompare(b.created_at);
      });
    } else {
      // 'created' — newest first ("did my import land?" is the use case).
      sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    return sorted;
  }, [scopedCards, filter, query, sortMode, nowMs, cardLoc]);

  // Scope header: human label + the honest review deep link. 入口主权条款 —
  // never bare all-due from a scoped context: course/lesson scopes carry
  // their param; the unscoped default (a custom filter at most) goes to
  // bare /review; Ungrouped has no honest param, so it gets no link at all.
  const scopeLabel = (() => {
    if (scope.kind === 'all') return t('cards.tree.allCards');
    if (scope.kind === 'ungrouped') return t('cards.tree.independent');
    if (scope.kind === 'unresolved') return t('cards.tree.unresolved');
    if (scope.kind === 'independent-deck') return scope.id;
    if (scope.kind === 'course') {
      return tree.courseNodes.find((n) => n.courseId === scope.id)?.topic ?? scope.id;
    }
    for (const n of tree.courseNodes) {
      const l = n.lessons.find((x) => x.lessonId === scope.id);
      if (l) return l.title;
    }
    return scope.id;
  })();
  const scopeReviewTo =
    scope.kind === 'course'
      ? `/review?course=${encodeURIComponent(scope.id)}`
      : scope.kind === 'lesson'
        ? `/review?lesson=${encodeURIComponent(scope.id)}`
        : scope.kind === 'independent-deck'
          ? `/review?deck=${encodeURIComponent(scope.id)}`
        : scope.kind === 'all'
          ? '/review'
          : null;

  const activationMut = useMutation({
    mutationFn: ({ id, activated }: { id: Flashcard['id']; activated: boolean }) =>
      (repo as Repository & FlashcardActivationRepo).setFlashcardActivated(id, activated),
    onSuccess: () => {
      for (const key of ['flashcards-all', 'all-flashcards', 'due-full', 'due']) {
        void qc.invalidateQueries({ queryKey: [key, pairId] });
      }
    },
    onError: () => setToast(t('cards.activationFailed')),
  });

  // ------------------------- Mutations -------------------------
  const createMut = useMutation({
    mutationFn: () =>
      repo!.createFlashcard({
        pair_id: pairId!,
        deck_id: addDeck as Flashcard['deck_id'],
        concept_id: addConcept.trim()
          ? (addConcept.trim() as Flashcard['concept_id'])
          : null,
        front: addFront.trim(),
        back: addBack.trim(),
        tags: [],
        source_refs: [],
      }),
    onSuccess: () => {
      invalidateAll();
      setAddFront('');
      setAddBack('');
      setAddConcept('');
      setAddOpen(false);
      // The freshly-typed deck now exists in deckOptions (card created), so
      // exit new-deck mode; addDeck keeps the new name = it's preselected.
      setNewDeckMode(false);
    },
  });
  const pauseMut = useMutation({
    mutationFn: ({ id, paused }: { id: Flashcard['id']; paused: boolean }) =>
      repo!.setFlashcardPaused(id, paused),
    onSuccess: invalidateAll,
  });
  const resetMut = useMutation({
    mutationFn: (id: Flashcard['id']) => repo!.resetFlashcardFsrs(id),
    onSuccess: invalidateAll,
  });
  const deleteMut = useMutation({
    mutationFn: (id: Flashcard['id']) => repo!.deleteFlashcard(id),
    onSuccess: invalidateAll,
  });
  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ['flashcards-all'] });
    qc.invalidateQueries({ queryKey: ['cards-due'] });
    qc.invalidateQueries({ queryKey: ['due-full'] });
  }
  function invalidatePending() {
    qc.invalidateQueries({ queryKey: ['pending-cards'] });
  }

  // ------------------------- Bulk ops (多选模式案 + v3 pause/unpause) -------------------------
  // No bulk endpoint exists — bulk = N per-card PATCHes (the only writes the
  // server offers: PATCH /flashcards/:id with paused / deck_id). Promise.all
  // with a small n/N progress count so 30 selected cards don't look hung.
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  async function runBatch<T>(jobs: Array<() => Promise<T>>): Promise<T[]> {
    setBulkProgress({ done: 0, total: jobs.length });
    try {
      return await Promise.all(
        jobs.map((job) =>
          job().then((r) => {
            setBulkProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
            return r;
          })
        )
      );
    } finally {
      setBulkProgress(null);
    }
  }
  const bulkMoveMut = useMutation({
    mutationFn: ({ ids, deck }: { ids: string[]; deck: string }) =>
      runBatch(
        ids.map(
          (id) => () =>
            repo!.setFlashcardDeck(id as Flashcard['id'], deck as Flashcard['deck_id'])
        )
      ),
    onSuccess: () => {
      invalidateAll();
      setSelectMode(false);
      setSelectedIds(new Set());
    },
  });
  // Pause/unpause keeps select mode alive — pausing a batch and then
  // moving the same batch is a real flow; clearing selection would break it.
  const bulkPauseMut = useMutation({
    mutationFn: ({ ids, paused }: { ids: string[]; paused: boolean }) =>
      runBatch(
        ids.map((id) => () => repo!.setFlashcardPaused(id as Flashcard['id'], paused))
      ),
    onSuccess: invalidateAll,
  });

  // ------------------------- To pool (卡片入池案) -------------------------
  // front→title / back→content is the only sane mapping onto
  // PendingMindmapCard's actual fields (title/content/source_type/
  // source_id/source_title/reason) — the brief's "tag/headline/content"
  // description doesn't match this entity; there's no tag field on it.
  function pendingCardPayload(c: Flashcard) {
    return {
      title: c.front,
      content: c.back,
      source_type: 'flashcard' as const,
      source_id: c.id as unknown as string,
      source_title: c.deck_id as unknown as string,
    };
  }
  const toPoolMut = useMutation({
    mutationFn: (c: Flashcard) => repo!.addPendingCard(pairId!, pendingCardPayload(c)),
    onSuccess: invalidatePending,
  });
  const bulkToPoolMut = useMutation({
    mutationFn: async (targets: Flashcard[]) => {
      await Promise.all(
        targets
          .filter((c) => !pooledFlashcardIds.has(c.id as unknown as string))
          .map((c) => repo!.addPendingCard(pairId!, pendingCardPayload(c)))
      );
    },
    onSuccess: () => {
      invalidatePending();
      setSelectMode(false);
      setSelectedIds(new Set());
    },
  });

  if (!repo) {
    return (
      <p className="text-sm text-[var(--ls-text-secondary)]">
        {t('cards.emptyMode')}
      </p>
    );
  }

  // Pick the headline subtitle. In real fixture there's one deck (CFA / FSA).
  const subtitle =
    cards.length > 0 && new Set(cards.map((c) => c.deck_id)).size === 1
      ? `${cards[0]!.deck_id}`
      : `${t('cards.acrossDecksPrefix')}${stats.total}${t('cards.acrossDecksMiddle')}${new Set(cards.map((c) => c.deck_id)).size}${t('cards.acrossDecksSuffix')}`;

  return (
    <div className="mx-auto" style={{ maxWidth: '1160px' }}>
      {/* =================== Header =================== */}
      <div
        className="flex items-end justify-between flex-wrap"
        style={{ gap: '16px', marginBottom: '24px' }}
      >
        <div>
          <h1
            className="font-bold"
            style={{
              margin: 0,
              fontSize: '24px',
              lineHeight: '32px',
              letterSpacing: '-0.02em',
            }}
          >
            {t('cards.title')}
          </h1>
          <div
            className="text-[var(--ls-text-tertiary)]"
            style={{ fontSize: '13px', lineHeight: '20px', marginTop: '2px' }}
          >
            {cards.length === 0 ? t('cards.noCardsYet') : subtitle}
          </div>
        </div>
        <div className="flex flex-wrap" style={{ gap: '10px' }}>
          <button
            type="button"
            onClick={() => navigate('/review')}
            disabled={stats.due === 0}
            className="inline-flex items-center disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              gap: '8px',
              height: '34px',
              padding: '0 14px',
              borderRadius: '6px',
              background: 'var(--ls-text)',
              color: 'var(--ls-bg)',
              fontWeight: 500,
              fontSize: '13px',
              lineHeight: '1',
              cursor: 'pointer',
            }}
          >
            {t('cards.reviewDueButton')}
          </button>
          <button
            type="button"
            onClick={() => setAddOpen((v) => !v)}
            className="inline-flex items-center"
            style={{
              gap: '8px',
              height: '34px',
              padding: '0 14px',
              borderRadius: '6px',
              border: `1px solid ${addOpen ? 'var(--ls-text)' : 'var(--ls-border-strong)'}`,
              fontWeight: 500,
              fontSize: '13px',
              lineHeight: '1',
              cursor: 'pointer',
            }}
          >
            {addOpen ? t('cards.cancel') : t('cards.addCardButton')}
          </button>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center"
            style={{
              gap: '8px',
              height: '34px',
              padding: '0 14px',
              borderRadius: '6px',
              border: '1px solid var(--ls-border-strong)',
              fontWeight: 500,
              fontSize: '13px',
              lineHeight: '1',
              cursor: 'pointer',
            }}
          >
            {t('cards.import.button')}
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectMode((v) => !v);
              setSelectedIds(new Set());
            }}
            className="inline-flex items-center"
            style={{
              gap: '8px',
              height: '34px',
              padding: '0 14px',
              borderRadius: '6px',
              border: `1px solid ${selectMode ? 'var(--ls-text)' : 'var(--ls-border-strong)'}`,
              fontWeight: 500,
              fontSize: '13px',
              lineHeight: '1',
              cursor: 'pointer',
            }}
          >
            {selectMode ? t('cards.selectDone') : t('cards.select')}
          </button>
        </div>
      </div>

      {/* =================== Add card panel (Task 1) =================== */}
      {addOpen && (
        <AddCardPanel
          front={addFront}
          back={addBack}
          deck={addDeck}
          concept={addConcept}
          deckOptions={deckOptions}
          newDeckMode={newDeckMode}
          onNewDeckModeChange={setNewDeckMode}
          pending={createMut.isPending}
          error={createMut.isError}
          onFrontChange={setAddFront}
          onBackChange={setAddBack}
          onDeckChange={setAddDeck}
          onConceptChange={setAddConcept}
          onCancel={() => setAddOpen(false)}
          onSubmit={() => createMut.mutate()}
        />
      )}

      {/* =================== Selection action bar (多选模式案/卡片入池案) =================== */}
      {selectMode && (
        <SelectionBar
          count={selectedIds.size}
          deckOptions={deckOptions}
          moving={bulkMoveMut.isPending}
          pooling={bulkToPoolMut.isPending}
          pausing={bulkPauseMut.isPending}
          progress={bulkProgress ? `${bulkProgress.done}/${bulkProgress.total}…` : null}
          onPause={() => bulkPauseMut.mutate({ ids: Array.from(selectedIds), paused: true })}
          onUnpause={() => bulkPauseMut.mutate({ ids: Array.from(selectedIds), paused: false })}
          onMove={(deck) => bulkMoveMut.mutate({ ids: Array.from(selectedIds), deck })}
          onToPool={() =>
            bulkToPoolMut.mutate(cards.filter((c) => selectedIds.has(c.id as unknown as string)))
          }
          onCancel={() => {
            setSelectMode(false);
            setSelectedIds(new Set());
          }}
        />
      )}

      {/* =================== 4 stat tiles =================== */}
      <div
        className="grid"
        style={{
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: '14px',
          marginBottom: '24px',
        }}
      >
        <StatTile label={t('cards.stat.totalCards')} value={stats.total} />
        <StatTile
          label={t('cards.stat.dueToday')}
          value={stats.due}
          dot="var(--ls-risk)"
          dotStyle="solid"
        />
        {/* 圆点统一案 三次裁定 (实机截图复核, 2026-07-22): "Need a revisit"
            早前两版都在纠结环/尺寸，这次把颜色语义本身翻了案 —— 复习中
            碰到的弱项不是"风险/危险"(--ls-risk 红，那个色现在只留给真正的
            危险态：逾期/暂停一类)，是"学习者还在这条学习路径上，还没巩固"，
            跟 Learning 半实心点、declaredBadge 的琥珀是同一个"进行中"家族。
            改实心琥珀点 (--ls-hypothesis)，尺寸仍是 TILE 家族的 7px，不跟
            旁边三个 tile 的点不同高矮 (TILE 家族固定 7px, 不套用 StateDot
            的 ROW_DOT_DIAMETER —— 见本文件 StatTile 组件内联的圆点实现). */}
        <StatTile
          label={t('cards.stat.needRevisit')}
          value={stats.weak}
          dot="var(--ls-hypothesis)"
          dotStyle="solid"
        />
        <StatTile
          label={t('cards.stat.mastered')}
          value={stats.mastered}
          dot="var(--ls-corroborated)"
          dotStyle="solid"
        />
      </div>

      {/* =================== Scope tree + list (v3 two-column IA) =================== */}
      <div className="flex" style={{ gap: '24px', alignItems: 'flex-start' }}>
      <ScopeTree
        courseNodes={tree.courseNodes}
        independentCount={tree.independentCount}
        unresolvedCount={tree.unresolvedCount}
        independentDecks={independentDecks}
        totalCount={cards.length}
        scope={scope}
        onScope={setScope}
      />
      <div className="flex-1 min-w-0">
      {/* =================== Toolbar: search + state chips + sort =================== */}
      <div
        className="flex items-center flex-wrap"
        style={{ gap: '12px', marginBottom: '14px' }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('cards.searchPlaceholder')}
          className="flex-1 min-w-[180px] bg-[var(--ls-bg)] text-[var(--ls-text)] focus:outline-none"
          style={{
            height: '34px',
            padding: '0 12px',
            border: '1px solid var(--ls-border)',
            borderRadius: '6px',
            fontSize: '13px',
            lineHeight: '1',
          }}
        />
        <div className="flex flex-wrap" style={{ gap: '8px' }}>
          <FilterChip
            label={t('cards.filter.all')}
            count={scopeCounts.all}
            active={filter === 'all'}
            onClick={() => setFilter('all')}
          />
          <FilterChip
            label={t('cards.filter.due')}
            count={scopeCounts.due}
            active={filter === 'due'}
            onClick={() => setFilter(filter === 'due' ? 'all' : 'due')}
          />
          <FilterChip
            label={t('cards.paused')}
            count={scopeCounts.paused}
            active={filter === 'paused'}
            onClick={() => setFilter(filter === 'paused' ? 'all' : 'paused')}
          />
          <FilterChip
            label={t('cards.filter.rest')}
            count={scopeCounts.rest}
            active={filter === 'rest'}
            onClick={() => setFilter(filter === 'rest' ? 'all' : 'rest')}
          />
        </div>
        <label className="flex items-center" style={{ gap: '6px' }}>
          <span
            className="text-[var(--ls-text-tertiary)]"
            style={{ fontSize: '12px', lineHeight: '18px' }}
          >
            {t('cards.sortLabel')}
          </span>
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="bg-[var(--ls-bg)] text-[var(--ls-text)] focus:outline-none"
            style={{ ...fieldInputStyle, width: 'auto', fontSize: '12px' }}
          >
            <option value="due">{t('cards.sort.due')}</option>
            <option value="lesson">{t('cards.sort.lesson')}</option>
            <option value="created">{t('cards.sort.created')}</option>
          </select>
        </label>
      </div>

      {/* =================== Scope header: label · count · select-all · Review N =================== */}
      <div
        className="flex items-center flex-wrap"
        style={{ gap: '12px', marginBottom: '10px' }}
      >
        <span className="font-semibold" style={{ fontSize: '14px', lineHeight: '20px' }}>
          {scopeLabel}
        </span>
        <span
          className="text-[var(--ls-text-tertiary)] tabular-nums"
          style={{ fontSize: '12px', lineHeight: '16px' }}
        >
          {visibleCards.length}{t('cards.cardsCountSuffix')}
        </span>
        {/* 未激活 N 张 (激活门, 迁移 0045) — 纯说明, 不是筛选器: 点不动、
            不改列表。当前范围里有多少张卡还在等它们那节课被学完。 */}
        {scopeCounts.dormant > 0 && (
          <span
            className="text-[var(--ls-text-tertiary)] tabular-nums"
            title={t('cards.dormantTitle')}
            style={{ fontSize: '12px', lineHeight: '16px' }}
          >
            {t('cards.dormantPrefix')}{scopeCounts.dormant}{t('cards.dormantSuffix')}
          </span>
        )}
        {selectMode && visibleCards.length > 0 && (
          <button
            type="button"
            onClick={() =>
              setSelectedIds(new Set(visibleCards.map((c) => c.id as unknown as string)))
            }
            className="text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)] transition-colors duration-[var(--ls-duration-fast)]"
            style={{ fontSize: '12px', fontWeight: 500 }}
          >
            {t('cards.selectAllPrefix')}{visibleCards.length}{t('cards.selectAllSuffix')}
          </button>
        )}
        {scopeReviewTo && (
          <Link
            to={scopeReviewTo}
            title={t('cards.scopeReviewTitle')}
            className="inline-flex items-center"
            style={{
              marginLeft: 'auto',
              height: '30px',
              padding: '0 13px',
              borderRadius: '6px',
              background: scopeCounts.due > 0 ? 'var(--ls-text)' : 'var(--ls-panel)',
              color: scopeCounts.due > 0 ? 'var(--ls-bg)' : 'var(--ls-text-tertiary)',
              fontWeight: 500,
              fontSize: '12px',
              lineHeight: '1',
            }}
          >
            {t('cards.scopeReviewPrefix')}{scopeCounts.due}{t('cards.scopeReviewSuffix')}
          </Link>
        )}
      </div>

      {/* =================== Empty + Loading =================== */}
      {allQ.isLoading && (
        <p className="text-sm text-[var(--ls-text-tertiary)]">{t('cards.loading')}</p>
      )}
      {!allQ.isLoading && cards.length === 0 && (
        <EmptyCardsState />
      )}
      {!allQ.isLoading && cards.length > 0 && visibleCards.length === 0 && (
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
          {t('cards.noMatchFilter')}
        </div>
      )}

      {/* =================== Rows (windowed via content-visibility) =================== */}
      {!allQ.isLoading && visibleCards.length > 0 && (
        <div
          style={{
            border: '1px solid var(--ls-border)',
            borderRadius: '8px',
            overflow: 'hidden',
          }}
        >
          {visibleCards.map((c) => {
            const cardKey = c.id as unknown as string;
            return (
              <CardRow
                key={c.id}
                card={c}
                nowMs={nowMs}
                open={openCard === cardKey}
                onToggle={() =>
                  setOpenCard((prev) => (prev === cardKey ? null : cardKey))
                }
                onPause={() =>
                  pauseMut.mutate({ id: c.id, paused: !c.paused })
                }
                onActivation={isIndependentCard(c)
                  ? () => activationMut.mutate({ id: c.id, activated: !isActiveCard(c) }) : undefined}
                activationPending={activationMut.isPending}
                onReset={() => resetMut.mutate(c.id)}
                onDelete={() => deleteMut.mutate(c.id)}
                selectMode={selectMode}
                selected={selectedIds.has(cardKey)}
                onToggleSelect={() => {
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(cardKey)) next.delete(cardKey);
                    else next.add(cardKey);
                    return next;
                  });
                }}
                pooled={pooledFlashcardIds.has(cardKey)}
                toPoolPending={
                  toPoolMut.isPending &&
                  (toPoolMut.variables?.id as unknown as string) === cardKey
                }
                onToPool={() => toPoolMut.mutate(c)}
              />
            );
          })}
        </div>
      )}
      </div>
      </div>

      {/* =================== Markdown import modal (2026-07-08 定案) =================== */}
      {importOpen && importRepo && pairId && (
        <FlashcardImportModal
          repo={importRepo}
          pairId={pairId}
          onClose={() => setImportOpen(false)}
          onImported={(summary) => {
            invalidateAll();
            setImportOpen(false);
            setToast(summarizeImportToast(summary, t, lang));
          }}
        />
      )}

      {/* =================== Import toast =================== */}
      {toast && (
        <div
          role="status"
          style={{
            position: 'fixed',
            bottom: '24px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--ls-text)',
            color: 'var(--ls-bg)',
            padding: '10px 18px',
            borderRadius: '8px',
            fontSize: '13px',
            fontWeight: 500,
            zIndex: 60,
            boxShadow: '0 12px 28px -8px rgba(0,0,0,0.35)',
            maxWidth: '440px',
            textAlign: 'center',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatTile({
  label,
  value,
  dot,
  dotStyle,
}: {
  label: string;
  value: number | string;
  dot?: string;
  dotStyle?: 'solid' | 'ring';
}) {
  return (
    <div
      style={{
        border: '1px solid var(--ls-border)',
        borderRadius: '8px',
        padding: '16px 18px',
      }}
    >
      <div className="flex items-center" style={{ gap: '8px' }}>
        {/* "Need a revisit" 的颜色裁定见下方调用处的圆点统一案 注 —— 这里只
            管画圆本身: TILE 家族固定 7px, 跟 ROW 家族的 ../components/
            StateDot (ROW_DOT_DIAMETER) 是两把不互相干扰的尺, 故意不复用
            那个组件, 保持本文件内联画圆。 */}
        {dot &&
          (dotStyle === 'ring' ? (
            <span
              style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                border: `0.5px solid ${dot}`, // 发丝线裁决 7/22
                boxSizing: 'border-box',
              }}
            />
          ) : (
            <span
              style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: dot,
              }}
            />
          ))}
        <span
          className="font-semibold tabular-nums"
          style={{ fontSize: '24px', lineHeight: '28px', letterSpacing: '-0.02em' }}
        >
          {value}
        </span>
      </div>
      <div
        className="text-[var(--ls-text-secondary)]"
        style={{ fontSize: '12px', lineHeight: '16px', marginTop: '4px' }}
      >
        {label}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center transition-colors duration-[var(--ls-duration-fast)]"
      style={{
        gap: '6px',
        height: '34px',
        padding: '0 13px',
        border: `1px solid ${active ? 'var(--ls-text)' : 'var(--ls-border)'}`,
        borderRadius: '999px',
        fontWeight: 500,
        fontSize: '12px',
        lineHeight: '1',
        color: active ? 'var(--ls-text)' : 'var(--ls-text-secondary)',
        background: active ? 'var(--ls-panel)' : 'transparent',
        cursor: 'pointer',
      }}
    >
      {label}{' '}
      <span style={{ color: 'var(--ls-text-tertiary)' }} className="tabular-nums">
        {count}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// ScopeTree — the left course → lesson scope rail (v3 IA). Visual and
// interaction vocabulary borrowed from review/DeckRail.tsx (same ▸ rotate
// caret, Set-of-open-keys accordion, 行体点击扩区案's row-body select+expand double
// duty, sticky bordered column) — no new furniture. Selection scopes the
// right-hand list; the quiet per-node "Review N" links carry the honest
// scope param into /review (?course= / ?lesson=). The Ungrouped bucket has
// no honest param, so it gets no review link (入口主权条款: never bare all-due
// from a scoped context).
// ---------------------------------------------------------------------------

function ScopeTree({
  courseNodes,
  independentCount,
  unresolvedCount,
  independentDecks,
  totalCount,
  scope,
  onScope,
}: {
  courseNodes: Array<{
    courseId: string;
    topic: string;
    count: number;
    due: number;
    lessons: Array<{ lessonId: string; title: string; count: number; due: number }>;
  }>;
  independentCount: number;
  unresolvedCount: number;
  independentDecks: Array<{ id: string; count: number }>;
  totalCount: number;
  scope: Scope;
  onScope: (s: Scope) => void;
}) {
  const { t } = useT();
  const [openCourses, setOpenCourses] = useState<ReadonlySet<string>>(new Set());
  const toggleCourseOpen = (courseId: string) =>
    setOpenCourses((prev) => {
      const next = new Set(prev);
      if (next.has(courseId)) next.delete(courseId);
      else next.add(courseId);
      return next;
    });
  // DeckRail 行体点击扩区案's row-body double duty: selecting a course also opens its
  // lesson list; re-clicking an already-selected course toggles open/closed.
  const selectCourseRow = (courseId: string) => {
    if (scope.kind === 'course' && scope.id === courseId) {
      toggleCourseOpen(courseId);
      return;
    }
    onScope({ kind: 'course', id: courseId });
    setOpenCourses((prev) => {
      if (prev.has(courseId)) return prev;
      const next = new Set(prev);
      next.add(courseId);
      return next;
    });
  };

  return (
    <aside
      className="flex-none border border-[var(--ls-border)]"
      style={{
        width: '230px',
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
        className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--ls-text-tertiary)]"
        style={{ marginBottom: '10px', padding: '0 6px' }}
      >
        {t('cards.tree.heading')}
      </div>
      <ul className="flex flex-col" style={{ gap: '2px' }}>
        <TreeLeafRow
          label={t('cards.tree.allCards')}
          count={totalCount}
          selected={scope.kind === 'all'}
          onClick={() => onScope({ kind: 'all' })}
        />
        {courseNodes.map((course) => {
          const courseOpen = openCourses.has(course.courseId);
          const courseSelected = scope.kind === 'course' && scope.id === course.courseId;
          return (
            <li key={course.courseId}>
              <div
                className={`w-full flex items-center rounded-[var(--ls-radius-control)] transition-colors duration-[var(--ls-duration-fast)] ${
                  courseSelected
                    ? 'bg-[var(--ls-panel)] text-[var(--ls-text)]'
                    : 'text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => toggleCourseOpen(course.courseId)}
                  className="flex-none text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors"
                  style={{ padding: '7px 0 7px 6px', lineHeight: '1', fontSize: '10px' }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      transform: courseOpen ? 'rotate(90deg)' : 'none',
                      transition: 'transform var(--ls-duration-fast)',
                    }}
                  >
                    ▸
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => selectCourseRow(course.courseId)}
                  className="flex items-center justify-between flex-1 min-w-0"
                  style={{ padding: '7px 6px', gap: '8px' }}
                >
                  <span
                    className="text-[13px] leading-5 font-semibold truncate text-left flex-1 min-w-0"
                    title={course.topic}
                  >
                    {course.topic}
                  </span>
                  <span className="flex-none text-[11px] leading-4 text-[var(--ls-text-tertiary)] tabular-nums">
                    {course.count}
                  </span>
                </button>
                <NodeReviewLink
                  to={`/review?course=${encodeURIComponent(course.courseId)}`}
                  due={course.due}
                />
              </div>
              {courseOpen && (
                <ul
                  className="flex flex-col"
                  style={{ gap: '2px', margin: '2px 0 4px', paddingLeft: '10px' }}
                >
                  {course.lessons.map((lesson) => {
                    const lessonSelected =
                      scope.kind === 'lesson' && scope.id === lesson.lessonId;
                    return (
                      <li key={lesson.lessonId}>
                        <div
                          className={`w-full flex items-center rounded-[var(--ls-radius-control)] transition-colors duration-[var(--ls-duration-fast)] ${
                            lessonSelected
                              ? 'bg-[var(--ls-panel)] text-[var(--ls-text)]'
                              : 'text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)]'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              onScope({ kind: 'lesson', id: lesson.lessonId })
                            }
                            className="flex items-center justify-between flex-1 min-w-0"
                            style={{ padding: '6px 6px 6px 10px', gap: '8px' }}
                          >
                            <span
                              className="text-[12px] leading-[18px] font-medium truncate text-left flex-1 min-w-0"
                              title={lesson.title}
                            >
                              {lesson.title}
                            </span>
                            <span className="flex-none text-[11px] leading-4 text-[var(--ls-text-tertiary)] tabular-nums">
                              {lesson.count}
                            </span>
                          </button>
                          <NodeReviewLink
                            to={`/review?lesson=${encodeURIComponent(lesson.lessonId)}`}
                            due={lesson.due}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
        {independentCount > 0 && (
          <li>
            <div className="text-[11px] text-[var(--ls-text-tertiary)]" style={{ padding: '12px 6px 6px' }}>
              {t('cards.tree.independent')}
            </div>
            <ul>
              {independentDecks.map((deck) => (
                <TreeLeafRow key={deck.id} label={deck.id} count={deck.count}
                  selected={scope.kind === 'independent-deck' && scope.id === deck.id}
                  onClick={() => onScope({ kind: 'independent-deck', id: deck.id })} />
              ))}
            </ul>
          </li>
        )}
        {unresolvedCount > 0 && (
          <TreeLeafRow
            label={t('cards.tree.unresolved')}
            count={unresolvedCount}
            selected={scope.kind === 'unresolved'}
            onClick={() => onScope({ kind: 'unresolved' })}
          />
        )}
      </ul>
    </aside>
  );
}

// Same species as DeckRail's DeckRow — a flat selectable leaf (All cards /
// Ungrouped).
function TreeLeafRow({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`w-full flex items-center justify-between rounded-[var(--ls-radius-control)] transition-colors duration-[var(--ls-duration-fast)] ${
          selected
            ? 'bg-[var(--ls-panel)] text-[var(--ls-text)]'
            : 'text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)]'
        }`}
        style={{ padding: '7px 10px', gap: '8px' }}
      >
        <span className="text-[13px] leading-5 font-medium truncate text-left flex-1 min-w-0">
          {label}
        </span>
        <span className="flex-none text-[11px] leading-4 text-[var(--ls-text-tertiary)] tabular-nums">
          {count}
        </span>
      </button>
    </li>
  );
}

// Quiet per-node review deep link — renders only when the node has due
// cards; tertiary until hover, same visual weight as DeckRail's carets.
function NodeReviewLink({ to, due }: { to: string; due: number }) {
  const { t } = useT();
  if (due === 0) return null;
  return (
    <Link
      to={to}
      title={t('cards.nodeReviewTitle')}
      className="flex-none text-[10px] leading-4 text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors tabular-nums"
      style={{ padding: '7px 8px 7px 2px', whiteSpace: 'nowrap' }}
    >
      {t('cards.scopeReviewPrefix')}{due}
    </Link>
  );
}

// Selection action bar — select-mode's "N selected" readout + bulk
// Pause/Resume (v3, PATCH paused per card) + Move to deck (dropdown reuses
// the same New-deck-sentinel interaction as AddCardPanel's deck select) +
// bulk To pool. Owns its own target-deck / new-deck-mode state (mirrors
// AddCardPanel — same reason: an outer auto-prefill effect would stomp on
// a freshly-entered new deck name). `progress` is the shared n/N counter
// for whichever bulk batch is in flight.
function SelectionBar({
  count,
  deckOptions,
  moving,
  pooling,
  pausing,
  progress,
  onPause,
  onUnpause,
  onMove,
  onToPool,
  onCancel,
}: {
  count: number;
  deckOptions: string[];
  moving: boolean;
  pooling: boolean;
  pausing: boolean;
  progress: string | null;
  onPause: () => void;
  onUnpause: () => void;
  onMove: (deck: string) => void;
  onToPool: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [deck, setDeck] = useState(deckOptions[0] ?? '');
  const [newDeckMode, setNewDeckMode] = useState(false);

  useEffect(() => {
    if (newDeckMode || deck || deckOptions.length === 0) return;
    setDeck(deckOptions[0]!);
  }, [newDeckMode, deck, deckOptions]);

  const canMove = count > 0 && deck.trim().length > 0 && !moving;
  const canPool = count > 0 && !pooling;
  const canPauseOps = count > 0 && !pausing;

  return (
    <div
      className="flex items-center flex-wrap"
      style={{
        gap: '12px',
        border: '1px solid var(--ls-border-strong)',
        borderRadius: '8px',
        padding: '10px 14px',
        marginBottom: '18px',
        background: 'var(--ls-panel)',
      }}
    >
      <span className="font-medium tabular-nums" style={{ fontSize: '13px' }}>
        {count}{t('cards.selectedCountSuffix')}
      </span>
      <div className="flex items-center" style={{ gap: '8px' }}>
        <RowButton onClick={onPause} disabled={!canPauseOps}>
          {t('cards.bulkPause')}
        </RowButton>
        <RowButton onClick={onUnpause} disabled={!canPauseOps}>
          {t('cards.bulkResume')}
        </RowButton>
      </div>
      {progress && (
        <span
          className="text-[var(--ls-text-tertiary)] tabular-nums"
          style={{ fontSize: '12px' }}
        >
          {progress}
        </span>
      )}
      <div className="flex items-center" style={{ gap: '8px' }}>
        {deckOptions.length === 0 || newDeckMode ? (
          <div className="flex items-center" style={{ gap: '6px' }}>
            <input
              type="text"
              value={deck}
              onChange={(e) => setDeck(e.target.value)}
              placeholder={t('journal.notes.deckPlaceholder')}
              className="bg-[var(--ls-bg)] text-[var(--ls-text)] focus:outline-none"
              style={{ ...fieldInputStyle, height: '30px', width: '170px' }}
            />
            {deckOptions.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setNewDeckMode(false);
                  setDeck(deckOptions[0]!);
                }}
                className="text-[10px] uppercase tracking-[0.08em] font-medium text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] leading-none"
                style={{ flexShrink: 0 }}
              >
                {t('cards.existingButton')}
              </button>
            )}
          </div>
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
            className="bg-[var(--ls-bg)] text-[var(--ls-text)] focus:outline-none"
            style={{ ...fieldInputStyle, height: '30px', width: '170px' }}
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
          onClick={() => onMove(deck.trim())}
          disabled={!canMove}
          className="inline-flex items-center disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            height: '30px',
            padding: '0 13px',
            borderRadius: '6px',
            background: 'var(--ls-text)',
            color: 'var(--ls-bg)',
            fontWeight: 500,
            fontSize: '12px',
            lineHeight: '1',
            cursor: canMove ? 'pointer' : 'not-allowed',
          }}
        >
          {moving ? t('cards.moving') : t('cards.moveToDeck')}
        </button>
      </div>
      <RowButton onClick={onToPool} disabled={!canPool}>
        {pooling ? t('cards.adding') : t('annotation.toPool')}
      </RowButton>
      <button
        type="button"
        onClick={onCancel}
        className="text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
        style={{ marginLeft: 'auto', fontSize: '12px', fontWeight: 500 }}
      >
        {t('cards.cancel')}
      </button>
    </div>
  );
}

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col" style={{ gap: '6px' }}>
      <span
        className="text-[var(--ls-text-tertiary)]"
        style={{
          fontSize: '11px',
          lineHeight: '14px',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function AddCardPanel({
  front,
  back,
  deck,
  concept,
  deckOptions,
  newDeckMode,
  onNewDeckModeChange,
  pending,
  error,
  onFrontChange,
  onBackChange,
  onDeckChange,
  onConceptChange,
  onCancel,
  onSubmit,
}: {
  front: string;
  back: string;
  deck: string;
  concept: string;
  deckOptions: string[];
  newDeckMode: boolean;
  onNewDeckModeChange: (v: boolean) => void;
  pending: boolean;
  error: boolean;
  onFrontChange: (v: string) => void;
  onBackChange: (v: string) => void;
  onDeckChange: (v: string) => void;
  onConceptChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useT();
  const canSubmit =
    front.trim().length > 0 && back.trim().length > 0 && deck.length > 0 && !pending;

  return (
    <div
      style={{
        border: '1px solid var(--ls-border)',
        borderRadius: '8px',
        padding: '16px 18px',
        marginBottom: '24px',
      }}
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '12px',
          marginBottom: '12px',
        }}
      >
        <FormField label={t('cards.front')}>
          <input
            type="text"
            value={front}
            onChange={(e) => onFrontChange(e.target.value)}
            placeholder={t('cards.termQuestionPlaceholder')}
            className="bg-[var(--ls-bg)] text-[var(--ls-text)] focus:outline-none"
            style={fieldInputStyle}
          />
        </FormField>
        <FormField label={t('cards.courseDeck')}>
          {/* 新建卡组哨兵项 — zero-deck fallback: with no existing deck_id to
              populate the dropdown (brand-new pair, or the deck-list fix hasn't
              synced yet), fall back to a free-text field so the form
              never locks up. Reuses the same addDeck state/setter as the
              select below — no extra state needed. */}
          {deckOptions.length === 0 || newDeckMode ? (
            <div className="flex items-center" style={{ gap: '8px' }}>
              <input
                type="text"
                value={deck}
                onChange={(e) => onDeckChange(e.target.value)}
                placeholder={t('journal.notes.deckPlaceholder')}
                className="bg-[var(--ls-bg)] text-[var(--ls-text)] focus:outline-none"
                style={fieldInputStyle}
              />
              {deckOptions.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onNewDeckModeChange(false);
                    onDeckChange(deckOptions[0]!);
                  }}
                  className="text-[10px] uppercase tracking-[0.08em] font-medium text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] leading-none"
                  style={{ flexShrink: 0 }}
                >
                  {t('cards.existingButton')}
                </button>
              )}
            </div>
          ) : (
            <select
              value={deck}
              onChange={(e) => {
                if (e.target.value === NEW_DECK_SENTINEL) {
                  onNewDeckModeChange(true);
                  onDeckChange('');
                } else {
                  onDeckChange(e.target.value);
                }
              }}
              className="bg-[var(--ls-bg)] text-[var(--ls-text)] focus:outline-none"
              style={fieldInputStyle}
            >
              {deckOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
              <option value={NEW_DECK_SENTINEL}>{t('journal.notes.newDeckOption')}</option>
            </select>
          )}
        </FormField>
      </div>
      <div style={{ marginBottom: '12px' }}>
        <FormField label={t('cards.back')}>
          <textarea
            value={back}
            onChange={(e) => onBackChange(e.target.value)}
            placeholder={t('cards.definitionAnswerPlaceholder')}
            rows={2}
            className="bg-[var(--ls-bg)] text-[var(--ls-text)] focus:outline-none"
            style={{ ...fieldInputStyle, height: 'auto', padding: '8px 12px', resize: 'vertical' }}
          />
        </FormField>
      </div>
      <div className="flex flex-wrap items-end" style={{ gap: '12px' }}>
        <div style={{ flex: '1 1 200px' }}>
          <FormField label={t('cards.conceptOptional')}>
            <input
              type="text"
              value={concept}
              onChange={(e) => onConceptChange(e.target.value)}
              placeholder={t('cards.conceptIdPlaceholder')}
              className="bg-[var(--ls-bg)] text-[var(--ls-text)] focus:outline-none"
              style={fieldInputStyle}
            />
          </FormField>
        </div>
        <div className="flex" style={{ gap: '8px' }}>
          <RowButton onClick={onCancel}>{t('cards.cancel')}</RowButton>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="inline-flex items-center disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              height: '30px',
              padding: '0 14px',
              borderRadius: '6px',
              background: 'var(--ls-text)',
              color: 'var(--ls-bg)',
              fontWeight: 500,
              fontSize: '12px',
              lineHeight: '1',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            {pending ? t('cards.adding') : t('cards.addCardSubmit')}
          </button>
        </div>
      </div>
      {deckOptions.length === 0 && (
        <div
          className="text-[var(--ls-text-tertiary)]"
          style={{ fontSize: '11px', marginTop: '10px' }}
        >
          {t('cards.noDecksNameHint')}
        </div>
      )}
      {error && (
        <div style={{ fontSize: '11px', marginTop: '10px', color: 'var(--ls-risk)' }}>
          {t('cards.createFailed')}
        </div>
      )}
    </div>
  );
}

function CardRow({
  card,
  nowMs,
  open,
  onToggle,
  onPause,
  onActivation,
  activationPending,
  onReset,
  onDelete,
  selectMode,
  selected,
  onToggleSelect,
  pooled,
  toPoolPending,
  onToPool,
}: {
  card: Flashcard;
  nowMs: number;
  open: boolean;
  onToggle: () => void;
  onPause: () => void;
  onActivation?: () => void;
  activationPending: boolean;
  onReset: () => void;
  onDelete: () => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  pooled: boolean;
  toPoolPending: boolean;
  onToPool: () => void;
}) {
  const { t } = useT();
  const dot = dotForCard(card);
  const state: CardState | 'Suspended' = card.paused ? 'Suspended' : cardState(card);
  const stateLabel = t(STATE_LABEL_KEY[state]);
  const due = formatDue(card, nowMs);
  const deckKey = card.deck_id as unknown as string;

  // 就地确认删除控件 — inline two-stage confirm for Reset/Delete (replaces window.confirm,
  // which hangs browser automation). Same pattern as AnnotationOverlay's
  // confirmingDelete / AdHocPanel's MessageDeleteControl: the action button
  // swaps in-place for a Confirm/Cancel pair, no separate dialog.
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    if (!open) {
      setConfirmingReset(false);
      setConfirmingDelete(false);
    }
  }, [open]);

  return (
    <div style={{ borderBottom: '1px solid var(--ls-border)', ...rowWindowStyle }}>
      <div
        className="w-full flex items-center hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
        style={{ gap: '14px', padding: '13px 16px' }}
      >
        {selectMode && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`${t('cards.selectCardAriaPrefix')}${card.front}`}
            style={{ flex: '0 0 auto', width: '14px', height: '14px', cursor: 'pointer' }}
          />
        )}
        <button
          type="button"
          onClick={onToggle}
          className="flex-1 min-w-0 flex items-center text-left"
          style={{ gap: '14px' }}
        >
          <span
            style={{
              flex: '0 0 auto',
              width: '14px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {dot.kind === 'icon' ? (
              <span style={{ color: dot.color, fontSize: '13px', lineHeight: 1 }}>
                {dot.glyph}
              </span>
            ) : (
              <StateDot shape={dot.shape} color={dot.color} />
            )}
          </span>
          <span
            className="flex-1 min-w-0 truncate"
            style={{ fontSize: '14px', lineHeight: '20px' }}
          >
            {card.front}
          </span>
        </button>
        {/* Deck chip — deep link into the deck-scoped review queue
            (/review?deck=, JOB 1): a review entry from a deck context
            lands deck-scoped, never on all-due's first card (入口主权条款). */}
        <Link
          to={`/review?deck=${encodeURIComponent(deckKey)}`}
          title={t('cards.deckChipTitle')}
          className="flex-none text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
          style={{
            padding: '2px 8px',
            border: '1px solid var(--ls-border)',
            borderRadius: '999px',
            fontSize: '11px',
            lineHeight: '14px',
            whiteSpace: 'nowrap',
            maxWidth: '160px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {deckKey}
        </Link>
        {/* Due / paused chip — the one glanceable state signal per row
            (the dot already carries learning-state; stateLabel lives in
            the expanded panel). */}
        <span
          className="flex-none tabular-nums"
          style={{
            padding: '2px 8px',
            border: '1px solid var(--ls-border)',
            borderRadius: '999px',
            fontSize: '11px',
            lineHeight: '14px',
            whiteSpace: 'nowrap',
            color: card.paused ? 'var(--ls-text-tertiary)' : due.color,
          }}
        >
          {card.source_status === 'unresolved'
            ? t('cards.sourceUnresolved')
            : !isActiveCard(card)
              ? t('cards.notInReview')
              : card.paused ? t('cards.state.suspended') : due.label}
        </span>
        <button
          type="button"
          onClick={onToggle}
          className="flex-none text-[var(--ls-text-tertiary)]"
          style={{
            fontSize: '10px',
            padding: '2px',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          }}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'}
        </button>
      </div>
      {open && (
        <div
          style={{ padding: '2px 16px 18px 44px' }}
          className="border-t border-[var(--ls-border)]"
        >
          <div
            className="text-[var(--ls-text-secondary)]"
            style={{
              fontSize: '14px',
              lineHeight: '22px',
              marginTop: '10px',
              marginBottom: '14px',
              whiteSpace: 'pre-wrap',
            }}
          >
            {card.back}
          </div>
          {/* FSRS readout (Task 2) — compact, tertiary, one row, no charts. */}
          <div
            className="flex flex-wrap text-[var(--ls-text-tertiary)]"
            style={{
              gap: '16px',
              fontSize: '11px',
              lineHeight: '16px',
              marginBottom: '8px',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            <span>{t('cards.fsrs.state')} {stateLabel}</span>
            <span>{t('cards.fsrs.due')} {due.label}</span>
            <span>{t('cards.fsrs.stability')} {Math.round(card.fsrs_state.stability)}d</span>
            <span>
              {t('cards.fsrs.retrievability')} {Math.round(card.fsrs_state.retrievability * 100)}%
            </span>
            <span>{t('cards.fsrs.reviews')} {card.fsrs_state.review_count}</span>
          </div>
          <div
            className="flex flex-wrap text-[var(--ls-text-tertiary)]"
            style={{
              gap: '20px',
              fontSize: '12px',
              lineHeight: '18px',
              marginBottom: '14px',
            }}
          >
            <span>
              {t('cards.fsrs.interval')} {Math.max(1, Math.round(card.fsrs_state.stability))}d
            </span>
            <span>
              {card.fsrs_state.review_count}{t('cards.fsrs.repsSuffix')} · R≈
              {Math.round(card.fsrs_state.retrievability * 100)}%
            </span>
            <span>{t('cards.fsrs.deckLabel')} {card.deck_id}</span>
          </div>
          <div className="flex flex-wrap items-center" style={{ gap: '8px' }}>
            {onActivation && (
              <RowButton onClick={onActivation} disabled={activationPending}>
                {isActiveCard(card) ? t('cards.leaveReview') : t('cards.joinReview')}
              </RowButton>
            )}
            <RowButton onClick={onPause}>
              {card.paused ? t('cards.resume') : t('cards.suspend')}
            </RowButton>
            {confirmingReset ? (
              <span className="inline-flex items-center" style={{ gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => {
                    onReset();
                    setConfirmingReset(false);
                  }}
                  title={t('cards.confirmResetFsrs')}
                  className="text-[12px] font-medium"
                  style={{ color: 'var(--ls-risk)' }}
                >
                  {t('cards.confirmReset')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingReset(false)}
                  className="text-[12px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
                >
                  {t('cards.cancel')}
                </button>
              </span>
            ) : (
              <RowButton onClick={() => setConfirmingReset(true)}>{t('cards.resetProgress')}</RowButton>
            )}
            <RowButton onClick={onToPool} disabled={pooled || toPoolPending}>
              {pooled ? t('cards.inPool') : toPoolPending ? t('cards.adding') : t('annotation.toPool')}
            </RowButton>
            {confirmingDelete ? (
              <span className="inline-flex items-center" style={{ gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => {
                    onDelete();
                    setConfirmingDelete(false);
                  }}
                  title={`${t('cards.confirmDeletePrefix')}${card.front}${t('cards.confirmDeleteSuffix')}`}
                  className="text-[12px] font-medium"
                  style={{ color: 'var(--ls-risk)' }}
                >
                  {t('cards.confirmDelete')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="text-[12px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
                >
                  {t('cards.cancel')}
                </button>
              </span>
            ) : (
              <RowButton onClick={() => setConfirmingDelete(true)} danger>
                {t('cards.delete')}
              </RowButton>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RowButton({
  children,
  onClick,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      style={{
        height: '30px',
        padding: '0 12px',
        border: '1px solid var(--ls-border-strong)',
        borderRadius: '6px',
        fontWeight: 500,
        fontSize: '12px',
        lineHeight: '1',
        color: danger ? 'var(--ls-risk)' : undefined,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function EmptyCardsState() {
  const { t } = useT();
  return (
    <div
      className="text-center"
      style={{
        border: '1px solid var(--ls-border)',
        borderRadius: '8px',
        padding: '40px 16px',
      }}
    >
      <p
        className="font-medium"
        style={{ marginBottom: '6px', fontSize: '14px' }}
      >
        {t('cards.noDecksYetEmpty')}
      </p>
      <p
        className="text-[var(--ls-text-tertiary)]"
        style={{ fontSize: '12px', marginBottom: '14px' }}
      >
        {t('cards.emptyHint')}
      </p>
      <Link
        to="/lesson"
        className="inline-flex items-center hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
        style={{
          height: '32px',
          padding: '0 14px',
          border: '1px solid var(--ls-border-strong)',
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: 500,
          lineHeight: '1',
        }}
      >
        {t('cards.goToLessons')}
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown import modal (2026-07-08 定案) — Obsidian `#deck` / `Q:` / `A:`
// plain-text template → dry_run preview → confirm. See
// repository/flashcardImportExt.ts for the shared response shape (1:1 with
// apps/server/src/routes/write.ts's POST /pairs/:pairId/flashcards/import).
// ---------------------------------------------------------------------------

interface ImportTotals {
  newCount: number;
  duplicateCount: number;
  updatedCount: number;
  errorCount: number;
}

function summarizeImport(result: FlashcardImportResult): ImportTotals {
  let newCount = 0;
  let duplicateCount = 0;
  let updatedCount = 0;
  for (const deckResult of Object.values(result.decks)) {
    newCount += deckResult.new.length;
    duplicateCount += deckResult.duplicates.length;
    updatedCount += deckResult.updated.length;
  }
  return { newCount, duplicateCount, updatedCount, errorCount: result.errors.length };
}

// t() has no interpolation — counts are plain numbers stitched around
// localized labels, same "label + separate count" convention the stat tiles
// above already use.
function summarizeImportToast(
  result: FlashcardImportResult,
  t: (key: Parameters<ReturnType<typeof useT>['t']>[0]) => string,
  lang: 'zh' | 'en'
): string {
  const { newCount, duplicateCount, updatedCount, errorCount } = summarizeImport(result);
  const sep = lang === 'zh' ? '· ' : ' · ';
  const parts = [
    `${newCount} ${t('cards.import.summaryNew')}`,
    `${duplicateCount} ${t('cards.import.summaryDuplicate')}`,
    `${updatedCount} ${t('cards.import.summaryUpdated')}`,
  ];
  const base = parts.join(sep);
  return errorCount > 0 ? `${base}${sep}${errorCount} ${t('cards.import.summaryErrors')}` : base;
}

function FlashcardImportModal({
  repo,
  pairId,
  onClose,
  onImported,
}: {
  repo: FlashcardImportRepo;
  pairId: NonNullable<ReturnType<typeof usePair>['pairId']>;
  onClose: () => void;
  onImported: (result: FlashcardImportResult) => void;
}) {
  const { t, lang } = useT();
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<FlashcardImportResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function editContent(next: string) {
    setContent(next);
    // Any edit invalidates the last preview — re-running dry_run is cheap
    // and guarantees Confirm always applies exactly what was last shown.
    setPreview(null);
    setErrorMsg(null);
  }

  async function loadFile(file: File) {
    try {
      const text = await file.text();
      editContent(text);
    } catch {
      setErrorMsg(t('cards.import.fileReadFailed'));
    }
  }

  function onFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void loadFile(file);
    e.target.value = '';
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void loadFile(file);
  }

  async function runPreview() {
    if (!content.trim()) {
      setErrorMsg(t('cards.import.emptyContent'));
      return;
    }
    setPreviewing(true);
    setErrorMsg(null);
    try {
      const res = await repo.importFlashcards({ pair_id: pairId, content, dry_run: true });
      setPreview(res);
    } catch {
      setErrorMsg(t('cards.import.failed'));
    } finally {
      setPreviewing(false);
    }
  }

  async function runConfirm() {
    if (!preview) return;
    setImporting(true);
    setErrorMsg(null);
    try {
      const res = await repo.importFlashcards({ pair_id: pairId, content, dry_run: false });
      onImported(res);
    } catch {
      setErrorMsg(t('cards.import.failed'));
    } finally {
      setImporting(false);
    }
  }

  const totals = preview ? summarizeImport(preview) : null;
  const nothingToApply =
    !!totals && totals.newCount + totals.duplicateCount + totals.updatedCount === 0;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/30 backdrop-blur-[2px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[640px] overflow-y-auto rounded-[var(--ls-radius-panel)] border border-[var(--ls-border)] bg-[var(--ls-bg)] shadow-[0_24px_56px_-12px_rgba(0,0,0,0.25)]"
        style={{ maxHeight: '82vh', padding: '20px 22px' }}
      >
        <div className="flex items-center justify-between" style={{ marginBottom: '4px' }}>
          <h2 style={{ fontSize: '16px', fontWeight: 600, margin: 0 }}>
            {t('cards.import.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
            style={{ fontSize: '18px', lineHeight: '1' }}
            aria-label={t('cards.import.close')}
          >
            &times;
          </button>
        </div>
        <p
          className="text-[var(--ls-text-tertiary)]"
          style={{ fontSize: '12px', lineHeight: '18px', marginBottom: '14px' }}
        >
          {t('cards.import.instructions')}
        </p>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          style={{
            border: `1px dashed ${dragOver ? 'var(--ls-text)' : 'var(--ls-border)'}`,
            borderRadius: '8px',
            padding: '10px',
            transition: 'border-color var(--ls-duration-fast)',
          }}
        >
          <textarea
            value={content}
            onChange={(e) => editContent(e.target.value)}
            placeholder={t('cards.import.textareaPlaceholder')}
            rows={10}
            className="bg-[var(--ls-bg)] text-[var(--ls-text)] focus:outline-none"
            style={{
              width: '100%',
              fontSize: '12.5px',
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              lineHeight: '18px',
              resize: 'vertical',
            }}
          />
          <div
            className="flex items-center justify-between flex-wrap"
            style={{ gap: '8px', marginTop: '8px' }}
          >
            <span
              className="text-[var(--ls-text-tertiary)]"
              style={{ fontSize: '11px' }}
            >
              {t('cards.import.dropHint')}
            </span>
            <RowButton onClick={() => fileRef.current?.click()}>
              {t('cards.import.chooseFile')}
            </RowButton>
            <input
              ref={fileRef}
              type="file"
              accept=".md,text/markdown,text/plain"
              onChange={onFileInputChange}
              style={{ display: 'none' }}
            />
          </div>
        </div>

        {errorMsg && (
          <div style={{ color: 'var(--ls-risk)', fontSize: '12px', marginTop: '10px' }}>
            {errorMsg}
          </div>
        )}

        {preview && (
          <div style={{ marginTop: '16px' }}>
            {Object.keys(preview.decks).length === 0 && preview.errors.length === 0 && (
              <div
                className="text-[var(--ls-text-tertiary)]"
                style={{ fontSize: '12px' }}
              >
                {t('cards.import.noParsedCards')}
              </div>
            )}
            {Object.entries(preview.decks).map(([deck, r]) => (
              <div
                key={deck}
                className="flex items-center justify-between flex-wrap"
                style={{
                  gap: '8px',
                  padding: '8px 0',
                  borderTop: '1px solid var(--ls-border)',
                  fontSize: '13px',
                }}
              >
                <span className="font-medium">
                  {deck}
                  {preview.decks_to_create.includes(deck) && (
                    <span
                      className="text-[var(--ls-text-tertiary)]"
                      style={{ fontSize: '11px', fontWeight: 400, marginLeft: '6px' }}
                    >
                      {t('cards.import.willCreateSuffix')}
                    </span>
                  )}
                </span>
                <span
                  className="text-[var(--ls-text-secondary)] tabular-nums"
                  style={{ fontSize: '12px' }}
                >
                  {r.new.length} {t('cards.import.summaryNew')} · {r.duplicates.length}{' '}
                  {t('cards.import.summaryDuplicate')} · {r.updated.length}{' '}
                  {t('cards.import.summaryUpdated')}
                </span>
              </div>
            ))}
            {preview.errors.length > 0 && (
              <div style={{ marginTop: '10px' }}>
                <div
                  style={{ fontSize: '12px', fontWeight: 500, color: 'var(--ls-risk)' }}
                >
                  {t('cards.import.errorsHeading')} ({preview.errors.length})
                </div>
                <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
                  {preview.errors.map((e, i) => (
                    <li
                      key={i}
                      className="text-[var(--ls-text-secondary)]"
                      style={{ fontSize: '12px', lineHeight: '18px' }}
                    >
                      {lang === 'zh' ? `第 ${e.line} 行` : `Line ${e.line}`} — {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div
          className="flex items-center justify-end"
          style={{ gap: '8px', marginTop: '18px' }}
        >
          <RowButton onClick={onClose}>{t('cards.cancel')}</RowButton>
          {!preview ? (
            <button
              type="button"
              onClick={() => void runPreview()}
              disabled={previewing || !content.trim()}
              className="inline-flex items-center disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                height: '30px',
                padding: '0 14px',
                borderRadius: '6px',
                background: 'var(--ls-text)',
                color: 'var(--ls-bg)',
                fontWeight: 500,
                fontSize: '12px',
                lineHeight: '1',
              }}
            >
              {previewing ? t('cards.import.previewing') : t('cards.import.preview')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void runConfirm()}
              disabled={importing || nothingToApply}
              className="inline-flex items-center disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                height: '30px',
                padding: '0 14px',
                borderRadius: '6px',
                background: 'var(--ls-text)',
                color: 'var(--ls-bg)',
                fontWeight: 500,
                fontSize: '12px',
                lineHeight: '1',
              }}
            >
              {importing ? t('cards.import.importing') : t('cards.import.confirm')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
