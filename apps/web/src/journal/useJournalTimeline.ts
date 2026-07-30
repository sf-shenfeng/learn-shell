// Journal-α data assembly — 纯前端聚合，零新端点.
//
// 数据来源 (先读清单 §4)：
//   课条目      ← getPostLessonEvaluations (主) + getLessons/getCourses (标题/课程
//                 chip) + getExercises/getExerciseSubmissions (成绩) + getAllFlashcards
//                 (新卡计数，按 concept_id ∈ lesson.concept_ids 联接)
//   Live 条目   ← 没有"按 pair 批量取 live session"的读端点，只能按 lesson 反查
//                 (getLiveSessionForLesson)，再对 completed 的取 getLiveSessionFullView
//                 拿轮次数。lesson 数量小，可接受的客户端扇出 (见 β 期端点愿望清单)。
//   复习日条目  ← getRecentSessions 的 cards_reviewed 按天聚合出"卡数"；"命中"
//                 需要逐 session 拉 getSessionEvents 找 review.rated 的 rating，
//                 只对当天真的有复习卡的 session 才拉，扇出同样小。
//   考纲周条目  ← GET /pairs/:id/syllabus 一次性带回的 `mappings` 扁平列表
//                 (created_at 齐全), 按周 (weekKeyOf, ./format.ts) 在这里聚合
//                 出"本周点亮"条目 —— 与复习日条目完全同一惯例: 服务端给原始
//                 行, 分组/聚合发生在这个 hook 里, 不是服务端预算好的现成条目。
//
// 全部聚合在客户端完成 (brief §数据拼装约束 允许 "数据量小" 的场景)。
//
// 考纲登记簿投影落地时的一处偏差,
// 记在这里而不是散在实现里: brief §4 写的是"由 server 在读 Journal 时按周
// 聚合派生（与 review-day 条目同一惯例）", 但 review-day 的真实惯例（就在
// 上面 ↑）是纯客户端聚合, 不存在任何"server 读 Journal"的代码路径——这整个
// 页面零新增聚合端点 (本文件头注)。所以这里选择的是"跟 review-day 的真实
// 惯例保持一致"（客户端聚合), 而不是 brief 字面的"server 聚合"（这里没有
// 那样的基础设施可以复用, 单为这一个条目类型另起一套 server 端聚合会打破
// Journal 现有的架构一致性）。

import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type {
  CourseId,
  Exercise,
  ExerciseSubmission,
  Flashcard,
  Lesson,
  LessonId,
  LiveSession,
  LiveSessionEvaluation,
  LiveSessionFullView,
  Repository,
  SessionEvent,
} from '@learn-shell/contracts';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';
import { useIdentity, cleanAgentName } from '../lib/identity';
import { useT } from '../i18n';
import { AGENT_LABEL_FALLBACK } from './agentLabel';
import { summarizeDay } from './DayGroup';
import { dayKeyOf, weekKeyOf } from './format';
import type {
  JournalEntry,
  LessonJournalEntry,
  LiveJournalEntry,
  ReviewDayJournalEntry,
  SyllabusWeekJournalEntry,
} from './types';
import type { SyllabusRepo, SyllabusSnapshot, SyllabusTreeNode } from '../repository/syllabusExt';

function countTreeNodes(nodes: SyllabusTreeNode[]): number {
  let count = 0;
  for (const n of nodes) count += 1 + countTreeNodes(n.children);
  return count;
}

// 客户端聚合窗口 — 现有 getRecentSessions 端点本身也有默认/可传 limit，
// 这里选一个够用又不至于把 event 扇出撑爆的深度。深过这个窗口的历史
// (复习日 + 热力图) 目前拿不到 — 见报告"β 期端点愿望清单"里的分页建议。
const SESSIONS_WINDOW = 150;

export interface JournalTimeline {
  entries: JournalEntry[];
  courses: { id: CourseId; topic: string }[];
  isLoading: boolean;
  agentLabel: string;
  /** 节律尺案: 节律尺 (journal/RhythmRuler.tsx) 用 — 天 → 当日摘要
   *  ("1 课 · 复习 12 张"), 复用 DayGroup 的组头拼装逻辑 (summarizeDay)
   *  在全量 entries 上按天分桶算出来; 没有 key 的天 = 当天无课/Live/
   *  复习记录. 取代原先粒度更粗的 activeDayKeys（只知道"这天有没有 session"，
   *  不知道有什么）. */
  daySummaries: Map<string, string>;
  hasRepo: boolean;
}

export function useJournalTimeline(): JournalTimeline {
  const repo = useRepository();
  const { pairId, learnerId } = usePair();
  const { t } = useT();
  const enabled = !!repo && !!pairId;

  // ---- layer 1: base reads (one call each) ----

  const coursesQ = useQuery({
    queryKey: ['journal-courses', pairId],
    queryFn: () => (repo && pairId ? repo.getCourses(pairId) : Promise.resolve([])),
    enabled,
  });
  const courses = useMemo(() => coursesQ.data ?? [], [coursesQ.data]);

  const evaluationsQ = useQuery({
    queryKey: ['journal-evaluations', pairId],
    queryFn: () => (repo && pairId ? repo.getPostLessonEvaluations(pairId) : Promise.resolve([])),
    enabled,
  });
  const evaluations = useMemo(() => evaluationsQ.data ?? [], [evaluationsQ.data]);

  const flashcardsQ = useQuery({
    queryKey: ['journal-flashcards', pairId],
    queryFn: () => (repo && pairId ? repo.getAllFlashcards(pairId) : Promise.resolve([])),
    enabled,
  });
  const flashcards = useMemo(() => flashcardsQ.data ?? [], [flashcardsQ.data]);

  const submissionsQ = useQuery({
    queryKey: ['journal-submissions', learnerId],
    queryFn: () =>
      repo && learnerId ? repo.getExerciseSubmissions(learnerId) : Promise.resolve([]),
    enabled: !!repo && !!learnerId,
  });
  const submissions = useMemo(() => submissionsQ.data ?? [], [submissionsQ.data]);

  const sessionsQ = useQuery({
    queryKey: ['journal-sessions', pairId],
    queryFn: () =>
      repo && pairId ? repo.getRecentSessions(pairId, SESSIONS_WINDOW) : Promise.resolve([]),
    enabled,
  });
  const sessions = useMemo(() => sessionsQ.data ?? [], [sessionsQ.data]);

  const EMPTY_SYLLABUS: SyllabusSnapshot = { version: null, nodes: [], mappings: [], coverage_pct: null };
  const syllabusQ = useQuery({
    queryKey: ['journal-syllabus', pairId],
    queryFn: () =>
      repo && pairId
        ? (repo as Repository & SyllabusRepo).getSyllabus(pairId)
        : Promise.resolve(EMPTY_SYLLABUS),
    enabled,
  });
  const syllabusSnapshot = syllabusQ.data ?? EMPTY_SYLLABUS;

  // 称谓来源：identity (apps/server/src/lib/context-brief.ts), 取代原先
  // getCurrentPair→getAgent 两跳临时凑法 (agentLabel.ts 有全部背景).
  // Mock/empty 模式下 identity 恒为 null, 走兜底词——跟之前行为一致.
  const { identity } = useIdentity();
  const agentLabel = identity ? cleanAgentName(identity.agent.display_name) : t(AGENT_LABEL_FALLBACK);

  // ---- layer 2: fan out over courses → lessons ----

  const lessonsQs = useQueries({
    queries: courses.map((c) => ({
      queryKey: ['journal-lessons', c.id],
      queryFn: () => (repo ? repo.getLessons(c.id) : Promise.resolve([])),
      enabled,
    })),
  });
  const lessons: Lesson[] = useMemo(() => lessonsQs.flatMap((q) => q.data ?? []), [lessonsQs]);
  const lessonsSettled = courses.length === 0 || lessonsQs.every((q) => q.isSuccess || q.isError);

  // ---- layer 2b: fan out over lessons → exercises / live-for-lesson ----

  const exercisesQs = useQueries({
    queries: lessons.map((l) => ({
      queryKey: ['journal-exercises', l.id],
      queryFn: () => (repo ? repo.getExercises(l.id) : Promise.resolve([])),
      enabled,
    })),
  });
  const exercises: Exercise[] = useMemo(() => exercisesQs.flatMap((q) => q.data ?? []), [exercisesQs]);

  const liveForLessonQs = useQueries({
    queries: lessons.map((l) => ({
      queryKey: ['journal-live-for-lesson', pairId, l.id],
      queryFn: () =>
        repo && pairId ? repo.getLiveSessionForLesson(pairId, l.id) : Promise.resolve(null),
      enabled,
    })),
  });
  const completedLiveSessions: LiveSession[] = useMemo(
    () =>
      liveForLessonQs
        .map((q) => q.data)
        .filter((s): s is LiveSession => !!s && s.status === 'completed'),
    [liveForLessonQs]
  );

  // ---- layer 3: fan out over completed live sessions → full view (turn count) ----

  const liveFullViewQs = useQueries({
    queries: completedLiveSessions.map((s) => ({
      queryKey: ['journal-live-full', s.id],
      queryFn: () => (repo ? repo.getLiveSessionFullView(s.id) : Promise.resolve(null)),
      enabled,
    })),
  });

  // ---- layer 3b: 同一批 completed session → 场评 (三通道正文) ----
  //
  // Live 条目的正文原本读 live_sessions 的 REFLECT 三段 (教师内账, 见
  // types.ts LiveJournalEntry 的头注)。换源到 live_session_evaluations —— 一场
  // 一评, learner_note/agent_observation/evidence_refs 三通道齐全, 读端点
  // GET /teaching/sessions/:id/evaluation 已在 (routes/teaching.ts), 课文页的
  // LiveSessionEvaluationBlock 走的就是这条, 这里只是让 Journal 也读同一份,
  // 零新端点 (本文件头注的老规矩)。
  //
  // retry:false + 把 isError 当"没有场评"处理, 照抄 LiveSessionEvaluationBlock
  // 的先例: 这是一条可能没有数据的可选记录, 取不到就不占位, 不该冒泡成错误。
  const liveEvalQs = useQueries({
    queries: completedLiveSessions.map((s) => ({
      queryKey: ['journal-live-evaluation', s.id],
      queryFn: () => (repo ? repo.getLiveSessionEvaluation(s.id) : Promise.resolve(null)),
      enabled,
      retry: false,
    })),
  });

  // ---- layer 4: fan out over review-bearing sessions → events (hit rate) ----

  const reviewSessions = useMemo(() => sessions.filter((s) => s.cards_reviewed.length > 0), [sessions]);

  const reviewEventsQs = useQueries({
    queries: reviewSessions.map((s) => ({
      queryKey: ['journal-session-events', s.id],
      queryFn: () => (repo ? repo.getSessionEvents(s.id) : Promise.resolve([])),
      enabled,
    })),
  });

  // ---- assemble ----

  const entries = useMemo(() => {
    const lessonById = new Map(lessons.map((l) => [l.id, l]));
    const courseTopicById = new Map(courses.map((c) => [c.id, c.topic]));

    const lessonEntries: LessonJournalEntry[] = evaluations.map((ev) => {
      const lesson = lessonById.get(ev.lesson_id);
      const courseTopic = lesson ? (courseTopicById.get(lesson.course_id) ?? null) : null;

      const lessonExercises = exercises.filter((ex) => ex.lesson_id === ev.lesson_id);
      const scores: number[] = [];
      for (const ex of lessonExercises) {
        const graded = submissions.filter(
          (s): s is ExerciseSubmission & { agent_score: number } =>
            s.exercise_id === ex.id && s.status === 'graded' && s.agent_score != null
        );
        if (graded.length === 0) continue;
        const latest = graded.reduce((a, b) => ((b.graded_at ?? '') > (a.graded_at ?? '') ? b : a));
        scores.push(latest.agent_score);
      }

      const newCardsCount = lesson
        ? flashcards.filter((f: Flashcard) => f.concept_id && lesson.concept_ids.includes(f.concept_id))
            .length
        : 0;

      return {
        kind: 'lesson',
        id: ev.id,
        date: ev.created_at,
        lessonId: ev.lesson_id,
        lessonTitle: lesson?.title ?? ev.lesson_id,
        courseId: lesson?.course_id ?? null,
        courseTopic,
        exerciseCount: ev.exercises_submitted_count > 0 ? ev.exercises_submitted_count : null,
        exerciseScores: scores,
        newCardsCount: newCardsCount > 0 ? newCardsCount : null,
        durationMinutes: ev.duration_minutes > 0 ? ev.duration_minutes : null,
        learnerNote: ev.learner_note && ev.learner_note.trim() ? ev.learner_note : null,
        agentObservation: ev.agent_observation.trim() ? ev.agent_observation : null,
        evidenceRefs: ev.evidence_refs && ev.evidence_refs.length > 0 ? ev.evidence_refs : null,
      };
    });

    const liveEntries: LiveJournalEntry[] = completedLiveSessions.map((s, i) => {
      const lesson = s.context_type === 'lesson' ? lessonById.get(s.context_id as LessonId) : undefined;
      const fullView: LiveSessionFullView | null | undefined = liveFullViewQs[i]?.data;
      // 正文换源到场评的三通道 (types.ts LiveJournalEntry 头注)。trim
      // 后为空一律折成 null, 与课条目那边同样的"缺席"判定。
      const ev: LiveSessionEvaluation | null | undefined = liveEvalQs[i]?.data;
      const learnerNote = ev?.learner_note && ev.learner_note.trim() ? ev.learner_note : null;
      const agentObservation =
        ev?.agent_observation && ev.agent_observation.trim() ? ev.agent_observation : null;
      return {
        kind: 'live',
        id: s.id,
        date: s.ended_at ?? s.started_at,
        lessonId: s.context_type === 'lesson' ? (s.context_id as LessonId) : null,
        lessonTitle: lesson?.title ?? null,
        courseId: lesson?.course_id ?? null,
        learnerNote,
        agentObservation,
        evidenceRefs: ev?.evidence_refs && ev.evidence_refs.length > 0 ? ev.evidence_refs : null,
        turnCount: fullView ? fullView.moves.length : null,
      };
    });

    // 复习日：按本地日历天聚合 cards_reviewed（去重卡片 id），
    // 命中数需要事件层数据，逐 session 凑齐才给出数字，凑不齐就不占位.
    const dayBuckets = new Map<string, { latestIso: string; cardIds: Set<string>; sessionIds: string[] }>();
    for (const s of reviewSessions) {
      const key = dayKeyOf(s.started_at);
      const bucket = dayBuckets.get(key) ?? { latestIso: s.started_at, cardIds: new Set<string>(), sessionIds: [] };
      for (const cid of s.cards_reviewed) bucket.cardIds.add(cid);
      bucket.sessionIds.push(s.id);
      if (s.started_at > bucket.latestIso) bucket.latestIso = s.started_at;
      dayBuckets.set(key, bucket);
    }

    const eventsBySessionId = new Map<string, SessionEvent[]>();
    reviewSessions.forEach((s, i) => {
      const data = reviewEventsQs[i]?.data;
      if (data) eventsBySessionId.set(s.id, data);
    });

    const reviewDayEntries: ReviewDayJournalEntry[] = Array.from(dayBuckets.entries()).map(
      ([key, bucket]) => {
        let hits = 0;
        let rated = 0;
        let allLoaded = true;
        for (const sid of bucket.sessionIds) {
          const events = eventsBySessionId.get(sid);
          if (!events) {
            allLoaded = false;
            continue;
          }
          for (const e of events) {
            if (e.event_type !== 'review.rated') continue;
            rated += 1;
            if (e.payload.rating === 'Good' || e.payload.rating === 'Easy') hits += 1;
          }
        }
        return {
          kind: 'review-day',
          id: `review-${key}`,
          date: bucket.latestIso,
          dayKey: key,
          cardCount: bucket.cardIds.size,
          hitCount: allLoaded && rated > 0 ? hits : null,
        };
      }
    );

    // 考纲周条目: 按 weekKeyOf 把
    // mappings 分桶, 每桶一条, 按时间顺序累计"已点亮"节点集合算出简化口径的
    // 累计覆盖 % (取舍说明见本文件头注). 没有 mapping 的周不出条目——桶本身
    // 就只在真有 mapping 落在那一周时才会被创建, 天然满足 brief "无新点亮的
    // 周不出条目".
    const totalSyllabusNodes = countTreeNodes(syllabusSnapshot.nodes);
    const weekBuckets = new Map<string, typeof syllabusSnapshot.mappings>();
    for (const m of syllabusSnapshot.mappings) {
      const wk = weekKeyOf(m.created_at);
      const bucket = weekBuckets.get(wk);
      if (bucket) bucket.push(m);
      else weekBuckets.set(wk, [m]);
    }
    const orderedWeekKeys = [...weekBuckets.keys()].sort(); // weekKeyOf → YYYY-MM-DD (Monday), lexical = chronological
    const litSoFar = new Set<string>();
    const syllabusWeekEntries: SyllabusWeekJournalEntry[] = orderedWeekKeys.map((wk) => {
      const items = weekBuckets.get(wk)!;
      for (const it of items) litSoFar.add(it.node_id);

      const sortedByTime = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at));
      const seenCodes = new Set<string>();
      const litNodeCodes: string[] = [];
      for (const it of sortedByTime) {
        if (seenCodes.has(it.code)) continue;
        seenCodes.add(it.code);
        litNodeCodes.push(it.code);
      }
      const latestTs = sortedByTime[sortedByTime.length - 1]!.created_at;
      const cumulativeCoveragePct =
        totalSyllabusNodes > 0 ? Math.round((litSoFar.size / totalSyllabusNodes) * 1000) / 10 : null;

      return {
        kind: 'syllabus-week',
        id: `syllabus-week-${wk}`,
        date: latestTs,
        dayKey: dayKeyOf(latestTs),
        litNodeCodes,
        cumulativeCoveragePct,
      };
    });

    return [...lessonEntries, ...liveEntries, ...reviewDayEntries, ...syllabusWeekEntries].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  }, [
    lessons,
    courses,
    evaluations,
    exercises,
    submissions,
    flashcards,
    completedLiveSessions,
    liveFullViewQs,
    liveEvalQs,
    reviewSessions,
    reviewEventsQs,
    syllabusSnapshot,
  ]);

  // 节律尺案: 按天分桶全量 entries（不受 JournalPage 的课程筛选影响，
  // 节律尺看的是整体节律），每桶丢给 summarizeDay 拼一行摘要.
  const daySummaries = useMemo(() => {
    const byDay = new Map<string, JournalEntry[]>();
    for (const e of entries) {
      const key = e.kind === 'review-day' || e.kind === 'syllabus-week' ? e.dayKey : dayKeyOf(e.date);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(e);
      else byDay.set(key, [e]);
    }
    const out = new Map<string, string>();
    for (const [key, list] of byDay) out.set(key, summarizeDay(list, t));
    return out;
  }, [entries, t]);

  const isLoading =
    coursesQ.isLoading || evaluationsQ.isLoading || sessionsQ.isLoading || !lessonsSettled;

  return {
    entries,
    courses: courses.map((c) => ({ id: c.id, topic: c.topic })),
    isLoading,
    agentLabel,
    daySummaries,
    hasRepo: !!repo,
  };
}
