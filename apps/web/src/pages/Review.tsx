import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHotkeys } from 'react-hotkeys-hook';
import { Link, useSearchParams } from 'react-router-dom';
import type { Flashcard } from '@learn-shell/contracts';
import { UNGROUPED_COURSE_KEY } from '../review/DeckRail';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';
import { useT } from '../i18n';
import { preloadWhisper, transcribeBlob } from '../lib/whisper';
import { focusOverlayStyle, FocusToggleButton } from '../shell/FocusOverlay';
import { FlipCard, usePrefersReducedMotion } from '../shell/FlipCard';
import { DeckRail } from '../review/DeckRail';
import { RecordingBeads, RECORDING_BEADS_FFT_SIZE } from '../review/RecordingBeads';

/**
 * Review — Feynman-mode flashcard drilling.
 *
 * Voice path (2026-07-01 rebuild, post the "real-time text pulls
 * attention onto correction" verdict):
 *   V begins a recording · V again pauses · V once more resumes ·
 *   Space (reveal) or nav flushes and transcribes.
 *
 *   Nothing appears in the textarea while recording — the mic just shows
 *   a live "bead oscilloscope" (see review/RecordingBeads.tsx, 示波器案)
 *   so the speaker knows they're being heard. When recording stops, the beads settle
 *   back to their resting row (no freeze-frame); the mic hint text carries
 *   the "· Ns" recognizing timer until Whisper returns, then the final
 *   transcript appends to the textarea in one shot. Typeless-style.
 *
 *   Multi-segment recordings (pause/resume) accumulate in a single
 *   MediaRecorder blob → one Whisper pass → one clean transcript.
 *   Typed text is preserved (baselineAttemptRef snapshot).
 *
 *   Fallback: system dictation (double-tap Right Option on macOS) still
 *   works inside the textarea if Whisper is unavailable or the learner wants
 *   even higher accuracy.
 *
 * Hotkeys: V record/pause/resume · Space reveal · 1-4 rate · U undo ·
 * J/K or ←/→ prev/next (same goPrev/goNext, also reachable via the ‹ ›
 * ghost buttons under the card).
 *
 * IA (浮现式, approved 2026-07-21): bare /review (nav, G R) is the
 * surfacing face — the due queue IS the page, first card immediately in
 * front, one-line "今天涌上来 N 张" header, no deck rail. ?view=browse
 * summons the demoted manage layer (DeckRail); any scope entry
 * (?lesson= / ?course= / picked deck) shows the rail too and behaves
 * exactly as pre-rework (课时深链扩展 untouched). See the `surfacing` const.
 */

const RATINGS = ['Again', 'Hard', 'Good', 'Easy'] as const;
type ReviewRating = (typeof RATINGS)[number];

const RATING_COLOR: Record<ReviewRating, string> = {
  Again: 'var(--ls-risk)',
  Hard: 'var(--ls-hypothesis)',
  Good: 'var(--ls-corroborated)',
  Easy: 'var(--ls-structure)',
};

type RecorderState = 'idle' | 'recording' | 'paused' | 'recognizing';

/** review.viewed 的防抖窗口 (最近接触二期, 2026-07-30) — 与
 *  document/DocumentReader.tsx 与 pages/Mindmap.tsx 的同名常量同值同理由:
 *  既挡住 StrictMode 的双跑与快速切组的抖动, 也等 PairProvider 把 pair 解析
 *  完 (它开机先给一个占位 pair, 抢在解析前发会打到一个本机不存在的 pair)。 */
const VIEWED_DEBOUNCE_MS = 700;

// Deck rail collapse — persisted (DeckRail 右置案), same precedent as Lesson
// page's LIVE_OPEN_KEY (三折布局案 补刀): plain read-on-mount + write-on-change,
// not the Inspector's collapse (which doesn't persist at all — see
// review/DeckRail.tsx's doc comment for why the *visual* language still
// comes from Inspector while the *persistence* mechanic comes from here).
const DECK_RAIL_COLLAPSED_KEY = 'learn-shell:review-deck-rail-collapsed';
function readDeckRailCollapsed(): boolean {
  try {
    return localStorage.getItem(DECK_RAIL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

// To-pool payload mapping (复习侧入池案) — same front→title / back→content mapping
// Cards.tsx uses for its own "To pool" action (pendingCardPayload there);
// duplicated here rather than imported since Cards.tsx is out of this
// job's file domain and doesn't export it.
function pendingCardPayload(c: Flashcard) {
  return {
    title: c.front,
    content: c.back,
    source_type: 'flashcard' as const,
    source_id: c.id as unknown as string,
    source_title: c.deck_id as unknown as string,
  };
}

export default function Review() {
  const repo = useRepository();
  const { pairId } = usePair();
  const qc = useQueryClient();
  const { t } = useT();

  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  // 自由翻面案 — `revealed` now toggles freely (space / click) before rating,
  // so it alone can no longer gate "has the rating row appeared yet". This
  // tracks that separately: sticky true once the answer's been shown at
  // least once this card, so flipping back to the front never hides the
  // rating entry point. Reset alongside `revealed` everywhere that resets it.
  const [everRevealed, setEverRevealed] = useState(false);
  const [attempt, setAttempt] = useState('');
  const [ratings, setRatings] = useState<ReviewRating[]>([]);
  // Focus mode — same fullscreen escape hatch as Mind Map (shell/FocusOverlay.tsx).
  // 2026-07-02 反馈: "把 Focus 模式也应用到 Review（复习闪卡）那一页".
  const [focusMode, setFocusMode] = useState(false);
  // 真翻转动画案 — real flip animation degrades to an instant swap for this.
  const prefersReducedMotion = usePrefersReducedMotion();

  // Voice pipeline state.
  const [recorderState, setRecorderState] = useState<RecorderState>('idle');
  const [recognizingMs, setRecognizingMs] = useState(0); // 0 unless recognizing
  const [modelStatus, setModelStatus] = useState<string>('');
  const [transcribeError, setTranscribeError] = useState<string | null>(null);

  // Snapshot of textarea at the moment recording starts. New transcript is
  // appended after this baseline so typed text is never overwritten and
  // multi-segment (pause/resume) recordings concatenate cleanly.
  const baselineAttemptRef = useRef<string>('');
  // Bumped on every "real stop" so a late-returning transcribe from a
  // previous session doesn't spill into the current one.
  const sessionIdRef = useRef<number>(0);

  // MediaRecorder + stream.
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioDurationMs, setAudioDurationMs] = useState<number>(0);
  const recordStartedAtRef = useRef<number>(0);
  // Actual capture time (excludes pause intervals). Wall-clock elapsed from
  // beginRecording would include the seconds spent thinking between
  // pauses — replay duration would show 1-2min for a 10s utterance.
  const recordActiveMsRef = useRef<number>(0);
  // Wall-clock at the start of the *current* recording segment (reset on
  // beginRecording and each successful mr.resume()).
  const segmentStartRef = useRef<number>(0);
  // 麦克风权限案 — 'denied' (browser blocked/user declined) vs. 'insecure' (page
  // isn't a secure context — http on a non-localhost host, where the
  // browser disables getUserMedia outright and there's no permission
  // toggle to grant) get distinct copy; see the warning block below.
  const [micPermissionIssue, setMicPermissionIssue] = useState<'denied' | 'insecure' | null>(
    null
  );

  // Recording beads: AudioContext + AnalyserNode share the same
  // MediaStream as the recorder. RecordingBeads subscribes to analyserRef
  // via rAF (review/RecordingBeads.tsx).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // Where to go once a Whisper pass finishes: 'paused' (mid-utterance pause,
  // the speaker is still talking) vs 'idle' (final stop for reveal/rate). Set
  // before mr.stop() so onstop knows the intent.
  const postRecognizeRef = useRef<'paused' | 'idle'>('idle');

  // Recognition timer rAF.
  const recognizingStartRef = useRef<number>(0);
  const recognizingRafRef = useRef<number | null>(null);

  // 课程深链案 — lesson-end "Review flashcards →" link (lesson/PagedLesson.tsx)
  // carries ?course=; read once here, applied below once course→deck
  // resolution (deckCourseId, 导图课程分组) is ready. No param (every other way of
  // reaching /review, including nav/G R) leaves this null and the page
  // behaves exactly as before.
  //
  // 课时深链扩展 — the same link now also carries ?lesson=<id>, which scopes
  // the queue to that lesson's own cards (via lesson.concept_ids →
  // flashcard.concept_id — the only provenance bridge a card has). Lesson
  // scope supersedes the 课程深链案 deck preselect (gated below); ?course= still
  // rides along purely to seed DeckRail's accordion open. Clearing the
  // scope (pill ✕, or picking a deck in the rail) drops the param from the
  // URL and lands back on the ordinary all-due queue.
  const [searchParams, setSearchParams] = useSearchParams();
  const courseParam = searchParams.get('course');
  const lessonParam = searchParams.get('lesson');
  // ?deck= (2026-07-21) — third sovereign scope entry, deep-linked from the
  // Cards page's deck chips / deck scope. Same species as ?lesson=: queue is
  // that deck's cards (due first in server order, then the not-yet-due
  // remainder by due_at asc), scope pill with ✕, bypasses the surfacing
  // face, gates off the 课程深链案 course→deck preselect. Internally it's the
  // same deck filter the rail's picked-deck state drives — the difference
  // is it arrives via URL so other pages can land here scoped (入口主权条款:
  // entry intent outranks page default). ?lesson= outranks it if both are
  // present (lesson is the narrower intent).
  const deckParam = searchParams.get('deck');
  // 浮现式 IA (surfacing-first) — the browse/manage layer (DeckRail) is no
  // longer the front door. ?view=browse summons it explicitly; it's a query
  // param (not local state) so refresh/back land on the same face, same
  // convention as ?lesson=/?course=. Scope entries never need it — any
  // scope (?lesson=, ?course=, a picked deck) shows the rail on its own,
  // see `surfacing` below.
  const browseParam = searchParams.get('view') === 'browse';
  const clearLessonScope = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('lesson');
    setSearchParams(next, { replace: true });
  };
  const clearDeckScope = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('deck');
    setSearchParams(next, { replace: true });
  };

  // Deck filter — 'all' or a specific deck_id; right rail (DeckRail) selects
  // this.
  const [selectedDeck, setSelectedDeck] = useState<string | 'all'>('all');
  // Deck rail collapse (DeckRail 右置案) — persisted, see DECK_RAIL_COLLAPSED_KEY above.
  const [deckRailCollapsed, setDeckRailCollapsed] = useState<boolean>(() =>
    readDeckRailCollapsed()
  );
  useEffect(() => {
    try {
      localStorage.setItem(DECK_RAIL_COLLAPSED_KEY, deckRailCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [deckRailCollapsed]);

  // The three faces of /review (浮现式 IA, approved 2026-07-21):
  //   浮现层 — bare /review (nav, G R): the due queue IS the page. No rail,
  //     no deck wall; a one-line "surfacing today · N" header and the first
  //     due card immediately in front.
  //   范围层 — any scope (?lesson=, ?course=, picked deck): entry intent
  //     outranks the page default (入口主权条款). Behavior identical to before
  //     this rework: scope pill / rail / due-first-then-rest queues.
  //   管理层 — ?view=browse: the old rail-first face, demoted behind the
  //     quiet "浏览全部" toggle in the top bar (and the empty state's one
  //     quiet entry).
  // `surfacing` is simply "neither of the other two claimed the page".
  const scoped =
    !!lessonParam || !!courseParam || !!deckParam || selectedDeck !== 'all';
  const surfacing = !scoped && !browseParam;
  const enterBrowse = () => {
    const next = new URLSearchParams(searchParams);
    next.set('view', 'browse');
    setSearchParams(next);
    // A 40px collapsed rail is not a browse face — summoning the manage
    // layer un-collapses it. Collapsing again inside browse still works
    // (and still persists) as before.
    setDeckRailCollapsed(false);
  };
  const exitBrowse = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('view');
    setSearchParams(next);
  };

  // Preload Whisper on mount so first stop doesn't pay cold model load.
  useEffect(() => {
    void preloadWhisper((msg) => setModelStatus(msg));
  }, []);

  const dueQ = useQuery({
    queryKey: ['due-full', pairId],
    queryFn: () => (repo && pairId ? repo.getDueReviews(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });

  // Pending pool dedup (复习侧入池案) — same read-only reuse of the Mindmap pool's
  // repo methods Cards.tsx already relies on for its own "To pool" action.
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
  const toPoolMut = useMutation({
    mutationFn: (c: Flashcard) => repo!.addPendingCard(pairId!, pendingCardPayload(c)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pending-cards'] }),
  });

  const allCards = dueQ.data ?? [];

  // Every card of the pair, not just due — feeds DeckRail's per-deck card
  // browser so any card is one click away (卡组内浏览器案). Same endpoint the
  // Cards page uses; dogfood scale, no need to gate the fetch on expansion.
  const allCardsQ = useQuery({
    queryKey: ['all-flashcards', pairId],
    queryFn: () => (repo && pairId ? repo.getAllFlashcards(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });
  const allPairCards = allCardsQ.data ?? [];

  // Course grouping for DeckRail (实机反馈: "deck 列表太长，Lesson 之上加
  // Courses 分组"). No `concept_id → course_id` lookup exists on
  // Repository (no getConcepts endpoint) — the only real bridge is via
  // Lesson: repo.getCourses → each course's repo.getLessons →
  // lesson.concept_ids[] carries lesson.course_id along with it, so a
  // concept_id → course_id map falls out of that without ever touching
  // a Concept entity. Query keys are the same ['courses', pairId] /
  // ['lessons', courseId] shape RecentRail/Courses.tsx already use, so
  // this rides their cache instead of re-fetching. (课时深链扩展 moved this block
  // above the queue memo — the ?lesson= scope resolves through the same
  // lessons fan-out, so it has to exist before `cards` is built.)
  const coursesQ = useQuery({
    queryKey: ['courses', pairId],
    queryFn: () => (repo && pairId ? repo.getCourses(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });
  const courses = coursesQ.data ?? [];

  // Fan-out courses → lessons in parallel (useQueries, not a serial
  // waterfall — same shape as journal/useJournalNotes.ts's lessonsQs).
  const lessonsQs = useQueries({
    queries: courses.map((c) => ({
      queryKey: ['lessons', c.id],
      queryFn: () => (repo ? repo.getLessons(c.id) : Promise.resolve([])),
      enabled: !!repo,
    })),
  });

  // 课时深链扩展 — resolve ?lesson= against the lessons fan-out above. Null
  // while queries are still landing (or if the id is bogus); the queue memo
  // below treats an unresolved-but-present param as "scope pending", not
  // "scope everything".
  const scopedLesson = useMemo(() => {
    if (!lessonParam) return null;
    for (const q of lessonsQs) {
      const hit = (q.data ?? []).find((l) => (l.id as unknown as string) === lessonParam);
      if (hit) return hit;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonParam, lessonsQs]);

  // Queue (课时深链扩展): lesson scope beats the deck filter. In lesson mode the
  // queue is that lesson's cards — due ones first (in due-queue order),
  // then the not-yet-due remainder (paused cards stay out, same as the
  // server's due queue) — so the view is useful even when nothing is due.
  //
  // Ordering source of truth (浮现式 axiom: most-overdue first, then
  // due-today, then — in lesson scope — the not-yet-due remainder): the
  // server's /reviews/due already sorts by fsrs_state.due_at ascending
  // (apps/server/src/routes/read.ts), so `allCards` and every filter of it
  // is most-overdue-first by construction — no client re-sort needed. The
  // lesson-mode remainder is the one slice the server never ordered (it
  // comes from getAllFlashcards); it gets an explicit due_at-ascending sort
  // here so the tail is soonest-to-surface-first instead of storage order.
  const cards = useMemo(() => {
    if (lessonParam) {
      if (!scopedLesson) return [];
      const conceptIds = new Set<string>(
        scopedLesson.concept_ids as unknown as string[]
      );
      const inLesson = (c: Flashcard) =>
        c.concept_id != null && conceptIds.has(c.concept_id as unknown as string);
      const due = allCards.filter(inLesson);
      const dueIdSet = new Set(due.map((c) => c.id));
      const rest = allPairCards
        .filter((c) => inLesson(c) && !dueIdSet.has(c.id) && !c.paused)
        .sort(
          (a, b) =>
            new Date(a.fsrs_state.due_at).getTime() -
            new Date(b.fsrs_state.due_at).getTime()
        );
      return [...due, ...rest];
    }
    // ?deck= scope — same due-first-then-remainder shape as lesson mode,
    // keyed off deck_id (no async resolution needed: deck_id lives on the
    // card itself).
    if (deckParam) {
      const inDeck = (c: Flashcard) =>
        (c.deck_id as unknown as string) === deckParam;
      const due = allCards.filter(inDeck);
      const dueIdSet = new Set(due.map((c) => c.id));
      const rest = allPairCards
        .filter((c) => inDeck(c) && !dueIdSet.has(c.id) && !c.paused)
        .sort(
          (a, b) =>
            new Date(a.fsrs_state.due_at).getTime() -
            new Date(b.fsrs_state.due_at).getTime()
        );
      return [...due, ...rest];
    }
    return selectedDeck === 'all'
      ? allCards
      : allCards.filter((c) => c.deck_id === selectedDeck);
  }, [lessonParam, scopedLesson, deckParam, allCards, allPairCards, selectedDeck]);

  // Detour (卡组内浏览器案) — a non-due card picked from the rail's browser. It
  // takes over the stage; rating it (or J/K) drops back to the untouched
  // queue position. Detour ratings persist to FSRS as early reviews but
  // stay out of session tallies/undo — browsing, not queue progress.
  const [detourCard, setDetourCard] = useState<Flashcard | null>(null);

  const card = detourCard ?? cards[index];
  const total = cards.length;

  const dueIds = useMemo(() => new Set(allCards.map((c) => c.id)), [allCards]);

  // 课时深链扩展 — in lesson mode (and deck mode, same queue shape) the queue
  // includes not-yet-due cards, so the "Due cards · N" badge counts only
  // the due portion; everywhere else the queue *is* the due set and the
  // old total stands.
  const dueShown =
    lessonParam || deckParam
      ? cards.reduce((n, c) => n + (dueIds.has(c.id) ? 1 : 0), 0)
      : total;

  // Deck list = union of every deck that exists; the count shown stays the
  // *due* count (queue semantics unchanged), browsing reaches the rest.
  const deckStats = useMemo(() => {
    const due = new Map<string, number>();
    for (const c of allCards) due.set(c.deck_id, (due.get(c.deck_id) ?? 0) + 1);
    const ids = new Set<string>();
    for (const c of allPairCards) ids.add(c.deck_id);
    for (const c of allCards) ids.add(c.deck_id);
    return Array.from(ids)
      .sort()
      .map((deck_id) => ({ deck_id, count: due.get(deck_id) ?? 0 }));
  }, [allCards, allPairCards]);

  const deckCards = useMemo(() => {
    const m = new Map<string, Flashcard[]>();
    for (const c of allPairCards) {
      const arr = m.get(c.deck_id);
      if (arr) arr.push(c);
      else m.set(c.deck_id, [c]);
    }
    return m;
  }, [allPairCards]);

  const conceptToCourse = useMemo(() => {
    const m = new Map<string, string>();
    courses.forEach((c, i) => {
      const lessons = lessonsQs[i]?.data ?? [];
      for (const lesson of lessons) {
        for (const conceptId of lesson.concept_ids) {
          if (!m.has(conceptId)) m.set(conceptId, c.id);
        }
      }
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courses, lessonsQs]);

  // deck → course, majority-vote over each deck's cards (course
  // grouping): cards with concept_id === null, or whose concept doesn't
  // resolve to a course, don't vote. A tie keeps whichever course was
  // first encountered while scanning the deck's cards (first-seen, not
  // insertion-order-in-map, so it's stable regardless of Map iteration
  // quirks). A deck with zero resolvable votes falls into the Ungrouped
  // bucket.
  const deckCourseId = useMemo(() => {
    const votes = new Map<string, Map<string, number>>(); // deck_id -> (course_id -> count)
    const seenOrder = new Map<string, string[]>(); // deck_id -> course_ids in first-seen order
    for (const c of allPairCards) {
      if (c.concept_id == null) continue;
      const courseId = conceptToCourse.get(c.concept_id);
      if (!courseId) continue;
      let m = votes.get(c.deck_id);
      if (!m) {
        m = new Map();
        votes.set(c.deck_id, m);
      }
      m.set(courseId, (m.get(courseId) ?? 0) + 1);
      let order = seenOrder.get(c.deck_id);
      if (!order) {
        order = [];
        seenOrder.set(c.deck_id, order);
      }
      if (!order.includes(courseId)) order.push(courseId);
    }
    const result = new Map<string, string>(); // deck_id -> course_id | UNGROUPED_COURSE_KEY
    for (const d of deckStats) {
      const m = votes.get(d.deck_id);
      const order = seenOrder.get(d.deck_id);
      if (!m || !order || order.length === 0) {
        result.set(d.deck_id, UNGROUPED_COURSE_KEY);
        continue;
      }
      // Safe: the `order.length === 0` branch above already returned.
      let best = order[0]!;
      let bestCount = m.get(best) ?? 0;
      for (const courseId of order) {
        const count = m.get(courseId) ?? 0;
        if (count > bestCount) {
          best = courseId;
          bestCount = count;
        }
      }
      result.set(d.deck_id, best);
    }
    return result;
  }, [allPairCards, conceptToCourse, deckStats]);

  // Course groups in getCourses() order, Ungrouped bucket always last —
  // DeckRail renders each as its own top-level accordion, default collapsed.
  const courseGroups = useMemo(() => {
    const byCourse = new Map<string, Array<{ deck_id: string; count: number }>>();
    for (const d of deckStats) {
      const courseId = deckCourseId.get(d.deck_id) ?? UNGROUPED_COURSE_KEY;
      let arr = byCourse.get(courseId);
      if (!arr) {
        arr = [];
        byCourse.set(courseId, arr);
      }
      arr.push(d);
    }
    const groups: Array<{ courseId: string; topic: string; decks: Array<{ deck_id: string; count: number }> }> = [];
    for (const c of courses) {
      const decks = byCourse.get(c.id);
      if (decks && decks.length > 0) groups.push({ courseId: c.id, topic: c.topic, decks });
    }
    const ungrouped = byCourse.get(UNGROUPED_COURSE_KEY);
    if (ungrouped && ungrouped.length > 0) {
      // topic left blank — DeckRail swaps in the localized "Ungrouped"
      // label itself when it sees this sentinel courseId.
      groups.push({ courseId: UNGROUPED_COURSE_KEY, topic: '', decks: ungrouped });
    }
    return groups;
  }, [deckStats, deckCourseId, courses]);

  // review.viewed 已读信号 (Recents 最近接触二期, 2026-07-30) —— 学习者裁决:
  // Recents 每一行都得显示她最近碰过的那个对象, 而 Review 行原本只有一个到期
  // 计数, 没有任何最近性。这枚事件回答"她最近在复习哪一组卡", 左栏据此显示组
  // 名并深链回来 (见 shell/RecentRail.tsx 的 latestViewedDeck)。
  //
  // 手法照抄 DocumentReader / Mindmap 那两枚 viewed (2026-07-30):
  // debounce + fire-and-forget + ref 去重, 失败把去重标记退回去等下次重试。
  // 去重键是"当前选中的这一组", 所以在 DeckRail 里切组会重新发一枚 —— 切组
  // 本来就是"我现在要复习这一组"的动作, 该顶到最前。
  //
  // 与 review.rated 的分工: 那枚是评卡本身 (走 recordReview → /reviews, 带
  // rating 与用时, 喂 FSRS); 这枚不带任何评分深度, 只服务 Recents 的最近性。
  const effectiveDeck = !lessonParam && deckParam ? deckParam : selectedDeck;
  const reviewViewedFiredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!repo || !pairId) return;
    // 'all due' 那一档没有选中任何一组具体的卡 —— 照发 (她确实打开了复习页),
    // 但 deck_id 记 null, 左栏见 null 就退回原来的纯计数文案。
    const deckId = effectiveDeck === 'all' ? null : effectiveDeck;
    const dedupKey = deckId ?? '__all__';
    if (reviewViewedFiredForRef.current === dedupKey) return;
    // course_id 是顺手记的旁注 (Recents 目前不读它): allPairCards 还没到时
    // deckCourseId 是空的, 这里就会记成 null。不为它加 loading 门 —— 加了就
    // 有"永远不发"的风险, 而这个字段没有任何东西依赖。
    const votedCourseId = deckId ? deckCourseId.get(deckId) : undefined;
    const courseId =
      votedCourseId && votedCourseId !== UNGROUPED_COURSE_KEY ? votedCourseId : null;
    const timer = window.setTimeout(() => {
      reviewViewedFiredForRef.current = dedupKey;
      repo
        .recordLearningEvent({
          pair_id: pairId,
          event_type: 'review.viewed',
          mode: 'review',
          payload: { deck_id: deckId, course_id: courseId },
        })
        .then(() => {
          // 与 PagedLesson 同样两把: 隔了 30 分钟再来会开一场新 session, 边栏
          // 手里那份"最近场次"名单跟着过期。
          qc.invalidateQueries({ queryKey: ['recent-rail', 'sessions', pairId] });
          qc.invalidateQueries({ queryKey: ['recent-rail', 'session-events'] });
        })
        .catch(() => {
          if (reviewViewedFiredForRef.current === dedupKey) {
            reviewViewedFiredForRef.current = null;
          }
        });
    }, VIEWED_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [repo, pairId, effectiveDeck, deckCourseId, qc]);

  // 课程深链案 — apply ?course= once every query courseGroups depends on has
  // settled (courses/lessons/all-flashcards/due), so it doesn't fire on an
  // empty first-render courseGroups and silently no-op. A course that
  // resolves to exactly one deck (Cards.tsx's own "Deck typically belongs
  // to one course" note — the common case) preselects that deck as the
  // queue filter, same as clicking it in DeckRail. Zero or multiple decks
  // have no single answer under today's single-selectedDeck model, so the
  // filter is left at the 'all' default — DeckRail's initialOpenCourseId
  // (below) still opens that course's accordion so the context isn't lost,
  // just not auto-filtered. Runs at most once per page load — a manual
  // deck pick afterward is never overridden.
  const appliedCourseParamRef = useRef(false);
  useEffect(() => {
    // 课时深链扩展: a ?lesson= scope owns the queue — the course→deck preselect
    // would fight it (deck filter is ignored in lesson mode anyway, but a
    // highlighted deck in the rail would lie about what's on stage). Same
    // gate for ?deck= — the deck scope already IS the deck selection.
    if (!courseParam || lessonParam || deckParam || appliedCourseParamRef.current) return;
    const stillLoading =
      coursesQ.isLoading ||
      allCardsQ.isLoading ||
      dueQ.isLoading ||
      lessonsQs.some((q) => q.isLoading);
    if (stillLoading) return;
    appliedCourseParamRef.current = true;
    const group = courseGroups.find((g) => g.courseId === courseParam);
    if (group && group.decks.length === 1) {
      setSelectedDeck(group.decks[0]!.deck_id);
    }
  }, [courseParam, lessonParam, deckParam, courseGroups, coursesQ.isLoading, allCardsQ.isLoading, dueQ.isLoading, lessonsQs]);

  function jumpToCard(cardId: string) {
    const target = allPairCards.find((c) => c.id === cardId);
    if (!target) return;
    cancelRecording();
    releaseAudio();
    setRevealed(false);
    setEverRevealed(false);
    setAttempt('');
    const qi = cards.findIndex((c) => c.id === cardId);
    if (qi >= 0) {
      // Due in the current queue — a real jump, no detour needed.
      setDetourCard(null);
      setIndex(qi);
    } else {
      setDetourCard(target);
    }
  }

  // ---- Audio graph teardown ----
  const teardownAnalyser = () => {
    if (analyserSourceRef.current) {
      try {
        analyserSourceRef.current.disconnect();
      } catch {
        /* ignore */
      }
      analyserSourceRef.current = null;
    }
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {
        /* ignore */
      }
      analyserRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  };

  const releaseAudio = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setAudioDurationMs(0);
    chunksRef.current = [];
  };

  const stopMediaTracks = () => {
    const stream = mediaStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    mediaRecRef.current = null;
  };

  const stopRecognizingTimer = () => {
    if (recognizingRafRef.current !== null) {
      cancelAnimationFrame(recognizingRafRef.current);
      recognizingRafRef.current = null;
    }
    setRecognizingMs(0);
  };

  const startRecognizingTimer = () => {
    recognizingStartRef.current = performance.now();
    const tick = () => {
      setRecognizingMs(Math.round(performance.now() - recognizingStartRef.current));
      recognizingRafRef.current = requestAnimationFrame(tick);
    };
    recognizingRafRef.current = requestAnimationFrame(tick);
  };

  // ---- Recording lifecycle ----
  //
  // Single-recording model (2026-07-01 pt2, per the "next V overwrote
  // the prior audio" report): ONE MediaRecorder lives from beginRecording
  // to final flush. Pause/resume use mr.pause()/mr.resume() — chunks keep
  // accumulating from the top, so replay is always the full session and
  // Whisper always transcribes the full audio-so-far.
  //
  // Baseline snapshot is taken once at beginRecording; every subsequent
  // Whisper pass replaces the "voice tail" appended to that baseline —
  // no per-segment append drift. Typing between segments is a
  // known edge case: edits after the baseline get overwritten on the
  // next pause. Acceptable trade for the "audio doesn't disappear" win.

  // Force MediaRecorder to flush pending data before we read chunks. The
  // dataavailable event fires asynchronously; we wait for it (with a
  // 250ms safety timeout) so blob composition doesn't race the encoder.
  const drainChunks = (mr: MediaRecorder): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (mr.state === 'inactive') {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        mr.removeEventListener('dataavailable', finish);
        resolve();
      };
      mr.addEventListener('dataavailable', finish);
      try {
        mr.requestData();
      } catch {
        finish();
        return;
      }
      setTimeout(finish, 250);
    });
  };

  const composeBlobSoFar = (mr: MediaRecorder | null): Blob | null => {
    if (chunksRef.current.length === 0) return null;
    const type = mr?.mimeType || 'audio/webm';
    return new Blob(chunksRef.current, { type });
  };

  const publishReplay = (blob: Blob) => {
    setAudioDurationMs(Math.round(recordActiveMsRef.current));
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(blob);
    });
  };

  const beginRecording = async () => {
    setTranscribeError(null);
    baselineAttemptRef.current = attempt;
    releaseAudio();

    // 麦克风权限案 — outside a secure context (http, not localhost) mediaDevices is
    // undefined entirely; catch that up front so the warning below can
    // tell it apart from an actual permission denial.
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicPermissionIssue(window.isSecureContext ? 'denied' : 'insecure');
      return;
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicPermissionIssue(null);
    } catch {
      setMicPermissionIssue('denied');
      return;
    }
    mediaStreamRef.current = stream;

    // Audio graph for the recording beads (lives across pause/resume so
    // the trace stays continuous — same analyser subscribed to same
    // stream throughout). RecordingBeads reads time-domain data (a real
    // waveform, not a spectrum) — smoothingTimeConstant only affects
    // frequency-domain output, so it's left at its default here; the
    // beads do their own asymmetric attack/release smoothing instead.
    try {
      const AC =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = RECORDING_BEADS_FFT_SIZE;
        source.connect(analyser);
        audioCtxRef.current = ctx;
        analyserSourceRef.current = source;
        analyserRef.current = analyser;
      }
    } catch {
      /* waveform is a nice-to-have — recording still works without it */
    }

    chunksRef.current = [];
    recordStartedAtRef.current = performance.now();
    recordActiveMsRef.current = 0;
    segmentStartRef.current = recordStartedAtRef.current;
    // Bump opus bitrate — default is ~40-60 kbps which is fine for speech
    // but leaves headroom Whisper can use. 128 kbps gets us cleaner
    // consonants and better English-token recognition.
    const mr = new MediaRecorder(stream, { audioBitsPerSecond: 128000 });
    mediaRecRef.current = mr;

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    // onstop is a no-op — publishing replay + tearing down happens inline
    // in flushAndTranscribe so we can await the transcribe deterministically.
    mr.onstop = null;

    mr.start(500); // 500ms timeslice — chunks stream in as we go
    setRecorderState('recording');
  };

  // Pause → drain to flush pending data → mr.pause() (keeps recorder
  // alive for resume) → transcribe audio-so-far → land in 'paused'.
  const pauseRecording = async () => {
    const mr = mediaRecRef.current;
    if (!mr || mr.state !== 'recording') return;
    baselineAttemptRef.current = attempt;
    const mySession = ++sessionIdRef.current;
    postRecognizeRef.current = 'paused';
    setRecorderState('recognizing');
    startRecognizingTimer();

    try {
      await drainChunks(mr);
      if (mr.state === 'recording') {
        try {
          mr.pause();
          // Segment closed → bank its duration into the active total.
          recordActiveMsRef.current += performance.now() - segmentStartRef.current;
        } catch {
          /* ignore — will still transcribe */
        }
      }
    } catch {
      /* proceed with whatever chunks we have */
    }

    if (mySession !== sessionIdRef.current) return; // user navigated away
    const blob = composeBlobSoFar(mr);
    if (blob && blob.size > 0) {
      publishReplay(blob);
      void transcribeAndReplaceTail(blob, mySession, 'paused');
    } else {
      stopRecognizingTimer();
      setRecorderState('paused');
    }
  };

  // Resume → chunks keep accumulating on the same MediaRecorder.
  const resumeRecording = () => {
    const mr = mediaRecRef.current;
    if (!mr) {
      void beginRecording();
      return;
    }
    if (mr.state === 'paused') {
      try {
        mr.resume();
        segmentStartRef.current = performance.now(); // start a new segment
        setRecorderState('recording');
      } catch {
        void beginRecording();
      }
    } else if (mr.state === 'recording') {
      setRecorderState('recording'); // desync recovery
    } else {
      void beginRecording();
    }
  };

  // Final stop for reveal / rate / nav. Drains, stops the recorder,
  // publishes complete replay, transcribes the full audio one more time
  // (unless the last pause already covered it), tears down the audio graph.
  const flushAndTranscribe = async () => {
    const mr = mediaRecRef.current;
    if (!mr || mr.state === 'inactive') return;

    const wasPaused = mr.state === 'paused';
    const mySession = ++sessionIdRef.current;
    postRecognizeRef.current = 'idle';
    setRecorderState('recognizing');
    startRecognizingTimer();

    if (!wasPaused) {
      try {
        await drainChunks(mr);
      } catch {
        /* proceed */
      }
      // Bank the trailing segment before stopping.
      recordActiveMsRef.current += performance.now() - segmentStartRef.current;
    }

    try {
      mr.stop();
    } catch {
      /* ignore */
    }

    if (mySession !== sessionIdRef.current) return;

    const blob = composeBlobSoFar(mr);
    if (blob && blob.size > 0) {
      publishReplay(blob);
      if (wasPaused) {
        // Last pause already transcribed the audio-so-far. Just close.
        stopRecognizingTimer();
        teardownAnalyser();
        stopMediaTracks();
        setRecorderState('idle');
      } else {
        void transcribeAndReplaceTail(blob, mySession, 'idle');
      }
    } else {
      stopRecognizingTimer();
      teardownAnalyser();
      stopMediaTracks();
      setRecorderState('idle');
    }
  };

  // Hard cancel — no transcription, no reveal. Used on nav / unmount.
  const cancelRecording = () => {
    sessionIdRef.current += 1; // any in-flight transcribe becomes stale
    const mr = mediaRecRef.current;
    if (mr && mr.state !== 'inactive') {
      try {
        mr.onstop = null;
        mr.stop();
      } catch {
        /* ignore */
      }
    }
    teardownAnalyser();
    stopMediaTracks();
    chunksRef.current = [];
    stopRecognizingTimer();
    setRecorderState('idle');
  };

  // Reset — 一键重置案 (2026-07-16): one button that wipes the current
  // attempt clean, recording and typed text alike, so a redo starts from a
  // blank slate instead of manual delete-and-hope-to-re-record. Same
  // teardown pair (cancelRecording + releaseAudio) the index/selectedDeck
  // effects and jumpToCard already run when moving off a card — this just
  // makes it reachable as its own click without advancing the queue or
  // touching reveal state.
  const resetCapture = () => {
    cancelRecording();
    releaseAudio();
    setAttempt('');
  };

  // Whisper pass → replace the voice tail (attempt = baseline + text).
  // Because we always transcribe audio-from-the-start-of-recording,
  // each pass produces the complete transcription; no per-segment
  // concatenation drift.
  const transcribeAndReplaceTail = async (
    blob: Blob,
    mySessionId: number,
    target: 'paused' | 'idle'
  ) => {
    try {
      const result = await transcribeBlob(blob, {
        language: 'chinese',
        onProgress: setModelStatus,
      });
      if (mySessionId !== sessionIdRef.current) return;
      const base = baselineAttemptRef.current;
      const text = result.text;
      const joiner = base && text ? (base.endsWith('\n') ? '' : ' ') : '';
      setAttempt(base + joiner + text);
    } catch (e) {
      if (mySessionId === sessionIdRef.current) {
        setTranscribeError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (mySessionId === sessionIdRef.current) {
        stopRecognizingTimer();
        if (target === 'idle') {
          teardownAnalyser();
          stopMediaTracks();
          setRecorderState('idle');
        } else {
          setRecorderState('paused');
        }
      }
    }
  };

  const toggleRecording = () => {
    if (recorderState === 'idle') void beginRecording();
    else if (recorderState === 'recording') void pauseRecording();
    else if (recorderState === 'paused') resumeRecording();
    // ignore in 'recognizing' — user should wait for transcript
  };

  function rateCurrent(rating: ReviewRating) {
    // Persist: server runs real FSRS scheduling + appends a review.rated
    // session event. Fire-and-forget — the review flow never blocks on it.
    if (card && repo && pairId) {
      repo
        .recordReview({
          pair_id: pairId,
          card_id: card.id,
          rating,
          answer_text: attempt.trim() || null,
        })
        .then(() => {
          // 缓存陈旧修补 (2026-07-30): 评完一张卡, 左栏 Recents 的到期计数
          // (['due', pairId], RecentRail 独占的 key) 全库没有任何地方作废过
          // —— 复习完一整轮回头看, 那个数字还停在开始前, 要等窗口重新聚焦才
          // 更新。这里补一把。
          //
          // 只作废这一个 key, 刻意不碰 Review 页自己的 ['due-full', pairId]:
          // 那是她当前正在走的这条队列 (按 index 推进), 中途重取会在她手底下
          // 把队列换掉。两个 key 打的是同一个 getDueReviews —— 边栏那份该新,
          // 手里这份该稳。
          qc.invalidateQueries({ queryKey: ['due', pairId] });
        })
        .catch((e) => console.error('[recordReview]', e));
    }
    if (detourCard) {
      // Browsing detour — the rating persisted above (FSRS early review),
      // but queue position and session tallies stay untouched.
      setDetourCard(null);
      setRevealed(false);
      setEverRevealed(false);
      setAttempt('');
      cancelRecording();
      return;
    }
    setRatings((r) => [...r, rating]);
    setIndex((i) => i + 1);
    setRevealed(false);
    setEverRevealed(false);
    setAttempt('');
    cancelRecording();
  }

  // Shared by: Space (first press), the "Reveal & compare" button, and
  // clicking the card face while it's showing the front. `everRevealed`
  // latches true so the rating row stays put through later front/back
  // toggles (自由翻面案 — flipping back to front must not drop the rating
  // entry point).
  function revealCard() {
    if (recorderState === 'recording' || recorderState === 'paused') {
      void flushAndTranscribe();
    }
    setRevealed(true);
    setEverRevealed(true);
  }

  // goPrev/goNext — pulled out of the J/K useHotkeys bodies (左右键翻卡案,
  // the ask was left/right arrows + on-screen ‹ › buttons doing the exact
  // same thing) so all four entry points share one definition. No rating,
  // straight jump; a detourCard leaves the detour back to the queue's
  // untouched position instead of advancing/receding through it.
  function goPrev() {
    if (detourCard) setDetourCard(null);
    else setIndex((i) => Math.max(0, i - 1));
    setRevealed(false);
    setEverRevealed(false);
    setAttempt('');
    cancelRecording();
  }

  function goNext() {
    if (!card) return;
    // Leaving a detour returns to the queue where it was; advancing past
    // the queue card takes another press.
    if (detourCard) setDetourCard(null);
    else setIndex((i) => Math.min(cards.length, i + 1));
    setRevealed(false);
    setEverRevealed(false);
    setAttempt('');
    cancelRecording();
  }

  useHotkeys('v', toggleRecording, {
    preventDefault: true,
    enableOnFormTags: false,
  });

  useHotkeys(
    'space',
    (e) => {
      if (!card) return;
      e.preventDefault();
      // Toggle: first press reveals (flushing any in-flight recording so
      // the transcript lands before flipping); once revealed, Space flips
      // freely back and forth — rating is still only reachable via the
      // 1-4 keys / rating row, never by the flip itself.
      if (revealed) setRevealed(false);
      else revealCard();
    },
    [card, revealed, recorderState]
  );

  useHotkeys(
    '1,2,3,4',
    (e, hk) => {
      // Gate on everRevealed, not revealed — the rating row stays visible
      // even after flipping back to the front post-reveal (see revealCard).
      if (!everRevealed || !card) return;
      e.preventDefault();
      const idx = Number(hk.keys?.[0] ?? '0') - 1;
      const rating = RATINGS[idx];
      if (rating) rateCurrent(rating);
    },
    [everRevealed, card, detourCard]
  );

  useHotkeys(
    'u',
    () => {
      if (detourCard) {
        setDetourCard(null);
        return;
      }
      if (ratings.length === 0) return;
      setRatings((r) => r.slice(0, -1));
      setIndex((i) => Math.max(0, i - 1));
      setRevealed(false);
      setEverRevealed(false);
      setAttempt('');
    },
    [ratings, detourCard]
  );

  useHotkeys('k', goNext);
  useHotkeys('j', goPrev);
  // left/right — same jump as J/K (左右键翻卡案), default react-hotkeys-hook
  // behavior already skips form tags so typing in the textarea is safe.
  useHotkeys('right', goNext);
  useHotkeys('left', goPrev);

  // 键盘覆盖率审计补丁 (open-source sprint ①线): Esc clears whichever scope
  // pill is showing (lesson ✕ / deck ✕ above) — same priority the pills
  // already render under (课时深链扩展: lesson scope beats ?deck=). No-op when
  // neither is present (surfacing face / plain browse), so Esc never fights
  // anything else on the page. Page-local action key in the same family as
  // V/Space/1-4/U/J/K/arrows above — none of those are listed in the ⌘K/?
  // palette either (it only documents global G-nav destinations, see
  // shell/CommandPalette.tsx), so this follows the same undocumented-in-
  // palette convention rather than inventing a new one.
  useHotkeys(
    'escape',
    () => {
      if (lessonParam) clearLessonScope();
      else if (deckParam) clearDeckScope();
    },
    [lessonParam, deckParam]
  );

  useEffect(
    () => () => {
      cancelRecording();
      releaseAudio();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  useEffect(() => {
    setAttempt('');
    setRevealed(false);
    setEverRevealed(false);
    cancelRecording();
    releaseAudio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);
  useEffect(() => {
    setIndex(0);
    setRatings([]);
    setDetourCard(null);
    setRevealed(false);
    setEverRevealed(false);
    setAttempt('');
    cancelRecording();
    releaseAudio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeck, lessonParam, deckParam]);

  const restart = () => {
    setIndex(0);
    setRatings([]);
    setDetourCard(null);
    setRevealed(false);
    setEverRevealed(false);
    setAttempt('');
    releaseAudio();
  };

  const ratingCount = useMemo(() => {
    const c: Record<ReviewRating, number> = { Again: 0, Hard: 0, Good: 0, Easy: 0 };
    ratings.forEach((r) => {
      c[r] += 1;
    });
    return c;
  }, [ratings]);

  if (!repo) {
    return (
      <p className="text-sm text-[var(--ls-text-secondary)]">{t('review.emptyMode')}</p>
    );
  }

  // A detour card keeps the stage alive even when the queue itself is
  // empty or finished — the empty/done states yield to it. 课时深链扩展: while a
  // ?lesson= scope is still resolving through the courses→lessons fan-out
  // the queue is empty by construction — don't flash the empty state.
  const lessonScopeResolving =
    !!lessonParam &&
    !scopedLesson &&
    (coursesQ.isLoading ||
      allCardsQ.isLoading ||
      lessonsQs.some((q) => q.isLoading));
  // Deck scope needs no id resolution, but its queue tail comes from
  // getAllFlashcards — don't flash the empty state while that's landing.
  const deckScopeResolving =
    !!deckParam && !lessonParam && allCardsQ.isLoading;
  const isEmpty =
    !dueQ.isLoading &&
    !lessonScopeResolving &&
    !deckScopeResolving &&
    total === 0 &&
    !detourCard;
  const isDone = !isEmpty && !card && total > 0;
  const isActive = !!card;

  const micHint = (() => {
    if (recorderState === 'recording') return t('review.micRecording');
    if (recorderState === 'paused') return t('review.micPaused');
    if (recorderState === 'recognizing')
      return `${t('review.recognizingPrefix')}${(recognizingMs / 1000).toFixed(1)}s`;
    if (transcribeError)
      return `${t('review.transcribeErrorPrefix')}${transcribeError}${t('review.transcribeErrorSuffix')}`;
    return t('review.micIdleHint');
  })();

  // Reset button disabled iff there's nothing to clear yet — no in-flight/
  // paused/recognizing recording, no replay audio, no typed text.
  const captureIsEmpty =
    recorderState === 'idle' && !audioUrl && attempt.trim() === '';

  const showLoadingBadge =
    modelStatus &&
    !modelStatus.startsWith('Ready') &&
    !modelStatus.startsWith('Done') &&
    recorderState !== 'recognizing';

  return (
    // Focus mode escapes AppShell entirely, same fullscreen mechanism as
    // Mind Map — see shell/FocusOverlay.tsx.
    <div style={focusOverlayStyle(focusMode)}>
    <div
      className="flex"
      style={
        focusMode
          ? // 2026-07-02 实机反馈 (Focus 卡片跑位修复): "review进入focus模式后卡片跑到了左
            // 上，让卡片居中" — the row's own width (capped content column +
            // gap + rail) is narrower than the fullscreen viewport, so with
            // no justify-content the flex row (and thus the whole card+rail
            // group) sits pinned to the row's start instead of filling the
            // space. Centering the row centers the group as a unit — the
            // rail stays glued to the right of the card column (their
            // relative position is untouched, DeckRail 右置案 moved DeckRail
            // there), the pair just moves together into the middle of the
            // screen.
            //
            // 2026-07-03 实机反馈 (卡片垂直居中案): "卡片还需要上下居中" — alignItems
            // switched flex-start → stretch so the content column gets the
            // row's full height to center *within*; DeckRail keeps its own
            // explicit alignSelf:'flex-start' below so it's unaffected and
            // stays top-anchored/sticky. The actual anti-jump handling
            // lives inside the content column (see the "body stage" comment
            // further down) — a min-height floor keeps the card's top edge
            // stable across reveal/rate instead of true recentering on
            // every height change.
            { gap: '24px', alignItems: 'stretch', justifyContent: 'center', flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }
          : { gap: '24px', alignItems: 'flex-start' }
      }
    >
      <div
        className="flex-1 min-w-0 flex flex-col"
        style={{ maxWidth: focusMode ? '880px' : '720px' }}
      >
      {/* =============== Top bar =============== */}
      <div
        className="flex items-center justify-between flex-wrap"
        style={{ marginBottom: '24px', gap: '12px', flex: '0 0 auto' }}
      >
        <div className="flex items-center flex-wrap" style={{ gap: '10px' }}>
          {surfacing ? (
            // 浮现层 header — one quiet line, the queue speaks for itself.
            // No page title, no badge pill: "今天涌上来 N 张卡" IS the header.
            <span className="font-medium text-[13px] leading-5">
              {t('review.surfacing.duePrefix')}{dueShown}
              {dueShown === 1 ? t('review.cardSingular') : t('review.cardPlural')}
            </span>
          ) : (
            <>
              <span className="font-medium text-[13px] leading-5">{t('review.title')}</span>
              <span
                className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)]"
                style={{
                  padding: '3px 10px',
                  borderRadius: '999px',
                  fontSize: '12px',
                  lineHeight: '16px',
                  gap: '7px',
                }}
              >
                {t('review.dueCardsPrefix')}{dueShown}{dueShown === 1 ? t('review.cardSingular') : t('review.cardPlural')}
              </span>
            </>
          )}
          {/* 课时深链扩展 — lesson-scope pill: same quiet species as the detour
              chip beside it (border + rounded-full + text-secondary), just
              carrying the lesson title and an ✕ that clears back to the
              all-due queue. Title shows … while the lessons fan-out is
              still resolving the id. */}
          {lessonParam && (
            <span
              className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)]"
              style={{
                padding: '3px 6px 3px 10px',
                borderRadius: '999px',
                fontSize: '11px',
                lineHeight: '16px',
                gap: '6px',
              }}
              title={t('review.lessonScope.pillTitle')}
            >
              {scopedLesson ? scopedLesson.title : '…'}
              <button
                type="button"
                onClick={clearLessonScope}
                title={t('review.lessonScope.clearTitle')}
                className="inline-flex items-center justify-center text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors duration-[var(--ls-duration-fast)]"
                style={{
                  width: '16px',
                  height: '16px',
                  padding: 0,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '11px',
                  lineHeight: '1',
                }}
              >
                ✕
              </button>
            </span>
          )}
          {/* ?deck= scope pill — same quiet species as the lesson pill
              above; the deck_id is already the human-readable name.
              Hidden if a ?lesson= scope owns the queue (lesson wins, and
              a deck pill would lie about what's on stage). */}
          {!lessonParam && deckParam && (
            <span
              className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)]"
              style={{
                padding: '3px 6px 3px 10px',
                borderRadius: '999px',
                fontSize: '11px',
                lineHeight: '16px',
                gap: '6px',
              }}
              title={t('review.deckScope.pillTitle')}
            >
              {deckParam}
              <button
                type="button"
                onClick={clearDeckScope}
                title={t('review.deckScope.clearTitle')}
                className="inline-flex items-center justify-center text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors duration-[var(--ls-duration-fast)]"
                style={{
                  width: '16px',
                  height: '16px',
                  padding: 0,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '11px',
                  lineHeight: '1',
                }}
              >
                ✕
              </button>
            </span>
          )}
          {isActive && !detourCard && (
            <span className="text-[12px] leading-[18px] text-[var(--ls-text-tertiary)] tabular-nums">
              {t('review.cardOfPrefix')}{index + 1}{t('review.cardOfMid')}{total}{t('review.cardOfSuffix')}
            </span>
          )}
          {detourCard && (
            <span
              className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)]"
              style={{
                padding: '3px 10px',
                borderRadius: '999px',
                fontSize: '11px',
                lineHeight: '16px',
              }}
              title={t('review.detourChipTitle')}
            >
              {t('review.detourChip')}
            </span>
          )}
          {showLoadingBadge && (
            <span
              className="text-[11px] leading-4 text-[var(--ls-text-tertiary)] font-mono"
              title={t('review.whisperLoadingTitle')}
            >
              {modelStatus}
            </span>
          )}
        </div>
        {/* Focus 开关外置案: Focus toggle used to live inside the tiny-gray hotkey
            row below, sharing its 11px/tertiary styling context — same
            visual species as plain hint labels, easy to read past. Pulled
            it into its own group here so it reads as a control, not a
            label: same shared FocusToggleButton used on Mind Map's
            toolbar, given its own breathing room and placed as the
            row's clear right-most anchor. */}
        <div className="flex items-center flex-wrap" style={{ gap: '16px' }}>
          <div
            className="flex items-center flex-wrap text-[11px] leading-4 text-[var(--ls-text-tertiary)]"
            style={{ gap: '12px' }}
          >
            <span>{t('review.hotkey.spaceReveal')}</span>
            <span>{t('review.hotkey.vSpeak')}</span>
            <span>{t('review.hotkey.rateKeys')}</span>
          </div>
          {/* 管理层 entry — the demoted deck rail lives behind this quiet
              toggle (?view=browse). Same control geometry as the Focus
              button beside it, but never filled: the manage layer is a
              side room, not a mode you're "in" loudly. Hidden while a
              scope owns the page — the rail is already visible there and
              behaves exactly as before this rework. */}
          {!scoped && (
            <button
              type="button"
              onClick={browseParam ? exitBrowse : enterBrowse}
              className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
              style={{
                height: '30px',
                padding: '0 12px',
                borderRadius: '6px',
                fontSize: '12px',
                lineHeight: '1',
                background: 'transparent',
              }}
              title={browseParam ? t('review.browse.exitTitle') : t('review.browse.enterTitle')}
            >
              {browseParam ? t('review.browse.exitLabel') : t('review.browse.label')}
            </button>
          )}
          <FocusToggleButton
            active={focusMode}
            onClick={() => setFocusMode((f) => !f)}
            activeTitle={t('review.focus.exitTitle')}
            inactiveTitle={t('review.focus.enterTitle')}
          />
        </div>
      </div>

      {/* =============== Body stage (focus: vertical centering, 卡片垂直居中案) ===============
          A plain alignItems:center on the row would recenter the card —
          and jump its top edge — every time reveal/rate changes its
          height (unrevealed mic widget vs. revealed explanation + ref +
          rating grid are meaningfully different heights). Instead this
          stage reserves a floor height; the states below render
          top-anchored *inside* that floor (normal block flow, no
          centering of their own), and it's the floor itself — constant
          height as long as content fits under it — that gets centered
          in the remaining vertical space. Net effect: the card's top
          edge stays put across reveal/rate for the common case; only
          unusually long cards that overflow the floor will still shift,
          which is an accepted trade (measured: unrevealed ~398px,
          revealed ~449px against a 480px floor). */}
      <div
        className={focusMode ? 'flex-1 min-h-0 flex flex-col' : undefined}
        style={focusMode ? { justifyContent: 'center' } : undefined}
      >
      <div style={focusMode ? { minHeight: '480px' } : undefined}>
      {/* =============== Empty state =============== */}
      {/* 浮现层's zero-due face: calm, not apologetic — nothing surfaced
          today is a good day. One quiet door into the browse layer, same
          container/type treatment as the scoped empty state below. */}
      {isEmpty && surfacing && (
        <div
          className="border border-[var(--ls-border-strong)] text-center"
          style={{ padding: '40px', borderRadius: '10px' }}
        >
          <div className="font-semibold text-[17px] leading-6" style={{ marginBottom: '6px' }}>
            {t('review.surfacing.emptyTitle')}
          </div>
          <p
            className="text-[13px] leading-5 text-[var(--ls-text-secondary)]"
            style={{ marginBottom: '20px' }}
          >
            {t('review.surfacing.emptyBody')}
          </p>
          <button
            type="button"
            onClick={enterBrowse}
            className="inline-flex items-center border border-[var(--ls-border-strong)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
            style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '13px', lineHeight: '1' }}
          >
            {t('review.browse.label')}
          </button>
        </div>
      )}
      {isEmpty && !surfacing && (
        <div
          className="border border-[var(--ls-border-strong)] text-center"
          style={{ padding: '40px', borderRadius: '10px' }}
        >
          <div className="font-semibold text-[17px] leading-6" style={{ marginBottom: '6px' }}>
            {t('review.emptyTitle')}
          </div>
          <p
            className="text-[13px] leading-5 text-[var(--ls-text-secondary)]"
            style={{ marginBottom: '20px' }}
          >
            {t('review.emptyBody')}
          </p>
          <Link
            to="/cards"
            className="inline-flex items-center border border-[var(--ls-border-strong)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
            style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '13px', lineHeight: '1' }}
          >
            {t('review.browseCards')}
          </Link>
        </div>
      )}

      {/* =============== Active state =============== */}
      {isActive && card && (
        <div
          className="border border-[var(--ls-border-strong)] flex flex-col"
          style={{ borderRadius: '10px', minHeight: '300px', padding: '36px 40px 28px' }}
        >
          {/* concept eyebrow + To-pool action — both static, don't flip.
              入池按钮案: To Pending Pool lives here (outside FlipCard) precisely so
              one control works before AND after reveal, front or back,
              without duplicating it on both faces or fighting the flip
              transform or competing with "Reveal & compare" as the primary
              action. Dedup reuses the same pending-pool query Cards.tsx
              reads, so a card already pooled — from either page — shows
              disabled "In pool" here too. */}
          <div
            className="flex items-center justify-between"
            style={{ marginBottom: '24px', gap: '10px' }}
          >
            <div className="text-[11px] leading-4 text-[var(--ls-text-tertiary)] tracking-[0.03em]">
              {card.tags.length > 0 ? card.tags.join(' · ') : '—'}
            </div>
            <ToPoolButton
              pooled={pooledFlashcardIds.has(card.id as unknown as string)}
              pending={
                toPoolMut.isPending &&
                (toPoolMut.variables?.id as unknown as string) ===
                  (card.id as unknown as string)
              }
              onClick={() => toPoolMut.mutate(card)}
            />
          </div>

          {/* card front — focus mode reads bigger (~1.1x), non-focus
              untouched. 自由翻面案 — clicking the front term is the "click
              the card face" toggle: flips to the answer if not yet
              revealed this round, flips back to front if the answer's
              currently showing. Mirrors the Space hotkey below. Stays
              static (outside the flip below) — 真翻转动画案: the question
              stem was never the thing that vanished on flip-back; only
              the answer real estate below it needs to turn over. */}
          <div
            onClick={() => (revealed ? setRevealed(false) : revealCard())}
            className={
              focusMode
                ? 'font-semibold text-[24px] leading-[34px] tracking-[-0.01em] cursor-pointer'
                : 'font-semibold text-[22px] leading-[32px] tracking-[-0.01em] cursor-pointer'
            }
            title={t('review.flipHint')}
          >
            {card.front}
          </div>

          {/* 真翻转动画案 — real rotateY flip between the front (mic + your
              attempt) and back (explanation + reference) real estate.
              `key={card.id}` remounts fresh per card so switching cards
              never plays a flip animation — only an in-card reveal/
              flip-back does. Rating row lives outside this (see below):
              it's the desk, not the card. */}
          <FlipCard
            flipKey={card.id}
            showBack={revealed}
            reduceMotion={prefersReducedMotion}
            front={
              <>
                <div
                  className="border"
                  style={{
                    marginTop: '26px',
                    padding: '16px 18px',
                    borderRadius: '10px',
                    borderColor: 'var(--ls-structure)',
                  }}
                >
                  <div className="flex items-center" style={{ gap: '14px' }}>
                    <MicButton
                      state={recorderState}
                      onClick={toggleRecording}
                      title={micHint}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-[14px] leading-5">
                        {t('review.explainOutLoud')}
                      </div>
                      <div className="text-[12px] leading-[18px] text-[var(--ls-text-secondary)]">
                        {micHint}
                      </div>
                    </div>
                    <span
                      className="flex-none inline-flex items-center justify-center border border-[var(--ls-border-strong)] text-[var(--ls-text-secondary)] font-medium"
                      style={{
                        minWidth: '22px',
                        height: '22px',
                        padding: '0 6px',
                        borderRadius: '5px',
                        fontSize: '11px',
                        lineHeight: '1',
                      }}
                    >
                      V
                    </span>
                    {/* Reset — 一键重置案. Quiet secondary pill, same shape
                        as ToPoolButton below (--ls-border/text-secondary,
                        no new color). Sits at the row's far end, past the
                        label and V badge, so it's never on the mic button's
                        habitual click path. No confirm dialog — a redo is
                        cheap and a confirm would just break the rhythm. */}
                    <button
                      type="button"
                      onClick={resetCapture}
                      disabled={captureIsEmpty}
                      title={t('review.resetCaptureTitle')}
                      className="flex-none inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                      style={{
                        height: '22px',
                        padding: '0 9px',
                        borderRadius: '999px',
                        fontSize: '10px',
                        lineHeight: '1',
                      }}
                    >
                      {t('review.resetCapture')}
                    </button>
                  </div>

                  {/* Recording beads — always mounted (dormant row visible
                      before the first V too, PageDots-style) so stopping
                      settles back into rest instead of an unmount pop.
                      Only 'recording' drives real audio; paused/recognizing
                      read as dormant here — the mic hint text above already
                      carries that distinction (示波器案). */}
                  <RecordingBeads
                    analyserRef={analyserRef}
                    active={recorderState === 'recording'}
                    reducedMotion={prefersReducedMotion}
                  />

                  <AutoSizingTextarea
                    value={attempt}
                    onChange={setAttempt}
                    placeholder={t('review.explainPlaceholder')}
                    large={focusMode}
                  />
                  {audioUrl && (
                    <AudioPlayback
                      url={audioUrl}
                      durationMs={audioDurationMs}
                    />
                  )}
                  {micPermissionIssue && (
                    // 麦克风权限案 — was a barely-visible small-grey-text hint; now
                    // reuses the same border-l-2 + ls-risk warning token as
                    // the fill-blank mismatch callout (lesson/blocks.tsx),
                    // no new style invented.
                    <div
                      className="text-[13px] leading-[21px] border-l-2"
                      style={{
                        marginTop: '10px',
                        paddingLeft: '12px',
                        borderColor: 'var(--ls-risk)',
                        color: 'var(--ls-risk)',
                      }}
                    >
                      {micPermissionIssue === 'insecure'
                        ? t('review.micInsecureContext')
                        : t('review.micPermissionDenied')}
                    </div>
                  )}
                </div>

                <div
                  className="flex items-center flex-wrap"
                  style={{ marginTop: '18px', gap: '14px' }}
                >
                  <button
                    onClick={revealCard}
                    className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 transition-opacity duration-[var(--ls-duration-fast)]"
                    style={{
                      height: '38px',
                      padding: '0 18px',
                      borderRadius: '6px',
                      fontSize: '13px',
                      lineHeight: '1',
                    }}
                  >
                    {t('review.revealCompare')}
                  </button>
                  <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]">
                    {t('review.expressFirstHint')}
                  </span>
                </div>
              </>
            }
            back={
              <div className="flex flex-col" style={{ marginTop: '24px', gap: '14px' }}>
                <div
                  className="border border-[var(--ls-border)] bg-[var(--ls-bg-subtle)]"
                  style={{ padding: '14px 16px', borderRadius: '8px' }}
                >
                  <div
                    className="text-[11px] font-medium leading-4 tracking-[0.04em] uppercase text-[var(--ls-text-tertiary)]"
                    style={{ marginBottom: '8px' }}
                  >
                    {t('review.yourExplanationLabel')}
                    {recorderState === 'recognizing' && (
                      <span
                        className="text-[11px] font-normal normal-case tracking-normal"
                        style={{
                          marginLeft: '8px',
                          color: 'var(--ls-hypothesis)',
                        }}
                      >
                        {t('review.finalizingTranscriptPrefix')}{(recognizingMs / 1000).toFixed(1)}{t('review.finalizingTranscriptSuffix')}
                      </span>
                    )}
                  </div>
                  {attempt ? (
                    <div className={focusMode ? 'text-[16px] leading-[26px]' : 'text-[15px] leading-6'}>{attempt}</div>
                  ) : (
                    <div className="text-[14px] leading-[22px] text-[var(--ls-text-tertiary)]">
                      {t('review.noRecordingFallback')}
                    </div>
                  )}
                  {audioUrl && (
                    <div style={{ marginTop: '10px' }}>
                      <AudioPlayback
                        url={audioUrl}
                        durationMs={audioDurationMs}
                      />
                    </div>
                  )}
                </div>

                <div
                  onClick={() => setRevealed(false)}
                  className="border border-[var(--ls-border-strong)] cursor-pointer"
                  style={{ padding: '14px 16px', borderRadius: '8px' }}
                  title={t('review.flipBackHint')}
                >
                  <div
                    className="text-[11px] font-medium leading-4 tracking-[0.04em] uppercase"
                    style={{ marginBottom: '8px', color: 'var(--ls-corroborated)' }}
                  >
                    {t('quiz.sim.referenceAnswer')}
                  </div>
                  <div className={focusMode ? 'text-[18px] leading-[29px]' : 'text-[16px] leading-[26px]'}>{card.back}</div>
                </div>
              </div>
            }
          />

          {/* Rating row — the desk, not the card: lives outside FlipCard
              so it never participates in the rotateY transform. Gated on
              everRevealed (not revealed) so it stays put through later
              front/back toggles (自由翻面案). */}
          {everRevealed && (
            <div
              className="grid"
              style={{
                marginTop: 'auto',
                paddingTop: '32px',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: '10px',
              }}
            >
              {RATINGS.map((r, i) => (
                <button
                  key={r}
                  onClick={() => rateCurrent(r)}
                  className="flex flex-col items-center border border-[var(--ls-border-strong)] hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)] cursor-pointer"
                  style={{
                    padding: '12px 0',
                    borderRadius: '8px',
                    gap: '6px',
                  }}
                >
                  <span
                    className="inline-flex items-center font-medium text-[13px] leading-none"
                    style={{ gap: '7px' }}
                  >
                    <span
                      className="w-[7px] h-[7px] rounded-full"
                      style={{ background: RATING_COLOR[r] }}
                    />
                    {t(`review.${r.toLowerCase()}` as 'review.again')}
                  </span>
                  <span className="text-[11px] leading-[14px] text-[var(--ls-text-tertiary)] tabular-nums">
                    {ratingCount[r]} · {i + 1}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* =============== Prev/next ghost nav (左右键翻卡案) ===============
          The ask: a click target for J/K-style prev/next, not just
          keyboard. Tried the "‹ card ›" side-by-side placement the brief
          suggested first, but the card box's width is capped (720px /
          880px focus) inside a flex-1 column whose actual free space
          beside it is whatever's left before the sticky DeckRail — at
          narrow viewports that's ~0px, so absolutely-positioned side
          buttons would either overlap the rail or clip off-screen. Falling
          back to the brief's alternative: a small centered pair directly
          under the card, same footprint in both normal and focus mode,
          same treatment as the top bar's hotkey-hint row. Never overlaps
          card content since it's fully outside the bordered box. */}
      {isActive && (
        <div
          className="flex items-center justify-center"
          style={{ marginTop: '14px', gap: '22px' }}
        >
          <NavGhostButton
            symbol="‹"
            title={t('review.prevCard')}
            onClick={goPrev}
            disabled={index === 0 && !detourCard}
          />
          <NavGhostButton symbol="›" title={t('review.nextCard')} onClick={goNext} />
        </div>
      )}

      {/* =============== Done state =============== */}
      {isDone && <DoneState
        ratingCount={ratingCount}
        ratings={ratings}
        cards={cards}
        onRestart={restart}
      />}
      </div>
      </div>
      </div>
      {/* 管理层 — the rail only exists off the surfacing face: summoned by
          the browse toggle (?view=browse) or already present under any
          scope (?lesson=/?course=/picked deck), where its behavior is
          byte-identical to before this rework. */}
      {!surfacing && (
        <DeckRail
          courseGroups={courseGroups}
          totalAll={allCards.length}
          selected={!lessonParam && deckParam ? deckParam : selectedDeck}
          onSelect={(v) => {
            // 课时深链扩展: deck filter and lesson/deck scopes are all queue
            // filters — picking a deck hands the queue over and drops the
            // URL scopes (?lesson= and ?deck= both; the picked deck lives
            // in local state from here on, same as pre-deep-link).
            // Selecting "All due" additionally pins ?view=browse: the click
            // happened inside the rail, and yanking the rail away mid-use
            // (which un-scoping to the bare default face would now do)
            // breaks the manage layer's ground. One combined URLSearchParams
            // write — clearLessonScope + enterBrowse back-to-back would each
            // build from the same stale searchParams and clobber the other.
            const next = new URLSearchParams(searchParams);
            next.delete('lesson');
            next.delete('deck');
            if (v === 'all') next.set('view', 'browse');
            if (next.toString() !== searchParams.toString()) {
              setSearchParams(next, { replace: true });
            }
            setSelectedDeck(v);
          }}
          collapsed={deckRailCollapsed}
          onToggleCollapse={() => setDeckRailCollapsed((c) => !c)}
          deckCards={deckCards}
          dueIds={dueIds}
          currentCardId={card?.id}
          onSelectCard={jumpToCard}
          initialOpenCourseId={courseParam ?? undefined}
        />
      )}
    </div>
    </div>
  );
}

// ============================================================================
// Mic button — three visual states matching the recorder state machine.
// ============================================================================

function MicButton({
  state,
  onClick,
  title,
}: {
  state: RecorderState;
  onClick: () => void;
  title: string;
}) {
  const isIdle = state === 'idle';
  const isRecording = state === 'recording';
  const isPaused = state === 'paused';
  const isRecognizing = state === 'recognizing';

  return (
    <button
      onClick={onClick}
      disabled={isRecognizing}
      title={title}
      className={`flex-none flex items-center justify-center rounded-full transition-colors duration-[var(--ls-duration-fast)] ${
        isRecording ? 'animate-pulse' : ''
      } ${isRecognizing ? 'opacity-60 cursor-not-allowed' : ''}`}
      style={{
        width: '46px',
        height: '46px',
        border: '1.5px solid var(--ls-structure)',
        background: isIdle ? 'transparent' : 'var(--ls-structure)',
      }}
    >
      {isPaused ? (
        // Two vertical bars — universal pause glyph.
        <span
          style={{
            display: 'inline-flex',
            gap: '3px',
            alignItems: 'center',
          }}
        >
          <span style={{ width: '4px', height: '14px', background: '#fff', borderRadius: '1px' }} />
          <span style={{ width: '4px', height: '14px', background: '#fff', borderRadius: '1px' }} />
        </span>
      ) : isRecognizing ? (
        // Small spinner.
        <span
          className="animate-spin"
          style={{
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            border: '2px solid #fff',
            borderTopColor: 'transparent',
          }}
        />
      ) : (
        <span
          style={{
            width: '10px',
            height: '16px',
            borderRadius: '5px',
            background: isRecording ? '#fff' : 'var(--ls-structure)',
            display: 'block',
          }}
        />
      )}
    </button>
  );
}

// ============================================================================
// NavGhostButton — the ‹ › prev/next click targets under the card (左右键
// 翻卡案). Borderless, quiet by default (text-tertiary), only brightens on
// hover — reads as a nav affordance, not a primary action competing with
// Reveal/rate.
// ============================================================================

function NavGhostButton({
  symbol,
  title,
  onClick,
  disabled,
}: {
  symbol: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex-none inline-flex items-center justify-center text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors disabled:opacity-30 disabled:hover:text-[var(--ls-text-tertiary)] disabled:cursor-not-allowed"
      style={{
        fontSize: '22px',
        lineHeight: '1',
        padding: '4px 10px',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      {symbol}
    </button>
  );
}

// ============================================================================
// ToPoolButton — the "To Pending Pool" action (入池按钮案). Small pill, same shape as
// this page's own "Due cards · N" badge in the top bar (border + rounded-
// full + text-secondary) rather than Cards.tsx's bordered RowButton — it
// sits in a card-corner eyebrow row here, not an action bar, so it reads as
// unobtrusive meta rather than a primary control. States mirror Cards.tsx's
// To pool / In pool / Adding… exactly.
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
          ? t('review.toPool.alreadyInPoolTitle')
          : t('review.toPool.sendToPoolTitle')
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

// ============================================================================
// AutoSizingTextarea — grows with content, no manual drag needed.
// ============================================================================

function AutoSizingTextarea({
  value,
  onChange,
  placeholder,
  large,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Focus mode bumps body text ~1.1x. */
  large?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Reset first so scrollHeight reflects real content, not the previous
    // grown height.
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={
        large
          ? 'w-full border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[15px] leading-[23px] placeholder:text-[var(--ls-text-tertiary)] focus:outline-none focus:border-[var(--ls-border-strong)]'
          : 'w-full border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[14px] leading-[22px] placeholder:text-[var(--ls-text-tertiary)] focus:outline-none focus:border-[var(--ls-border-strong)]'
      }
      style={{
        marginTop: '12px',
        minHeight: '70px',
        padding: '10px 12px',
        borderRadius: '6px',
        resize: 'none',
        overflow: 'hidden',
      }}
    />
  );
}

function AudioPlayback({
  url,
  durationMs,
}: {
  url: string;
  durationMs: number;
}) {
  const { t } = useT();
  const audioRef = useRef<HTMLAudioElement>(null);
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  const durLabel = `${mm}:${ss.toString().padStart(2, '0')}`;

  // WebM MediaRecorder blobs don't carry duration metadata → audio.duration
  // reports Infinity on first load, which makes Chrome's built-in controls
  // draw the progress bar backwards on first play. Well-known workaround:
  // seek past the end to force a scan, then reset to 0. After this the
  // browser has a real duration and behaves normally.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    let stopped = false;

    const fixDuration = () => {
      if (stopped) return;
      if (isFinite(el.duration) && el.duration > 0) return;
      // Seek to a huge time to force the browser to walk the whole blob.
      const onTimeUpdate = () => {
        el.removeEventListener('timeupdate', onTimeUpdate);
        if (stopped) return;
        try {
          el.currentTime = 0;
        } catch {
          /* ignore */
        }
      };
      el.addEventListener('timeupdate', onTimeUpdate);
      try {
        el.currentTime = 1e101;
      } catch {
        el.removeEventListener('timeupdate', onTimeUpdate);
      }
    };

    el.addEventListener('loadedmetadata', fixDuration);
    // In some browsers duration is already available (or NaN) before
    // loadedmetadata fires — cover that case too.
    if (el.readyState >= 1) fixDuration();

    return () => {
      stopped = true;
      el.removeEventListener('loadedmetadata', fixDuration);
    };
  }, [url]);

  return (
    <div
      className="flex items-center border border-[var(--ls-border)] bg-[var(--ls-bg)]"
      style={{
        marginTop: '12px',
        padding: '8px 10px',
        borderRadius: '6px',
        gap: '10px',
      }}
    >
      <span
        className="flex-none text-[10px] leading-3 tracking-[0.06em] uppercase font-medium text-[var(--ls-text-tertiary)]"
      >
        {t('review.replayLabel')}
      </span>
      <audio
        ref={audioRef}
        controls
        src={url}
        preload="metadata"
        className="flex-1 min-w-0"
        style={{ height: '32px' }}
      />
      <span className="flex-none text-[11px] tabular-nums text-[var(--ls-text-tertiary)]">
        {durLabel}
      </span>
    </div>
  );
}

// DeckRail (deck filter) lives in ../review/DeckRail.tsx as of DeckRail 右置案 —
// right-placed + collapsible, sharing Mind Map Inspector's rail visual
// language. See that file's doc comment.

function DoneState({
  ratingCount,
  ratings,
  cards,
  onRestart,
}: {
  ratingCount: Record<ReviewRating, number>;
  ratings: ReviewRating[];
  cards: Array<{ tags: string[] }>;
  onRestart: () => void;
}) {
  const { t } = useT();
  const touched = useMemo(() => {
    const all = new Set<string>();
    cards.forEach((c) => c.tags.forEach((t) => all.add(t)));
    return Array.from(all);
  }, [cards]);
  const hadAgain = ratingCount.Again > 0;

  return (
    <div
      className="border border-[var(--ls-border-strong)]"
      style={{ padding: '32px', borderRadius: '10px' }}
    >
      <div className="font-semibold text-[18px] leading-[26px]" style={{ marginBottom: '6px' }}>
        {t('review.doneState.title')}
      </div>
      <p className="text-[13px] leading-5 text-[var(--ls-text-secondary)]" style={{ marginBottom: '22px' }}>
        {ratings.length}{t('review.doneState.cardsReviewedMid')}{touched.length}
        {touched.length === 1 ? t('review.doneState.conceptTouchedSingular') : t('review.doneState.conceptTouchedPlural')}
      </p>

      <div
        className="grid"
        style={{
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '12px',
          marginBottom: '22px',
        }}
      >
        {RATINGS.map((r) => (
          <div
            key={r}
            className="border border-[var(--ls-border)]"
            style={{ padding: '14px', borderRadius: '8px' }}
          >
            <div className="font-semibold text-[22px] leading-[26px] tabular-nums">
              {ratingCount[r]}
            </div>
            <div
              className="flex items-center text-[12px] leading-4 text-[var(--ls-text-secondary)]"
              style={{ gap: '6px', marginTop: '4px' }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: RATING_COLOR[r] }}
              />
              {t(`review.${r.toLowerCase()}` as 'review.again')}
            </div>
          </div>
        ))}
      </div>

      <div
        className="text-[13px] leading-5 text-[var(--ls-text-secondary)]"
        style={{ marginBottom: hadAgain ? '14px' : '22px' }}
      >
        {t('review.doneState.conceptsTouchedLabel')}{' '}
        <span style={{ color: 'var(--ls-text)' }}>{touched.join(', ') || '—'}</span>
      </div>

      {hadAgain && (
        <div
          className="text-[13px] leading-5 text-[var(--ls-text-secondary)]"
          style={{
            borderLeft: '2px solid var(--ls-hypothesis)',
            padding: '8px 0 8px 12px',
            marginBottom: '22px',
          }}
        >
          {t('review.doneState.againHitPrefix')}<span style={{ color: 'var(--ls-text)' }}>{t('review.again')}</span>{t('review.doneState.againHitSuffix')}
        </div>
      )}

      <div className="flex flex-wrap" style={{ marginTop: '22px', gap: '10px' }}>
        <button
          onClick={onRestart}
          className="inline-flex items-center border border-[var(--ls-border-strong)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
          style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '13px', lineHeight: '1' }}
        >
          {t('review.doneState.reviewAgainButton')}
        </button>
        {/* Dashboard 裁撤案: Dashboard 裁撤后 "今天" 落点已不存在 — 改指新的
            默认落点 /lesson (Courses)，文案同步. 这是本批唯一碰
            pages/ 其余 的地方，brief §81.4 明确要求死链改指新家。 */}
        <Link
          to="/lesson"
          className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 transition-opacity duration-[var(--ls-duration-fast)]"
          style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '13px', lineHeight: '1' }}
        >
          {t('review.doneState.backToCourses')}
        </Link>
      </div>
    </div>
  );
}
