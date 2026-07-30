// apps/server/src/lib/lesson-closure-facts.ts — 关课前置事实装配, Live 2.0
// 二期 W2 件二 + 件四共用。
//
// 从 mcp/server.ts 的 close_lesson_loop case 里抽出来的共享 DB 读取层:
// 四道硬检 (lib/close-loop-guard.ts evaluateCloseLoop) 里 ①②④ 三道"从 DB
// 数出发生了什么"的部分现在只写一份, close_lesson_loop 本体与新增的只读
// get_lesson_closure_state 同吃这份查询——不许两处各手写一遍"这节课批完了吗
// / 有没有已完成 Live / 证据挂哪"。③ (回执 ref_id 逐条验存在) 不在这里:
// 它依赖调用方自己那批 receipt 参数, 是 close_lesson_loop 独有的输入校验,
// 没有可共享的部分。
//
// fetchHasPostLessonEvaluation / fetchAnchoredReflectionExists 另外供
// grade_exercise / update_lesson / publish_lesson (件四, "无条件
// 推荐三窝") 的状态感知推荐复用——同一条"这节课是否已有总评/是否已挂锚反思"
// 的判定, 不要在四个 case 里各写一份。
//
// 判定纯函数留在 close-loop-guard.ts (那边的既有分工: 只做无副作用的
// 事实→结论映射, 好单测; 这里只管取数, 不做任何"合不合格"的判断)。

import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db/client';
import {
  courses,
  lessons,
  exercises,
  exercise_submissions,
  post_lesson_evaluations,
  live_sessions,
  mid_lesson_snapshots,
  live_session_evaluations,
  lesson_loop_receipts,
  lesson_progress,
  teacher_reflections,
  concepts,
} from '../db/schema';

// ---------------------------------------------------------------------------
// 判错递笔共用阈值 ("判错递笔"+"错题卡事实行") — grade_exercise 的
// 判错递笔 (mcp/server.ts case 'grade_exercise') 与本文件的错题卡事实行
// (assembleLessonClosureCoreFacts) 都要回答同一个问题"这份提交算不算判错",
// 单点定义在这里、两处 import,不各写一份阈值。
//
// 老实话: exercise_submissions 没有离散的 verdict 字段 — grade_exercise 只
// 收一个可选的 0..1 软分 (agent_score) + 必填的自由文本 feedback, 从未有过
// correct/incorrect 二态。lib/calibration.ts 头注早就立过规矩: "the grading
// itself is soft, brief doesn't ask for a correctness threshold" — 那处是刻
// 意不发明阈值, 因为它喂的是跨样本的校准曲线, 一旦二值化就会把"软评分"的诚实
// 语义抹掉。这里不是那个场景: 这是单份提交的一次性操作判断("这份要不要配一
// 张针对性闪卡"), 不进任何统计聚合、不喂校准曲线、不留痕成"判决"——纯粹是
// 递笔要不要递的开关。0.5 是这个开关自己的、局部的分界线, 不回灌 calibration
// 的样本, 也不改变 agent_score 本身的软分语义。 (score 缺失 = 没有判断依据,
// 视为"未知", 不算判错——不发明数据。)
const INCORRECT_VERDICT_THRESHOLD = 0.5;

/** 见上方阈值注释——单点定义, grade_exercise 与错题卡事实行共用。 */
export function isIncorrectVerdict(agentScore: number | null | undefined): boolean {
  return agentScore !== null && agentScore !== undefined && agentScore < INCORRECT_VERDICT_THRESHOLD;
}
import { notFoundError, validationError } from './mcp-errors';
import {
  computeLessonClosureState,
  pickLessonClosureNextAction,
  resolveHasReflectedForClose,
} from './close-loop-guard';
import type {
  ClosureProgress,
  LessonClosureStateReport,
  LessonProgressState,
} from '@learn-shell/contracts';

export interface LessonClosureCoreFacts {
  /** 本课已提交未批改的 submission id 清单 (status ∈ submitted/pending_grade)。 */
  ungradedSubmissionIds: string[];
  /** 本课 (pair+lesson) 是否已有 post_lesson_evaluation。 */
  hasPostLessonEvaluation: boolean;
  /** 本课挂过的每一场 Live session, 不论状态 —— "有 live 时"判定用这个的
   *  length, 不是 completedLiveSessionIds 的 length (一场还在上或已废但从未
   *  completed, 也该算"有 live")。按 started_at 倒序 (最新的在前)。 */
  allLiveSessions: { id: string; status: string }[];
  /** 已完成 (status=completed) 的 live session id 清单。 */
  completedLiveSessionIds: string[];
  /** allLiveSessions 里第一个非 completed 的场次 (active / cancelled /
   *  expired) —— 供 next_required_action 指路: 还在上课就指
   *  live_session_complete, 死会话 (cancelled/expired 且从未 completed) 就
   *  指 live_session_start 重开一场。null = 没有未完成的场次 (要么没上过
   *  Live, 要么每场都 completed 了)。 */
  latestUnfinishedLiveSession: { id: string; status: string } | null;
  /** 每个已完成 live session → 它的 snapshot id 清单。 */
  snapshotIdsBySession: Record<string, string[]>;
  /** 每个已完成 live session → 它的 live_session_evaluation id 清单 (一场
   *  一评, 数组是为了跟 snapshotIdsBySession 同构好复用)。 */
  evaluationIdsBySession: Record<string, string[]>;
  /** 错题卡事实行 — 只读事实, 不进 missing[], 不带 severity。
   *  本课已批改且落进"判错"区间 (isIncorrectVerdict, 阈值见上) 的提交数。 */
  incorrectSubmissionCount: number;
  /** 上面那批判错提交所属习题的 expected_concepts 去重后的概念总数 (分母,
   *  只数"判错习题"牵连的概念, 不是全课概念)。 */
  incorrectConceptsTotal: number;
  /** 分母里已经挂了至少一张闪卡的概念数 (concepts.flashcard_ids.length>0 ——
   *  读概念自身的回填字段, 不查 flashcards 表: add_flashcard 写卡时已经把
   *  反向链接维护好了 (P1-b), 这里白拿, 查询很轻, 不需要另开一次 flashcards
   *  表扫描。) */
  incorrectConceptsWithFlashcard: number;
}

/** 件四复用点 (grade_exercise / update_lesson-邻近 / publish_lesson 状态感知
 *  推荐) —— 单独导出, 不逼着调用方拉一整套 assembleLessonClosureCoreFacts。 */
export async function fetchHasPostLessonEvaluation(pairId: string, lessonId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: post_lesson_evaluations.id })
    .from(post_lesson_evaluations)
    .where(and(eq(post_lesson_evaluations.pair_id, pairId), eq(post_lesson_evaluations.lesson_id, lessonId)))
    .limit(1);
  return !!row;
}

/** 共享事实装配 — close_lesson_loop (四道硬检①②④的事实来源) 与
 *  get_lesson_closure_state (只读状态机) 同吃这一份查询。
 *
 *  验收判词回炉 (2026-07-20, pair 归属校验): 入口先做存在性+归属双检——
 *  lessons 本身不带 pair_id, 经 courses.pair_id 判归属 (与 reflect_on_teaching
 *  的挂锚校验同款 join 链)。下沉在这里而不是两个 case 各写一道, 是因为下面的
 *  exercises/submissions 查询只按 lesson_id 过滤, 任何未来第三个调用方漏了
 *  入口校验都会把别的 pair 的课当自己的事实装配出来——闸门跟数据长在一起才
 *  堵得死。过不了双检直接抛 (notFound / validation), 不返回半份事实。 */
export async function assembleLessonClosureCoreFacts(
  pairId: string,
  lessonId: string
): Promise<LessonClosureCoreFacts> {
  const [lessonRow] = await db
    .select({ id: lessons.id, pair_id: courses.pair_id })
    .from(lessons)
    .innerJoin(courses, eq(lessons.course_id, courses.id))
    .where(eq(lessons.id, lessonId))
    .limit(1);
  if (!lessonRow) {
    throw notFoundError(`Lesson ${lessonId} not found`, { lesson_id: lessonId });
  }
  if (lessonRow.pair_id !== pairId) {
    throw validationError(
      `lesson_id '${lessonId}' belongs to a different pair — closing a lesson / querying closure state only works on lessons belonging to the current pair.`,
      { field: 'lesson_id', lesson_id: lessonId }
    );
  }

  const lessonExercises = await db
    .select({ id: exercises.id, expected_concepts: exercises.expected_concepts })
    .from(exercises)
    .where(eq(exercises.lesson_id, lessonId));
  const lessonExerciseIds = lessonExercises.map((e) => e.id);
  let ungradedSubmissionIds: string[] = [];
  // 错题卡事实行的三个数字, 与上面 ungraded 查询各自独立 (那边
  // 只看 submitted/pending_grade, 这边只看已批改且判错的)。
  let incorrectSubmissionCount = 0;
  let incorrectConceptsTotal = 0;
  let incorrectConceptsWithFlashcard = 0;
  if (lessonExerciseIds.length > 0) {
    const [subs, gradedSubs] = await Promise.all([
      db
        .select({ id: exercise_submissions.id, graded_at: exercise_submissions.graded_at })
        .from(exercise_submissions)
        .where(
          and(
            inArray(exercise_submissions.exercise_id, lessonExerciseIds),
            inArray(exercise_submissions.status, ['submitted', 'pending_grade'])
          )
        ),
      db
        .select({ exercise_id: exercise_submissions.exercise_id, agent_score: exercise_submissions.agent_score })
        .from(exercise_submissions)
        .where(
          and(
            inArray(exercise_submissions.exercise_id, lessonExerciseIds),
            eq(exercise_submissions.status, 'graded')
          )
        ),
    ]);
    ungradedSubmissionIds = subs.filter((s) => s.graded_at === null).map((s) => s.id);

    const incorrectExerciseIds = new Set<string>();
    for (const s of gradedSubs) {
      if (isIncorrectVerdict(s.agent_score)) {
        incorrectSubmissionCount++;
        incorrectExerciseIds.add(s.exercise_id);
      }
    }
    if (incorrectExerciseIds.size > 0) {
      const conceptIdSet = new Set<string>();
      for (const ex of lessonExercises) {
        if (incorrectExerciseIds.has(ex.id)) {
          for (const cid of ex.expected_concepts) conceptIdSet.add(cid);
        }
      }
      incorrectConceptsTotal = conceptIdSet.size;
      if (conceptIdSet.size > 0) {
        const conceptRows = await db
          .select({ id: concepts.id, flashcard_ids: concepts.flashcard_ids })
          .from(concepts)
          .where(inArray(concepts.id, [...conceptIdSet]));
        incorrectConceptsWithFlashcard = conceptRows.filter((c) => c.flashcard_ids.length > 0).length;
      }
    }
  }

  const hasPostLessonEvaluation = await fetchHasPostLessonEvaluation(pairId, lessonId);

  const allLive = await db
    .select({ id: live_sessions.id, status: live_sessions.status })
    .from(live_sessions)
    .where(
      and(
        eq(live_sessions.pair_id, pairId),
        eq(live_sessions.context_type, 'lesson'),
        eq(live_sessions.context_id, lessonId)
      )
    )
    .orderBy(desc(live_sessions.started_at));
  const allLiveSessions = allLive.map((s) => ({ id: s.id, status: s.status as string }));
  const completedLiveSessionIds = allLiveSessions.filter((s) => s.status === 'completed').map((s) => s.id);
  const latestUnfinishedLiveSession = allLiveSessions.find((s) => s.status !== 'completed') ?? null;

  const snapshotIdsBySession: Record<string, string[]> = {};
  const evaluationIdsBySession: Record<string, string[]> = {};
  if (completedLiveSessionIds.length > 0) {
    const [snaps, liveEvals] = await Promise.all([
      db
        .select({ id: mid_lesson_snapshots.id, session_id: mid_lesson_snapshots.session_id })
        .from(mid_lesson_snapshots)
        .where(inArray(mid_lesson_snapshots.session_id, completedLiveSessionIds)),
      db
        .select({ id: live_session_evaluations.id, session_id: live_session_evaluations.live_session_id })
        .from(live_session_evaluations)
        .where(inArray(live_session_evaluations.live_session_id, completedLiveSessionIds)),
    ]);
    for (const s of snaps) (snapshotIdsBySession[s.session_id] ??= []).push(s.id);
    for (const e of liveEvals) (evaluationIdsBySession[e.session_id] ??= []).push(e.id);
  }

  return {
    ungradedSubmissionIds,
    hasPostLessonEvaluation,
    allLiveSessions,
    completedLiveSessionIds,
    latestUnfinishedLiveSession,
    snapshotIdsBySession,
    evaluationIdsBySession,
    incorrectSubmissionCount,
    incorrectConceptsTotal,
    incorrectConceptsWithFlashcard,
  };
}

// ---------------------------------------------------------------------------
// get_lesson_closure_state-only 取数 (close_lesson_loop 不需要 —— 它自己就是
// 写 receipts/closed 的那一刻, 不必先读)。
// ---------------------------------------------------------------------------

export async function fetchHasReceipts(pairId: string, lessonId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: lesson_loop_receipts.id })
    .from(lesson_loop_receipts)
    .where(and(eq(lesson_loop_receipts.pair_id, pairId), eq(lesson_loop_receipts.lesson_id, lessonId)))
    .limit(1);
  return !!row;
}

export async function fetchLessonProgressState(
  pairId: string,
  lessonId: string
): Promise<LessonProgressState | null> {
  const [row] = await db
    .select({ state: lesson_progress.state })
    .from(lesson_progress)
    .where(and(eq(lesson_progress.pair_id, pairId), eq(lesson_progress.lesson_id, lessonId)))
    .limit(1);
  return (row?.state as LessonProgressState | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// 反思挂锚双轨口径的取数半边 (纯判定半边是 close-loop-guard.ts 的
// resolveHasReflectedForClose, W1C 口径)。
// ---------------------------------------------------------------------------

/** 挂锚精确判定: 这节课本身是否已有挂锚命中的 teacher_reflections 行。
 *  也是 update_lesson (件四) 状态感知推荐复用的同一条判定。
 *
 *  拓宽口径 (真实误读案例): 命中 = lesson_id 直接等于本课,
 *  OR lesson_id 为空但 live_session_id 指向本课挂的某场 Live (live_sessions.
 *  context_type='lesson' ∧ context_id=本课)。只带场次锚不带课锚的反思在 0035
 *  之后是合法写法 (两列都可选), 它明明白白属于这节课的某场课, 聚合却曾只认
 *  lesson_id——写入各自成功、聚合装不认识, closure_progress 的 reflection 项
 *  于是永远缺。join 侧再验一次 live_sessions.pair_id, 防跨 pair 场次借道。 */
export async function fetchAnchoredReflectionExists(pairId: string, lessonId: string): Promise<boolean> {
  const rows = await db
    .select({ id: teacher_reflections.id })
    .from(teacher_reflections)
    .leftJoin(live_sessions, eq(teacher_reflections.live_session_id, live_sessions.id))
    .where(
      and(
        eq(teacher_reflections.pair_id, pairId),
        or(
          eq(teacher_reflections.lesson_id, lessonId),
          and(
            eq(live_sessions.pair_id, pairId),
            eq(live_sessions.context_type, 'lesson'),
            eq(live_sessions.context_id, lessonId)
          )
        )
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** 近似判定的"上一次关课"基准 — 按 closed_at 倒序取第 skip+1 条。
 *  close_lesson_loop 是在关课事务提交之后才算这个 (此时最新一条已关课行就
 *  是本课自己, 要 skip=1 跳过取第二新); get_lesson_closure_state 是关课前
 *  只读, 本课根本不在已关课集合里, skip=0 直接取最新一条即可。两边基准不同
 *  纯粹因为查询时机不同, 不是两套逻辑——故 skip 参数由调用方按自己的语境传。 */
export async function fetchMostRecentCloseAt(pairId: string, skip = 0): Promise<Date | null> {
  const rows = await db
    .select({ closed_at: lesson_progress.closed_at })
    .from(lesson_progress)
    .where(and(eq(lesson_progress.pair_id, pairId), eq(lesson_progress.state, 'closed')))
    .orderBy(desc(lesson_progress.closed_at))
    .limit(skip + 1);
  return rows[skip]?.closed_at ?? null;
}

/** 近似判定: 这个 pair 自 sinceCloseAt 之后是否写过任意一条反思 (pair 粒度,
 *  没有挂锚数据时的 fallback — 同 close_lesson_loop 既有的
 *  hasReflectedSinceLastCloseApprox 口径)。
 *
 *  修基准: sinceCloseAt 为 null (= 这个 pair 从没关过课, 或本次关课
 *  就是第一次) 时, 曾直接 return false——把"没有上一次关课"错读成"没反思过"。
 *  按口径本义 ("自上一次关课之后"), 没有上一次关课就意味着 pair 迄今写过的
 *  每一条反思都在窗口内: 有任意一条即算数。真实误读案例正踩在这条上: 第一节课
 *  reflect(未挂锚)→close 成功, close 后 skip=1 取"上一次关课"得 null, 近似
 *  判定被短路成 false, 刚写的反思在 closure_progress 里仍报缺。 */
export async function fetchReflectedSinceApprox(pairId: string, sinceCloseAt: Date | null): Promise<boolean> {
  const [latest] = await db
    .select({ written_at: teacher_reflections.written_at })
    .from(teacher_reflections)
    .where(eq(teacher_reflections.pair_id, pairId))
    .orderBy(desc(teacher_reflections.written_at))
    .limit(1);
  if (!latest?.written_at) return false;
  return sinceCloseAt === null || latest.written_at > sinceCloseAt;
}

// ---------------------------------------------------------------------------
// closure_progress 随行回执 (红队第六轮针二, 2026-07-20) — 单一装配点, get_
// lesson_closure_state 与 record_live_evaluation / record_post_lesson_
// evaluation / reflect_on_teaching(带锚) / close_lesson_loop 四工具的成功
// 回执共用。事实取数(本文件以上函数)+ 判定(close-loop-guard.ts 的纯函数)
// 拼一遍, 与 mcp/server.ts 原先在 get_lesson_closure_state case 里手写的那段
// 逐行同源——现在两处(只读状态机 + 四工具随行回执)都调这一个函数, 不再各写
// 一份。
// ---------------------------------------------------------------------------

/** 完整装配一次 (lesson_id + state + completed/missing + next_required_
 *  action) —— get_lesson_closure_state 直接拿这份当返回体; 四工具随行回执
 *  用 toClosureProgress() 裁掉 lesson_id/state 两个字段 (调用方自己就是那次
 *  调用的参数, 不必回声; state 由 missing 是否为空隐含)。
 *
 *  `recentCloseSkip` 直传给 fetchMostRecentCloseAt (默认 0, 语义见该函数
 *  头注)——close_lesson_loop 在关课事务提交之后调用本函数装配 closure_
 *  progress 时必须传 1: 此时最新一条已关课行就是本课自己, 若仍用默认的 0,
 *  "反思是否发生在最近一次关课之后"这条近似判定会拿本课自己刚写下的
 *  closed_at 当基准, 把"关课前已经写好的反思"错判成"没赶上"——四工具里唯独
 *  close_lesson_loop 是"先落一次关课事实、再回头问关课事实"的调用方, 其余
 *  三个 (record_live_evaluation / record_post_lesson_evaluation /
 *  reflect_on_teaching) 都发生在这节课关课之前, 默认的 0 (最新一条关课行=
 *  上一节课或没有) 对它们才是对的语境。 */
export async function computeLessonClosureProgress(
  pairId: string,
  lessonId: string,
  opts: { recentCloseSkip?: number } = {}
): Promise<LessonClosureStateReport> {
  const coreFacts = await assembleLessonClosureCoreFacts(pairId, lessonId);
  const hasLive = coreFacts.allLiveSessions.length > 0;
  const hasCompletedLive = coreFacts.completedLiveSessionIds.length > 0;
  const hasLiveEvidence = coreFacts.completedLiveSessionIds.some(
    (sid) =>
      (coreFacts.snapshotIdsBySession[sid]?.length ?? 0) > 0 ||
      (coreFacts.evaluationIdsBySession[sid]?.length ?? 0) > 0
  );
  const hasLiveEvaluation = coreFacts.completedLiveSessionIds.some(
    (sid) => (coreFacts.evaluationIdsBySession[sid]?.length ?? 0) > 0
  );

  const [hasReceipts, progressState, anchoredExists, mostRecentCloseAt] = await Promise.all([
    fetchHasReceipts(pairId, lessonId),
    fetchLessonProgressState(pairId, lessonId),
    fetchAnchoredReflectionExists(pairId, lessonId),
    fetchMostRecentCloseAt(pairId, opts.recentCloseSkip ?? 0),
  ]);
  const reflectedSinceApprox = await fetchReflectedSinceApprox(pairId, mostRecentCloseAt);
  const hasReflectedForClose = resolveHasReflectedForClose(anchoredExists, reflectedSinceApprox);
  const isClosed = progressState === 'closed';

  const stateResult = computeLessonClosureState({
    ungradedSubmissionIds: coreFacts.ungradedSubmissionIds,
    hasLive,
    hasCompletedLive,
    hasLiveEvidence,
    hasLiveEvaluation,
    hasPostLessonEvaluation: coreFacts.hasPostLessonEvaluation,
    hasReflectedForClose,
    hasReceipts,
    isClosed,
  });

  const latestUnfinished = coreFacts.latestUnfinishedLiveSession;
  const nextRequiredAction = pickLessonClosureNextAction(stateResult.state, {
    lessonId,
    firstUngradedSubmissionId: coreFacts.ungradedSubmissionIds[0],
    latestUnfinishedLiveSessionId: latestUnfinished?.id,
    latestUnfinishedLiveSessionIsDead: latestUnfinished ? latestUnfinished.status !== 'active' : undefined,
    firstCompletedLiveSessionId: coreFacts.completedLiveSessionIds[0],
  });

  return {
    lesson_id: lessonId as LessonClosureStateReport['lesson_id'],
    state: stateResult.state,
    completed: stateResult.completed,
    missing: stateResult.missing,
    next_required_action: nextRequiredAction,
    // 错题卡事实行 — 纯陈述, 不进 completed/missing 任何一边, 不
    // 带 severity, 只在 get_lesson_closure_state 的完整报告里出现:
    // toClosureProgress() 下面显式只挑 3 个字段, 四工具随行的精简版
    // closure_progress 因此不带这一条, 保持那四份既有回执的体积不因这条新
    // 事实膨胀。
    incorrect_review_signal: {
      incorrect_submission_count: coreFacts.incorrectSubmissionCount,
      concepts_with_flashcard: coreFacts.incorrectConceptsWithFlashcard,
      concepts_total: coreFacts.incorrectConceptsTotal,
    },
  };
}

/** 裁剪成随行回执的 closure_progress 形状(三字段) —— 见 computeLessonClosureProgress 头注。 */
export function toClosureProgress(report: LessonClosureStateReport): ClosureProgress {
  return {
    completed: report.completed,
    missing: report.missing,
    next_required_action: report.next_required_action,
  };
}
