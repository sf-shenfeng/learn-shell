// Two read-back views for the agent's memory system — the "eyes" to match
// the existing "pen" (record_learner_hypothesis / record_post_lesson_evaluation /
// reflect_on_teaching write only, nothing reads back).
//
// get_context  — one-shot cold-start orient. Token-frugal by design: every
//                field here is a count, an id, or a one-line summary. Full
//                text (lesson markdown, snapshot rolling_summary, message
//                bodies) never appears — pull it via the existing granular
//                tools/resources once you know *which* thing to open.
// get_learner_brief — pre-lesson reading of the learner model. Every field
//                returned is meant to change what happens in the next lesson;
//                fields that wouldn't move a teaching decision are left out.
//
// Both are read-only: no inserts/updates, no migrations, safe to poll.
//
// Response shapes are defined locally (not in packages/contracts) — these
// are server-internal projections, not wire types shared with the web app.

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  learner_agent_pairs,
  learners,
  agents,
  courses,
  lessons,
  post_lesson_evaluations,
  learner_hypotheses,
  teacher_reflections,
  pending_mindmap_cards,
  live_sessions,
  mid_lesson_snapshots,
  ad_hoc_threads,
  ad_hoc_messages,
  reminders,
  exercises,
  exercise_submissions,
} from '../db/schema';
import { getCurrentContract, listCurrentContracts, type ContractRow } from './currentContract';
import { formatSourceMaterialLine } from './source-material';
import { selectBriefHypotheses } from './hypothesis-lifecycle';
import { contentHash12 } from './content-hash';
import { isNewerEventId } from './live-wait';
import { getLessonAxesForLessons, type LessonAxes } from './lesson-state';
import { CONFIDENCE_LEVELS, type ConfidenceLevel } from './confidence';
import { evaluateCourseCompletion } from './course-completion';
import type { LessonProgressState } from '@learn-shell/contracts';

// ============================================================================
// Shared: pair existence + self-healing error surface
// ============================================================================

export interface AvailablePairBrief {
  id: string;
  active: boolean;
  learner_id: string;
}

/** Cheap listing used to make "pair not found" errors self-healing. */
export async function listAvailablePairs(): Promise<AvailablePairBrief[]> {
  const rows = await db.select().from(learner_agent_pairs);
  return rows.map((r) => ({ id: r.id, active: r.active, learner_id: r.learner_id }));
}

export async function pairExists(pairId: string): Promise<boolean> {
  const rows = await db
    .select({ id: learner_agent_pairs.id })
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.id, pairId))
    .limit(1);
  return rows.length > 0;
}

// ============================================================================
// 0018 (§1/§5) — shared "not expired
// weather" predicate. A ⑥ (weather) TeacherReflection past its
// weather_expires_at must not surface in ANY read path: this MCP module's
// buildLearnerBrief, the pair://teacher/reflections resource in mcp/server.ts,
// and the HTTP /pairs/:pairId/reflections route in routes/read.ts all query
// teacher_reflections directly — compose this into each of those `where`
// clauses rather than filtering post-fetch, so pagination/limit stay correct.
//
// Non-weather rows (primary_attribution !== 'weather') and pre-0018 legacy
// rows (weather_expires_at is null either way) always pass via the `isNull`
// branch — only a weather row whose expiry has actually passed is excluded.
// ============================================================================

export function notExpiredWeatherFilter() {
  return or(
    ne(teacher_reflections.primary_attribution, 'weather'),
    isNull(teacher_reflections.weather_expires_at),
    gt(teacher_reflections.weather_expires_at, sql`now()`)
  );
}

// ============================================================================
// Identity — who this pair *is* (称谓体系, 2026-07-07)
// ============================================================================
//
// The registry has always existed (learners/agents tables, VISION-v4), but no
// read surface carried it — every UI fell back to the generic word "agent".
// Both orient endpoints now return the registered names so downstream surfaces
// render "<agent_display_name>的观察" instead of "agent_observation". Names are data, not style:
// this does NOT filter or flavor the agent's voice (soul-layer red line).

export interface IdentityBrief {
  /** 语言合同 (迁移 0044): locale 是学习者的语言主权——学习者可见
   *  文本 (learner_note / 课文正文等) 用这个语言写; null = 没表达过, 跟随
   *  对话现场。get_context 与 get_learner_brief 经 identity 各带一份,
   *  开课/评估前都廉价可见。 */
  learner: { id: string; display_name: string; locale: string | null };
  agent: { id: string; display_name: string; identity_note: string | null };
}

export async function buildIdentity(pairId: string): Promise<IdentityBrief | null> {
  const rows = await db
    .select({
      learner_id: learners.id,
      learner_name: learners.display_name,
      learner_locale: learners.locale,
      agent_id: agents.id,
      agent_name: agents.display_name,
      agent_note: agents.identity_note,
    })
    .from(learner_agent_pairs)
    .innerJoin(learners, eq(learner_agent_pairs.learner_id, learners.id))
    .innerJoin(agents, eq(learner_agent_pairs.agent_id, agents.id))
    .where(eq(learner_agent_pairs.id, pairId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    learner: { id: r.learner_id, display_name: r.learner_name, locale: r.learner_locale ?? null },
    agent: { id: r.agent_id, display_name: r.agent_name, identity_note: r.agent_note ?? null },
  };
}

// ============================================================================
// get_context — cold-start orient
// ============================================================================

export interface ContractBriefLine {
  id: string;
  /** teaching_contracts has no literal `title` column — `goal` doubles as it. */
  title: string;
  setup_status: string;
  /** One-line progress: setup-step tally while provisioning, lesson tally once ready. */
  progress: string;
  /** 自带教材条款 (迁移 0040) — 合约带 source_material 时的一行
   *  亮灯 (`教材:《title》(year) · reliance(档位)`, formatSourceMaterialLine)。
   *  null = 这份合约没谈教材。教师每次 get_context 都廉价看见, 不用翻合同。 */
  source_material: string | null;
}

export interface RecentLessonLine {
  id: string;
  title: string;
  /** 教学闭环状态 (lesson_progress.state — not_started/in_progress/
   *  completed_declared/closed), NOT lessons.status (那是内容生成态: proposed/
   *  generating/generated, 一个完全不同的字段, 两个真相源撞了名字). null when
   *  this pair has no lesson_progress row for the lesson yet (等价 not_started,
   *  但该行本身还不存在). */
  status: string | null;
  /** ISO timestamp of the PostLessonEvaluation that surfaced this lesson;
   *  null when there's no teaching activity yet and this is a course-start fallback. */
  last_activity_at: string | null;
}

export interface PendingPoolBrief {
  count: number;
  latest_titles: string[];
}

export interface LiveSessionBrief {
  id: string;
  status: string;
  ended_at: string | null;
  latest_snapshot: { exists: boolean; created_at: string | null };
}

// State 2.0 (迁移 0030, 文书三幕剧: 立约 → 履约 → 结业) — "这份合约教得怎么样
// 了, 够不够格结业" 的结构化投影, 供 agent 判断是否该建议学习者走
// contract-complete 流程 (complete_contract 工具, MCP 纵队领地, 不在这批施工
// 范围)。与 buildContractProgress() 那个"一行摘要字符串"(ContractBriefLine.
// progress) 是两回事——那个是给人看的一句话, 这个是给程序判断用的结构化字段。
export interface ContractProgressLine {
  contract_id: string;
  /** teaching_contracts 无 title 列 — goal 兼职当标题, 同 ContractBriefLine。 */
  goal: string;
  covered_course_count: number;
  /** operationally_caught_up 口径下"已完成"的覆盖课数量 (逐课判据见
   *  lib/course-completion.ts evaluateCourseCompletion 的 caughtUp — 该课程
   *  至少一节已发布课, 且全部已发布课 learning ∈ {completed_declared,
   *  closed})。零已发布课(还没开始教)不计入 —— 空真值会把"从没开课"的
   *  课程误判成"已完成"。*不*看 planned_lesson_count —— 那道门槛只影响
   *  goal_completion_ready, 见下。 */
  completed_course_count: number;
  /** ready_to_complete 拆分 (α批四针, 2026-07-20, 红队: "结业应是有证据
   *  的判断") —— 旧的单一 ready_to_complete 布尔值焊死了"读完已发布的课"
   *  和"教够了计划节数"两层判据, 拆成 operationally_caught_up /
   *  goal_completion_ready 两个字段, 调用方能分清到底卡在哪一层。
   *
   *  operationally_caught_up: covered_course_ids 为空恒 false; 非空时 = 全部
   *  覆盖课都 caughtUp (旧 ready_to_complete 口径 —— 已发布课全部到终态,
   *  不看 planned_lesson_count, 该字段为空/为 null 时也可以为 true)。 */
  operationally_caught_up: boolean;
  /** goal_completion_ready: 在 operationally_caught_up 基础上, 还须每门覆盖
   *  课的 planned_lesson_count 非空且已发布节数 ≥ planned —— 覆盖单里存在
   *  一门未定 planned_lesson_count 的课时恒 false (逐课判据见
   *  evaluateCourseCompletion 的 goalReady)。 */
  goal_completion_ready: boolean;
}

/** 一次性算完 pair 名下多份合约的 contract_progress —— 所有合约的
 *  covered_course_ids 合并去重后一次取课、一次取轴 (getLessonAxesForLessons)、
 *  一次取 planned_lesson_count, 不逐合约、逐课程重复查询 (N+1 禁令同样适用
 *  于这里)。逐课"算不算完成"的判据本身走 lib/course-completion.ts
 *  evaluateCourseCompletion ——与 mcp/server.ts complete_contract 前置校验③
 *  同源, 避免 planned_lesson_count 新口径在两处分叉。 */
async function buildContractProgressLines(
  pairId: string,
  contracts: ContractRow[]
): Promise<ContractProgressLine[]> {
  const allCourseIds = Array.from(new Set(contracts.flatMap((c) => c.covered_course_ids)));

  // ready_to_complete 拆分 (α批四针, 2026-07-20) — 逐课两层判据同源自
  // evaluateCourseCompletion: caughtUp (旧口径) / goalReady (caughtUp 基础上
  // 还须 planned_lesson_count 非空且够数)。
  const courseCaughtUp = new Map<string, boolean>();
  const courseGoalReady = new Map<string, boolean>();
  if (allCourseIds.length > 0) {
    const lessonRows = await db
      .select({ id: lessons.id, course_id: lessons.course_id })
      .from(lessons)
      .where(inArray(lessons.course_id, allCourseIds));

    // 迁移 0032 — planned_lesson_count, null = 未定(旧课兼容口径, 见
    // evaluateCourseCompletion 头注)。
    const courseRows = await db
      .select({ id: courses.id, planned_lesson_count: courses.planned_lesson_count })
      .from(courses)
      .where(inArray(courses.id, allCourseIds));
    const plannedByCourse = new Map(courseRows.map((r) => [r.id, r.planned_lesson_count]));

    const lessonIdsByCourse = new Map<string, string[]>();
    for (const row of lessonRows) {
      const arr = lessonIdsByCourse.get(row.course_id) ?? [];
      arr.push(row.id);
      lessonIdsByCourse.set(row.course_id, arr);
    }

    const axesByLesson = await getLessonAxesForLessons(
      db,
      pairId,
      lessonRows.map((r) => r.id)
    );

    for (const courseId of allCourseIds) {
      const lessonIds = lessonIdsByCourse.get(courseId) ?? [];
      const publishedLessons = lessonIds
        .map((id) => ({ id, axes: axesByLesson.get(id) }))
        .filter((l): l is { id: string; axes: LessonAxes } => !!l.axes && l.axes.content === 'published')
        .map((l) => ({ id: l.id, learning: l.axes.learning }));
      const judgment = evaluateCourseCompletion(publishedLessons, plannedByCourse.get(courseId) ?? null);
      courseCaughtUp.set(courseId, judgment.caughtUp);
      courseGoalReady.set(courseId, judgment.goalReady);
    }
  }

  return contracts.map((contract) => {
    const coveredIds = contract.covered_course_ids;
    const caughtUpCount = coveredIds.filter((cid) => courseCaughtUp.get(cid) === true).length;
    const goalReadyCount = coveredIds.filter((cid) => courseGoalReady.get(cid) === true).length;
    return {
      contract_id: contract.id,
      goal: contract.goal,
      covered_course_count: coveredIds.length,
      completed_course_count: caughtUpCount,
      operationally_caught_up: coveredIds.length > 0 && caughtUpCount === coveredIds.length,
      goal_completion_ready: coveredIds.length > 0 && goalReadyCount === coveredIds.length,
    };
  });
}

export interface ContextSnapshot {
  pair_id: string;
  generated_at: string;
  identity: IdentityBrief | null;
  /** field name kept (wire-compat), but "active" no longer
   *  means `teaching_contracts.active = true` (retired column, dead on real
   *  data). Now every contract in a signed, non-terminal setup_status — see
   *  lib/currentContract.ts. */
  active_contracts: ContractBriefLine[];
  recent_lessons: RecentLessonLine[];
  pending_pool: PendingPoolBrief;
  live_session: LiveSessionBrief | null;
  unread_adhoc_count: number;
  active_reminder_count: number;
  /** State 2.0 (迁移 0030) — 现役合约的履约/结业判定, 见 ContractProgressLine。 */
  contract_progress: ContractProgressLine[];
  /** 假设生命周期 (0041) — 在册假设总数 (排除 rejected/frozen/expired)。
   *  get_context 只给计数 + brief_etag; 具体条目归 get_learner_brief
   *  (etag 一致 ⇒ 假设账没变, 不必重拉)。 */
  hypotheses_in_book_count: number;
  /** context/brief 去重 — 默认口径 (limit=5, 无 lesson_id 挂锚)
   *  learner brief 的内容 etag (computeBriefEtag)。与上一次记住的
   *  brief_etag 一致 ⇒ 学生模型没变, 不必再拉 get_learner_brief。 */
  brief_etag: string;
}

async function buildContractProgress(contract: ContractRow): Promise<string> {
  if (contract.setup_status !== 'ready') {
    const steps = contract.setup_steps ?? [];
    if (steps.length === 0) return `setup: ${contract.setup_status}`;
    const done = steps.filter((s) => s.status === 'done').length;
    return `setup: ${contract.setup_status} (${done}/${steps.length} steps)`;
  }
  // 旧文案 "setup: ready (no course yet)" 被外测读成"setup 还没
  // 完成"——其实 setup 已经 ready, 缺的只是课; 改成指路版本, 直说关系已建立、
  // 下一步去哪 (与 mcp/server.ts 874-875 行 "下一步读 recipe://learner-
  // orientation…" 同一措辞口径)。
  if (!contract.course_id) {
    return `setup: ready (established, no course yet — next: recipe://learner-orientation, then start lesson prep)`;
  }

  const courseLessonRows = await db
    .select({ id: lessons.id })
    .from(lessons)
    .where(eq(lessons.course_id, contract.course_id));
  const total = courseLessonRows.length;
  if (total === 0) return `lessons: 0/0`;

  const lessonIds = courseLessonRows.map((r) => r.id);
  const evalRows = await db
    .select({ lesson_id: post_lesson_evaluations.lesson_id })
    .from(post_lesson_evaluations)
    .where(
      and(
        eq(post_lesson_evaluations.pair_id, contract.pair_id),
        inArray(post_lesson_evaluations.lesson_id, lessonIds)
      )
    );
  const touched = new Set(evalRows.map((r) => r.lesson_id)).size;
  return `lessons: ${touched}/${total}`;
}

async function buildRecentLessons(pairId: string): Promise<RecentLessonLine[]> {
  // Recent teaching *activity* — PostLessonEvaluation is the "a lesson just
  // happened" event, so it's a better recency signal than lesson creation
  // order (lessons carry no updated_at/created_at column at all).
  const recentEvals = await db
    .select()
    .from(post_lesson_evaluations)
    .where(eq(post_lesson_evaluations.pair_id, pairId))
    .orderBy(desc(post_lesson_evaluations.created_at))
    .limit(5); // fetch a few extra; dedupe by lesson before slicing to 2

  const seen = new Set<string>();
  const orderedLessonIds: string[] = [];
  const lastActivityByLesson = new Map<string, string>();
  for (const ev of recentEvals) {
    if (!lastActivityByLesson.has(ev.lesson_id)) {
      lastActivityByLesson.set(ev.lesson_id, ev.created_at.toISOString());
    }
    if (!seen.has(ev.lesson_id)) {
      seen.add(ev.lesson_id);
      orderedLessonIds.push(ev.lesson_id);
    }
    if (orderedLessonIds.length >= 2) break;
  }

  if (orderedLessonIds.length > 0) {
    const rows = await db
      .select()
      .from(lessons)
      .where(inArray(lessons.id, orderedLessonIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const progressById = await fetchLessonProgressStates(pairId, orderedLessonIds);
    return orderedLessonIds
      .map((id) => byId.get(id))
      .filter((r): r is typeof lessons.$inferSelect => !!r)
      .map((r) => ({
        id: r.id,
        title: r.title,
        status: progressById.get(r.id) ?? null,
        last_activity_at: lastActivityByLesson.get(r.id) ?? null,
      }));
  }

  // Cold-start fallback: no teaching activity recorded yet. Surface the
  // first lessons of the current (signed non-terminal setup_status)
  // contract's course (if any) so the agent still knows where to start.
  // was `active = true` (dead filter, see lib/currentContract.ts).
  const currentContract = await getCurrentContract(pairId);
  if (!currentContract?.course_id) return [];

  const rows = await db
    .select()
    .from(lessons)
    .where(eq(lessons.course_id, currentContract.course_id))
    .orderBy(asc(lessons.order))
    .limit(2);
  const progressById = await fetchLessonProgressStates(
    pairId,
    rows.map((r) => r.id)
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: progressById.get(r.id) ?? null,
    last_activity_at: null,
  }));
}

// get_context 的 lesson status 关课后读回 null: 根因是"两个字段
// 两个真相源"——buildRecentLessons 原先直接读 lessons.status(内容生成态:
// proposed/generating/generated, Stage 6b 字段, add_lesson 写的课几乎从不设
// 它), 而 close_lesson_loop 写的是 lesson_progress.state(教学闭环态:
// not_started/in_progress/completed_declared/closed)——两张表、两个字段，
// 名字撞了车。真实的"这节课教到哪了"只在 lesson_progress 里，这里改成读那个。
//
// State 2.0 (迁移 0030 同批) — 这里原先是直查 lesson_progress 的散装逻辑, 现
// 改走 lib/lesson-state.ts 单点 (getLessonAxesForLessons), 只取其中的
// learning 轴投影成 Map<lessonId, state> —— 输出形状与调用方(buildRecentLessons)
// 完全不变, 纯替换实现, 不是语义变更。
async function fetchLessonProgressStates(
  pairId: string,
  lessonIds: string[]
): Promise<Map<string, string>> {
  if (lessonIds.length === 0) return new Map();
  const axesByLesson = await getLessonAxesForLessons(db, pairId, lessonIds);
  return new Map([...axesByLesson.entries()].map(([lessonId, axes]) => [lessonId, axes.learning]));
}

async function buildPendingPool(pairId: string): Promise<PendingPoolBrief> {
  // "池子" = still unplaced (辅助池子, TEACHING-SPEC §3.4) — placed cards
  // already landed on a mindmap and are no longer pending triage.
  const stillPendingFilter = and(
    eq(pending_mindmap_cards.owner_pair_id, pairId),
    isNull(pending_mindmap_cards.placed_in_mindmap_id)
  );
  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pending_mindmap_cards)
    .where(stillPendingFilter);
  const latest = await db
    .select({ title: pending_mindmap_cards.title })
    .from(pending_mindmap_cards)
    .where(stillPendingFilter)
    .orderBy(desc(pending_mindmap_cards.created_at))
    .limit(3);
  return {
    count: Number(countRow?.n ?? 0),
    latest_titles: latest.map((r) => r.title),
  };
}

async function buildLiveSessionBrief(pairId: string): Promise<LiveSessionBrief | null> {
  const [sess] = await db
    .select()
    .from(live_sessions)
    .where(eq(live_sessions.pair_id, pairId))
    .orderBy(desc(live_sessions.last_activity_at))
    .limit(1);
  if (!sess) return null;

  const [snap] = await db
    .select({ created_at: mid_lesson_snapshots.created_at })
    .from(mid_lesson_snapshots)
    .where(eq(mid_lesson_snapshots.session_id, sess.id))
    .orderBy(desc(mid_lesson_snapshots.created_at))
    .limit(1);

  return {
    id: sess.id,
    status: sess.status,
    ended_at: sess.ended_at ? sess.ended_at.toISOString() : null,
    latest_snapshot: {
      exists: !!snap,
      created_at: snap ? snap.created_at.toISOString() : null,
    },
  };
}

async function countUnreadAdhoc(pairId: string): Promise<number> {
  // "Unread" has no persisted read-cursor column (adhoc is a single running
  // thread, not a mailbox) — approximate it the same way live_pending /
  // bridge/pending already do: trailing user messages since the last agent
  // reply are what the agent hasn't answered yet, MINUS anything at or
  // before the thread's 消账游标 acked_message_id (adhoc_ack, AdHoc 三票并一
  // 之二 — an acked message must not resurface as "unread" on the next
  // session's first get_context). Here we count *all* trailing user messages
  // (not just the latest), scoped to the one active (non-archived) thread.
  const [thread] = await db
    .select({ id: ad_hoc_threads.id, acked_message_id: ad_hoc_threads.acked_message_id })
    .from(ad_hoc_threads)
    .where(and(eq(ad_hoc_threads.pair_id, pairId), isNull(ad_hoc_threads.archived_at)))
    .orderBy(desc(ad_hoc_threads.created_at))
    .limit(1);
  if (!thread) return 0;

  const [lastAgentMsg] = await db
    .select({ created_at: ad_hoc_messages.created_at })
    .from(ad_hoc_messages)
    .where(and(eq(ad_hoc_messages.thread_id, thread.id), eq(ad_hoc_messages.role, 'agent')))
    .orderBy(desc(ad_hoc_messages.created_at))
    .limit(1);

  const userFilter = lastAgentMsg
    ? and(
        eq(ad_hoc_messages.thread_id, thread.id),
        eq(ad_hoc_messages.role, 'user'),
        gt(ad_hoc_messages.created_at, lastAgentMsg.created_at)
      )
    : and(eq(ad_hoc_messages.thread_id, thread.id), eq(ad_hoc_messages.role, 'user'));

  if (!thread.acked_message_id) {
    // Never acked — keep the original message-body-free count(*) query
    // (zero behavior change for pre-ack threads, no full log load).
    const [countRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(ad_hoc_messages)
      .where(userFilter);
    return Number(countRow?.n ?? 0);
  }

  // Ack cursor set — per-message gate, same exception shape as
  // lib/teacher-inbox.ts's adhocMessageItems (this is an every-trailing-
  // message count, not a "latest message only" check, so it can't go
  // through isAdhocMessageOutstanding; each candidate id is compared
  // directly against the cursor on isNewerEventId's cross-prefix total
  // order — see lib/live-wait.ts header). The cursor lives in id-space,
  // not created_at-space, so this can't stay a pure SQL count(*) — but we
  // select ids only (no bodies/payloads), keeping the "no full log load"
  // property of the original query.
  const rows = await db
    .select({ id: ad_hoc_messages.id })
    .from(ad_hoc_messages)
    .where(userFilter);
  return rows.filter((r) => isNewerEventId(r.id, thread.acked_message_id!)).length;
}

async function countActiveReminders(pairId: string): Promise<number> {
  // "Active" mirrors apps/web/src/pages/Settings.tsx's `upcoming` filter —
  // scheduled but neither fired nor dismissed yet.
  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reminders)
    .where(
      and(eq(reminders.pair_id, pairId), isNull(reminders.fired_at), isNull(reminders.dismissed_at))
    );
  return Number(countRow?.n ?? 0);
}

export async function buildContextSnapshot(pairId: string): Promise<ContextSnapshot> {
  // was `active = true` (dead filter on real data); now every
  // contract in a signed, non-terminal setup_status, via the shared helper.
  const activeContracts = await listCurrentContracts(pairId);

  const contractLines: ContractBriefLine[] = await Promise.all(
    activeContracts.map(async (c) => ({
      id: c.id,
      title: c.goal,
      setup_status: c.setup_status,
      progress: await buildContractProgress(c),
      // 自带教材条款 — 带条款的合约每次都亮 title+档位 一行。
      source_material: c.source_material ? formatSourceMaterialLine(c.source_material) : null,
    }))
  );

  const [identity, recentLessons, pendingPool, liveSession, unreadAdhoc, activeReminders, contractProgress, defaultBrief] =
    await Promise.all([
      buildIdentity(pairId),
      buildRecentLessons(pairId),
      buildPendingPool(pairId),
      buildLiveSessionBrief(pairId),
      countUnreadAdhoc(pairId),
      countActiveReminders(pairId),
      buildContractProgressLines(pairId, activeContracts),
      // brief_etag 按默认口径 (limit=5, 无 lesson_id) 现算, 与
      // get_learner_brief 默认调用返回的 brief_etag 可直接比对。
      buildLearnerBrief(pairId, 5),
    ]);

  return {
    pair_id: pairId,
    generated_at: new Date().toISOString(),
    identity,
    active_contracts: contractLines,
    recent_lessons: recentLessons,
    pending_pool: pendingPool,
    live_session: liveSession,
    unread_adhoc_count: unreadAdhoc,
    active_reminder_count: activeReminders,
    contract_progress: contractProgress,
    hypotheses_in_book_count: defaultBrief.hypotheses_in_book_count,
    brief_etag: defaultBrief.brief_etag,
  };
}

// ============================================================================
// get_learner_brief — pre-lesson learner-model reading
// ============================================================================

// Discriminated shape enforces the sovereignty redaction at the type level:
// once allowed_for_teaching is false, `observation`/`domain`/`confidence`/etc
// simply aren't fields that exist on the value — not just "empty strings".
export type HypothesisBriefItem =
  | {
      id: string;
      allowed_for_teaching: true;
      domain: string;
      observation: string;
      confidence: number;
      last_verified_at: string | null;
      /** 假设生命周期 (0041) — 最近一次证据喂养时刻。 */
      last_evidence_at: string | null;
      /** 陈旧标注 (最轻标注, 读取时现算, 见 lib/hypothesis-lifecycle.ts)。
       *  informational: 事实只当扳机, 不触发自动退役, 不影响入选资格。 */
      stale?: true;
      user_approved: boolean | null;
    }
  | { id: string; allowed_for_teaching: false; redacted: true };

export interface PostLessonEvaluationBrief {
  id: string;
  lesson_id: string;
  concepts_touched: string[];
  flashcards_rating_distribution: Record<'Again' | 'Hard' | 'Good' | 'Easy', number>;
  exercises_submitted_count: number;
  live_turns_count: number;
  duration_minutes: number;
  agent_observation: string;
  created_at: string;
}

export interface ReflectionBrief {
  id: string;
  method: string;
  next_action: string;
  written_at: string;
}

export interface ConfidenceLevelFact {
  level: ConfidenceLevel;
  /** How many confidence-tagged submissions landed at this level, in-window
   *  — counted whether or not grading has happened yet (self-report
   *  frequency isn't gated on grading). */
  count: number;
  /** Mean agent_score in [0,1] for this level's GRADED submissions only,
   *  in-window; null when none of this level's submissions are graded yet. */
  accuracy: number | null;
}

export interface ConfidenceFacts {
  /** 近三课 — the `lessonLimit` most recently touched lessons (by
   *  exercise_submissions.submitted_at) that carry at least one
   *  confidence-tagged submission. Empty array = no confidence data yet. */
  lesson_ids: string[];
  total_count: number;
  overall_accuracy: number | null;
  by_level: ConfidenceLevelFact[];
}

export interface LearnerBrief {
  pair_id: string;
  generated_at: string;
  identity: IdentityBrief | null;
  /** 假设生命周期 (0041) 限载后字段名保留 (wire-compat), 但排序口径已变:
   *  不再纯按 confidence——尊重学习者主权判决 (rejected/frozen/expired 永不
   *  出现), active+confirmed 优先, 组内按 last_evidence_at 降序, 至多
   *  `limit` 条 (默认 BRIEF_HYPOTHESES_CAP=5)。陈旧条目带 stale 轻标注。 */
  top_confidence_hypotheses: HypothesisBriefItem[];
  needs_reverification: HypothesisBriefItem[];
  /** 在册假设总数 (排除 rejected/frozen/expired)。 */
  hypotheses_in_book_count: number;
  /** 人话计数行 ("在册 M 条, 简报只携最近有证据的 N 条"); 在册 0 条时 null。 */
  hypotheses_note: string | null;
  recent_evaluations: PostLessonEvaluationBrief[];
  latest_reflection: ReflectionBrief | null;
  confidence_facts: ConfidenceFacts | null;
  /** 自带教材条款 (迁移 0040) — 当前合约 (getCurrentContract)
   *  带 source_material 时的一行亮灯 (title + 依赖档位), 与 get_context 的
   *  ContractBriefLine.source_material 同一格式。null = 当前合约没谈教材或
   *  没有当前合约。开课前读 brief 的老师必须每次都廉价看见"这门课是跟着
   *  哪本书、哪一档教的"——档位语义与外延标记纪律见 skill
   *  workflow/lesson-prep 教材模式。 */
  source_material: string | null;
  /** 本份 brief 内容的 etag (generated_at 与本字段自身除外,
   *  见 computeBriefEtag)。与上次同参数调用的 brief_etag 一致 ⇒ 学生模型
   *  没变, 内容可复用缓存, 不必逐字段重读。 */
  brief_etag: string;
}

/** brief 内容指纹: 剔除逐次变化的 generated_at 与 brief_etag
 *  自身后做 canonical-JSON content hash。同一学生模型 ⇒ 同一 etag。 */
export function computeBriefEtag(brief: Omit<LearnerBrief, 'brief_etag'>): string {
  const { generated_at: _volatile, ...stable } = brief;
  return contentHash12(stable);
}

// ============================================================================
// Confidence 主权立法 施工点 7 — 中性事实聚合
// ("Confidence 权属"). This is the one legitimate channel confidence data has
// into the brief: raw counts and accuracy, zero adjectives, zero verdicts.
// What is explicitly NOT here: any "she overestimates / underestimates
// herself" judgment — that's what record_learner_hypothesis's ban exists to
// keep out (see that tool's description). confidence_pct (the numeric
// anchor mapping) never appears either — teacher-facing reads get ordinal
// counts only, same red line as pair://exercises/pending.
//
// Batch, not N+1: exactly two db round-trips regardless of data volume —
// one to find the recent lesson_ids, one to pull every confidence-tagged
// submission across all of them at once.
// ============================================================================

export async function buildConfidenceFacts(
  learnerId: string,
  lessonLimit = 3
): Promise<ConfidenceFacts | null> {
  // Scoping is by learnerId, not pairId — exercise_submissions carries
  // learner_id directly (same join pattern lib/calibration.ts already uses:
  // resolve pair → learner_id once, then query submissions by learner_id).
  // Step 1: 近 N 课 — most-recent-submission-first, de-duped to distinct
  // lesson_ids in memory (avoids a DISTINCT-ON-vs-ORDER-BY footgun for a
  // 3-element result). Row cap is generous headroom, not a second limit
  // that needs tuning per learner.
  const recentSubmissionRows = await db
    .select({ lesson_id: exercises.lesson_id, submitted_at: exercise_submissions.submitted_at })
    .from(exercise_submissions)
    .innerJoin(exercises, eq(exercise_submissions.exercise_id, exercises.id))
    .where(
      and(eq(exercise_submissions.learner_id, learnerId), isNotNull(exercise_submissions.confidence))
    )
    .orderBy(desc(exercise_submissions.submitted_at))
    .limit(lessonLimit * 20);

  const lessonIds: string[] = [];
  for (const row of recentSubmissionRows) {
    if (!lessonIds.includes(row.lesson_id)) lessonIds.push(row.lesson_id);
    if (lessonIds.length >= lessonLimit) break;
  }
  if (lessonIds.length === 0) return null;

  // Step 2: every confidence-tagged submission across those lessons, in one
  // shot — count is unconditional (self-report frequency), accuracy only
  // over the graded subset.
  const rows = await db
    .select({
      confidence: exercise_submissions.confidence,
      agent_score: exercise_submissions.agent_score,
    })
    .from(exercise_submissions)
    .innerJoin(exercises, eq(exercise_submissions.exercise_id, exercises.id))
    .where(
      and(
        eq(exercise_submissions.learner_id, learnerId),
        inArray(exercises.lesson_id, lessonIds),
        isNotNull(exercise_submissions.confidence)
      )
    );

  const countByLevel = new Map<ConfidenceLevel, number>();
  const scoresByLevel = new Map<ConfidenceLevel, number[]>();
  for (const lvl of CONFIDENCE_LEVELS) {
    countByLevel.set(lvl, 0);
    scoresByLevel.set(lvl, []);
  }
  const allScores: number[] = [];
  let totalCount = 0;
  for (const row of rows) {
    if (!row.confidence) continue;
    totalCount += 1;
    countByLevel.set(row.confidence, (countByLevel.get(row.confidence) ?? 0) + 1);
    if (row.agent_score !== null && row.agent_score !== undefined) {
      scoresByLevel.get(row.confidence)?.push(row.agent_score);
      allScores.push(row.agent_score);
    }
  }

  const by_level: ConfidenceLevelFact[] = CONFIDENCE_LEVELS.map((level) => {
    const scores = scoresByLevel.get(level) ?? [];
    return {
      level,
      count: countByLevel.get(level) ?? 0,
      accuracy: scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : null,
    };
  });

  return {
    lesson_ids: lessonIds,
    total_count: totalCount,
    overall_accuracy: allScores.length > 0 ? allScores.reduce((s, v) => s + v, 0) / allScores.length : null,
    by_level,
  };
}

function toHypothesisBrief(
  h: typeof learner_hypotheses.$inferSelect,
  stale?: boolean
): HypothesisBriefItem {
  if (!h.allowed_for_teaching) {
    return { id: h.id, allowed_for_teaching: false, redacted: true };
  }
  return {
    id: h.id,
    allowed_for_teaching: true,
    domain: h.domain,
    observation: h.observation,
    confidence: h.confidence,
    last_verified_at: h.last_verified_at ? h.last_verified_at.toISOString() : null,
    last_evidence_at: h.last_evidence_at ? h.last_evidence_at.toISOString() : null,
    ...(stale ? { stale: true as const } : {}),
    user_approved: h.user_approved,
  };
}

export async function buildLearnerBrief(
  pairId: string,
  limit: number,
  lessonId?: string
): Promise<LearnerBrief> {
  // 假设生命周期 (0041) — 限载选择抽在 lib/hypothesis-lifecycle.ts 的
  // selectBriefHypotheses (纯函数, 好单测): 学习者主权判决尊重到底
  // (rejected/frozen 永不回简报, 老师侧死状态 expired 同排——此前 frozen 还
  // 以 redacted 存根占位, 现在连存根都不给), active+confirmed 优先,
  // 组内按 last_evidence_at 降序, 至多 limit 条, 陈旧条目随行标注。
  // 注: 'tentative' 是 record_learner_hypothesis 的实际首写状态 (contracts
  // HypothesisStatus 头注), 排在 active/confirmed 之后但同样在册。
  const now = new Date();
  const allHyps = await db
    .select()
    .from(learner_hypotheses)
    .where(eq(learner_hypotheses.pair_id, pairId));
  const selection = selectBriefHypotheses(allHyps, limit, now);
  // 主权 redaction 仍逐条过 toHypothesisBrief (allowed_for_teaching=false →
  // 存根)——排除表之外若还有别的路径把 allowed_for_teaching 置 false,
  // 内容照样不外泄。
  const topConfidence = selection.selected.map(({ row, stale }) => toHypothesisBrief(row, stale));

  // needs_reverification 从"已入选的 ≤limit 条"里挑 (最久未验证优先)——限载
  // 承诺是"简报至多携 limit 条假设", 这个子清单不额外夹带第 limit+1 条。
  const byStalenessAsc = selection.selected
    .map((s) => s.row)
    .sort((a, b) => {
      const at = a.last_verified_at ? a.last_verified_at.getTime() : -Infinity;
      const bt = b.last_verified_at ? b.last_verified_at.getTime() : -Infinity;
      return at - bt; // nulls (never verified) sort first
    });
  const needsReverification = byStalenessAsc.slice(0, 2).map((h) => toHypothesisBrief(h));

  const recentEvalRows = await db
    .select()
    .from(post_lesson_evaluations)
    .where(eq(post_lesson_evaluations.pair_id, pairId))
    .orderBy(desc(post_lesson_evaluations.created_at))
    .limit(3);
  const recentEvaluations: PostLessonEvaluationBrief[] = recentEvalRows.map((r) => ({
    id: r.id,
    lesson_id: r.lesson_id,
    concepts_touched: r.concepts_touched,
    flashcards_rating_distribution: r.flashcards_rating_distribution,
    exercises_submitted_count: r.exercises_submitted_count,
    live_turns_count: r.live_turns_count,
    duration_minutes: r.duration_minutes,
    agent_observation: r.agent_observation,
    created_at: r.created_at.toISOString(),
  }));

  // 反思挂锚 (W1C) — 若调用方传了 lessonId 且这节课有挂锚反思
  // (teacher_reflections.lesson_id 命中), 优先给这节课的最新一条; 没命中
  // (未传 lessonId, 或这节课还没人挂锚反思过——含全部存量反思, 它们的
  // lesson_id 恒 null) 就落回原有的 pair 级最新一条, 读现状、最小改法。
  let latestReflectionRow: typeof teacher_reflections.$inferSelect | undefined;
  if (lessonId) {
    [latestReflectionRow] = await db
      .select()
      .from(teacher_reflections)
      .where(
        and(
          eq(teacher_reflections.pair_id, pairId),
          eq(teacher_reflections.lesson_id, lessonId),
          notExpiredWeatherFilter()
        )
      )
      .orderBy(desc(teacher_reflections.written_at))
      .limit(1);
  }
  if (!latestReflectionRow) {
    [latestReflectionRow] = await db
      .select()
      .from(teacher_reflections)
      .where(and(eq(teacher_reflections.pair_id, pairId), notExpiredWeatherFilter()))
      .orderBy(desc(teacher_reflections.written_at))
      .limit(1);
  }
  const latestReflection: ReflectionBrief | null = latestReflectionRow
    ? {
        id: latestReflectionRow.id,
        method: latestReflectionRow.method,
        next_action: latestReflectionRow.next_action,
        written_at: latestReflectionRow.written_at.toISOString(),
      }
    : null;

  const identity = await buildIdentity(pairId);
  const confidenceFacts = identity ? await buildConfidenceFacts(identity.learner.id) : null;

  // 自带教材条款 — 当前合约带条款时每次 brief 都亮一行, 见
  // LearnerBrief.source_material 的字段注释。
  const currentContract = await getCurrentContract(pairId);
  const sourceMaterialLine = currentContract?.source_material
    ? formatSourceMaterialLine(currentContract.source_material)
    : null;

  const withoutEtag: Omit<LearnerBrief, 'brief_etag'> = {
    pair_id: pairId,
    generated_at: new Date().toISOString(),
    identity,
    top_confidence_hypotheses: topConfidence,
    needs_reverification: needsReverification,
    hypotheses_in_book_count: selection.inBookCount,
    hypotheses_note: selection.countLine,
    recent_evaluations: recentEvaluations,
    latest_reflection: latestReflection,
    confidence_facts: confidenceFacts,
    source_material: sourceMaterialLine,
  };
  return { ...withoutEtag, brief_etag: computeBriefEtag(withoutEtag) };
}
