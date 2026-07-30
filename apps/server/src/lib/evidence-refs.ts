// apps/server/src/lib/evidence-refs.ts — 证据引用真伪校验 (硬闸)。
//
// 哲学一句: 机器守真不真, 不碰好不好。引用的内容质量归声纹与老师裁量, 但
// "被引用的 id 必须真实存在且属于当前 pair" 从本批起由这里统一把守——证据
// 先于叙事, 幽灵引用在写入口就被拒, 不等下游读到断链才发现。
//
// 四个入口, 一套查询底座:
//   assertSessionEventEvidence — record_learner_hypothesis 的
//     evidence_event_ids (③): 逐个必须存在于 session_events 且
//     pair_id = 当前 pair。批量一查, 不逐 id round-trip。
//   assertEvidenceRefs — 评估三通道 (迁移 0044) 的 evidence_refs:
//     每个 id 须落在证据合法落点表之一 (见 EVIDENCE_REF_TABLES) 且属本 pair。
//   assertActionLinkTarget — reflect_on_teaching 的 action_link.ref_id
//     (④): 按 type 查对应落点表, 幽灵 → VALIDATION。
//   assertLiveResponseRef — exercise_submissions.live_response_id:
//     须指向本 pair 的真实 teaching_responses 行。
//
// 归属链路照现有读路径惯例 (lib/read-back.ts 头注同款):
//   session_events / live_sessions / live_session_evaluations /
//   learner_hypotheses / courses               — 自带 pair_id
//   teaching_responses / mid_lesson_snapshots  — ⋈ live_sessions.pair_id
//   lessons / lesson_revisions                 — ⋈ courses.pair_id
//   exercises / concepts                       — ⋈ lessons ⋈ courses.pair_id
//   exercise_submissions                       — ⋈ exercises ⋈ lessons ⋈ courses
//   flashcards / lesson_patches                — 自带 pair_id

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import {
  courses,
  lessons,
  lesson_revisions,
  lesson_patches,
  concepts,
  exercises,
  exercise_submissions,
  flashcards,
  learner_hypotheses,
  session_events,
  live_sessions,
  live_session_evaluations,
  mid_lesson_snapshots,
  teaching_responses,
} from '../db/schema';
import { validationError } from './mcp-errors';
import type { ActionLinkType } from '@learn-shell/contracts';

// ---------------------------------------------------------------------------
// 底座: 多表批量归属查询
// ---------------------------------------------------------------------------

export type EvidenceRefTable =
  | 'session_events'
  | 'exercise_submissions'
  | 'teaching_responses'
  | 'live_sessions'
  | 'live_session_evaluations'
  | 'mid_lesson_snapshots'
  | 'learner_hypotheses'
  | 'flashcards'
  | 'lessons'
  | 'lesson_revisions'
  | 'lesson_patches'
  | 'concepts'
  | 'exercises'
  | 'courses';

/** 每表一条批量查询 (只查被要求的表), 返回 id → 命中的表清单。查不到 =
 *  不存在或不属于本 pair —— 两种情况同一个答案, 不泄露他 pair 数据的存在性
 *  (同 lib/read-back.ts 的归属纪律)。 */
export async function resolveRefPresence(
  pairId: string,
  ids: string[],
  tables: EvidenceRefTable[]
): Promise<Record<string, EvidenceRefTable[]>> {
  const presence: Record<string, EvidenceRefTable[]> = {};
  if (ids.length === 0 || tables.length === 0) return presence;
  const add = (id: string, table: EvidenceRefTable) => {
    (presence[id] ??= []).push(table);
  };

  const queries: Promise<void>[] = [];
  const want = new Set(tables);

  if (want.has('session_events')) {
    queries.push(
      db
        .select({ id: session_events.event_id })
        .from(session_events)
        .where(and(inArray(session_events.event_id, ids), eq(session_events.pair_id, pairId)))
        .then((rows) => rows.forEach((r) => add(r.id, 'session_events')))
    );
  }
  if (want.has('exercise_submissions')) {
    queries.push(
      db
        .select({ id: exercise_submissions.id })
        .from(exercise_submissions)
        .innerJoin(exercises, eq(exercise_submissions.exercise_id, exercises.id))
        .innerJoin(lessons, eq(exercises.lesson_id, lessons.id))
        .innerJoin(courses, eq(lessons.course_id, courses.id))
        .where(and(inArray(exercise_submissions.id, ids), eq(courses.pair_id, pairId)))
        .then((rows) => rows.forEach((r) => add(r.id, 'exercise_submissions')))
    );
  }
  if (want.has('teaching_responses')) {
    queries.push(
      db
        .select({ id: teaching_responses.id })
        .from(teaching_responses)
        .innerJoin(live_sessions, eq(teaching_responses.session_id, live_sessions.id))
        .where(and(inArray(teaching_responses.id, ids), eq(live_sessions.pair_id, pairId)))
        .then((rows) => rows.forEach((r) => add(r.id, 'teaching_responses')))
    );
  }
  if (want.has('live_sessions')) {
    queries.push(
      db
        .select({ id: live_sessions.id })
        .from(live_sessions)
        .where(and(inArray(live_sessions.id, ids), eq(live_sessions.pair_id, pairId)))
        .then((rows) => rows.forEach((r) => add(r.id, 'live_sessions')))
    );
  }
  if (want.has('live_session_evaluations')) {
    queries.push(
      db
        .select({ id: live_session_evaluations.id })
        .from(live_session_evaluations)
        .where(and(inArray(live_session_evaluations.id, ids), eq(live_session_evaluations.pair_id, pairId)))
        .then((rows) => rows.forEach((r) => add(r.id, 'live_session_evaluations')))
    );
  }
  if (want.has('mid_lesson_snapshots')) {
    queries.push(
      db
        .select({ id: mid_lesson_snapshots.id })
        .from(mid_lesson_snapshots)
        .innerJoin(live_sessions, eq(mid_lesson_snapshots.session_id, live_sessions.id))
        .where(and(inArray(mid_lesson_snapshots.id, ids), eq(live_sessions.pair_id, pairId)))
        .then((rows) => rows.forEach((r) => add(r.id, 'mid_lesson_snapshots')))
    );
  }
  if (want.has('learner_hypotheses')) {
    queries.push(
      db
        .select({ id: learner_hypotheses.id })
        .from(learner_hypotheses)
        .where(and(inArray(learner_hypotheses.id, ids), eq(learner_hypotheses.pair_id, pairId)))
        .then((rows) => rows.forEach((r) => add(r.id, 'learner_hypotheses')))
    );
  }
  if (want.has('flashcards')) {
    queries.push(
      db
        .select({ id: flashcards.id })
        .from(flashcards)
        .where(and(inArray(flashcards.id, ids), eq(flashcards.pair_id, pairId)))
        .then((rows) => rows.forEach((r) => add(r.id, 'flashcards')))
    );
  }
  if (want.has('lessons')) {
    queries.push(
      db
        .select({ id: lessons.id })
        .from(lessons)
        .innerJoin(courses, eq(lessons.course_id, courses.id))
        .where(and(inArray(lessons.id, ids), eq(courses.pair_id, pairId)))
        .then((rows) => rows.forEach((r) => add(r.id, 'lessons')))
    );
  }
  if (want.has('lesson_revisions')) {
    queries.push(
      db
        .select({ id: lesson_revisions.id })
        .from(lesson_revisions)
        .innerJoin(lessons, eq(lesson_revisions.lesson_id, lessons.id))
        .innerJoin(courses, eq(lessons.course_id, courses.id))
        .where(and(inArray(lesson_revisions.id, ids), eq(courses.pair_id, pairId)))
        .then((rows) => rows.forEach((r) => add(r.id, 'lesson_revisions')))
    );
  }
  if (want.has('lesson_patches')) {
    queries.push(
      db
        .select({ id: lesson_patches.id })
        .from(lesson_patches)
        .where(and(inArray(lesson_patches.id, ids), eq(lesson_patches.pair_id, pairId)))
        .then((rows) => rows.forEach((r) => add(r.id, 'lesson_patches')))
    );
  }
  if (want.has('concepts')) {
    queries.push(
      db
        .select({ id: concepts.id })
        .from(concepts)
        .innerJoin(lessons, eq(concepts.lesson_id, lessons.id))
        .innerJoin(courses, eq(lessons.course_id, courses.id))
        .where(and(inArray(concepts.id, ids), eq(courses.pair_id, pairId)))
        .then((rows) => rows.forEach((r) => add(r.id, 'concepts')))
    );
  }
  if (want.has('exercises')) {
    queries.push(
      db
        .select({ id: exercises.id })
        .from(exercises)
        .innerJoin(lessons, eq(exercises.lesson_id, lessons.id))
        .innerJoin(courses, eq(lessons.course_id, courses.id))
        .where(and(inArray(exercises.id, ids), eq(courses.pair_id, pairId)))
        .then((rows) => rows.forEach((r) => add(r.id, 'exercises')))
    );
  }
  if (want.has('courses')) {
    queries.push(
      db
        .select({ id: courses.id })
        .from(courses)
        .where(and(inArray(courses.id, ids), eq(courses.pair_id, pairId)))
        .then((rows) => rows.forEach((r) => add(r.id, 'courses')))
    );
  }

  await Promise.all(queries);
  return presence;
}

// ---------------------------------------------------------------------------
// ③ 假设证据: evidence_event_ids 只认 session_events
// ---------------------------------------------------------------------------

/** record_learner_hypothesis (③): evidence_event_ids 逐个必须是本 pair
 *  的真实 session_event id。含无效 id → VALIDATION, 列出坏 id。
 *  空数组不在这里管 (那是 ① "空证据不刷时间戳" 的事, 不是错误)。 */
export async function assertSessionEventEvidence(
  pairId: string,
  ids: string[],
  field = 'evidence_event_ids'
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const presence = await resolveRefPresence(pairId, unique, ['session_events']);
  const invalid = unique.filter((id) => !(presence[id] ?? []).includes('session_events'));
  if (invalid.length > 0) {
    throw validationError(
      `${field} contains invalid evidence id(s) (not found in session_events, or not belonging to the current pair): ${invalid.join(', ')}. ` +
        'Evidence comes before narrative — references must be real. Use get_context / a read-back (get_submission etc.) / ' +
        "the event stream at GET /api/pairs/:pairId/sessions to find a real event id; if you're not sure, leave it out — " +
        'empty evidence is valid (it just is not counted as feeding).',
      { field, invalid_ids: invalid }
    );
  }
}

// ---------------------------------------------------------------------------
// 三通道 evidence_refs: 证据合法落点表
// ---------------------------------------------------------------------------

/** 评估 evidence_refs 的合法落点: 引用的是"这次判断依据的具体事实"——
 *  作答 (sub_)、Live 回答 (tr_)、事件 (evt_)、快照 (snap_)、场次、既有
 *  假设。课文/概念不在此列: 那是教学对象, 不是证据。 */
export const EVIDENCE_REF_TABLES: EvidenceRefTable[] = [
  'session_events',
  'exercise_submissions',
  'teaching_responses',
  'live_sessions',
  'mid_lesson_snapshots',
  'learner_hypotheses',
];

/** 评估三通道 evidence_refs: 每个 id 须落在
 *  EVIDENCE_REF_TABLES 之一且属本 pair; 幽灵 → VALIDATION 列出坏 id。 */
export async function assertEvidenceRefs(
  pairId: string,
  ids: string[],
  field = 'evidence_refs'
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const presence = await resolveRefPresence(pairId, unique, EVIDENCE_REF_TABLES);
  const invalid = unique.filter((id) => (presence[id] ?? []).length === 0);
  if (invalid.length > 0) {
    throw validationError(
      `${field} contains invalid reference id(s) (do not exist, or do not belong to the current pair): ${invalid.join(', ')}. ` +
        `Valid targets: ${EVIDENCE_REF_TABLES.join(' / ')}. Evidence comes before narrative — machine references must be real; ` +
        'use a read-back such as get_context / get_submission / live_session_get to find a real id, or remove this reference.',
      { field, invalid_ids: invalid }
    );
  }
}

// ---------------------------------------------------------------------------
// ④ reflection action_link: 按 type 的落点表
// ---------------------------------------------------------------------------

/** action_link.type → ref_id 的合法落点表。落点选择服从现实 (recipe
 *  grade-attribute-revise 的既有指引): lesson_revision 最精确填
 *  update_lesson 回执的 lesson_revision_id, 也接受课文本体; 其余类型没有
 *  专属"行动记录表", 允列的是各自语义下最相关的真实实体。 */
export const ACTION_LINK_REF_TABLES: Record<ActionLinkType, EvidenceRefTable[]> = {
  // ① not_yet_mastered — 复习队列动作: 卡/题/概念/课文。
  review_action: ['flashcards', 'exercises', 'concepts', 'lessons'],
  // ② material_flaw — 修订: 修订行本体或被修订的课文。
  lesson_revision: ['lesson_revisions', 'lessons'],
  // ③ difficulty_timing — 课程顺序/难度调整: 课程或课文。
  course_adjustment: ['courses', 'lessons'],
  // ④ path_mismatch — 下次换路声明: 课文/场次/事件/教师笔记 patch。
  intervention_note: ['lessons', 'live_sessions', 'session_events', 'lesson_patches'],
  // ⑤⑦ — 假设管线。
  hypothesis_update: ['learner_hypotheses'],
  // ⑥ weather — 仅延后重测: 要重测的题/卡/课文。
  retest_only: ['exercises', 'flashcards', 'lessons'],
};

/** reflect_on_teaching (④): action_link.ref_id 按 type 验存在+归属。 */
export async function assertActionLinkTarget(
  pairId: string,
  type: ActionLinkType,
  refId: string
): Promise<void> {
  const tables = ACTION_LINK_REF_TABLES[type];
  const presence = await resolveRefPresence(pairId, [refId], tables);
  if ((presence[refId] ?? []).length === 0) {
    throw validationError(
      `action_link.ref_id '${refId}' does not exist or does not belong to the current pair — valid targets for type '${type}': ` +
        `${tables.join(' / ')}. Attribution must connect to a real action: reference a real id (e.g. the ` +
        "lesson_revision_id from an update_lesson receipt, or a hypothesis id from get_learner_brief) — don't make one up from memory.",
      { field: 'action_link.ref_id', ref_id: refId, action_link_type: type, expected_tables: tables }
    );
  }
}

// ---------------------------------------------------------------------------
// live_response_id → teaching_responses (同 pair)
// ---------------------------------------------------------------------------

export interface LiveResponseRefCheck {
  ok: boolean;
  /** 命中时随手带回所属场次 id (调用方想记日志/回显用, 不强制)。 */
  live_session_id?: string;
}

/** exercise_submissions.live_response_id: 须指向本 pair 的真实
 *  teaching_responses 行。REST 写入口用布尔结果自拼 400 (那边不是
 *  McpToolError 的地界), 故这里不抛、只报。 */
export async function checkLiveResponseRef(
  pairId: string,
  liveResponseId: string
): Promise<LiveResponseRefCheck> {
  const [row] = await db
    .select({ id: teaching_responses.id, live_session_id: live_sessions.id })
    .from(teaching_responses)
    .innerJoin(live_sessions, eq(teaching_responses.session_id, live_sessions.id))
    .where(and(eq(teaching_responses.id, liveResponseId), eq(live_sessions.pair_id, pairId)))
    .limit(1);
  if (!row) return { ok: false };
  return { ok: true, live_session_id: row.live_session_id };
}
