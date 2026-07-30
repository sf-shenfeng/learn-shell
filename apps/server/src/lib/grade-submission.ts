// grade_exercise 核心写路径 — 从 mcp/server.ts 的 case 体抽出。
//
// 拆成 lib 模块而不是全写在 case 里, 是既定判例 (flashcard-update.ts /
// live-wait 同族头注): mcp/server.ts import 时会开 stdio transport, 测试
// 没法直接吃它 — 核心逻辑住这里, bench DB 测试直连 (见
// grade-submission.db.test.ts)。
//
// P0 修复 (回归考 v2, 核心
// finding): 旧版 handler 只按 submission ID 全局读取 + 更新, 写入提交、
// 记完事件之后, closure_progress 组装环节才靠 lesson/course.pair_id 校验
// 发现"这份提交根本不是当前 pair 的" —— 失败响应与真实写入结果相反 (外
// pair 的提交已经被判成 graded, 且产生一条归错 pair 的 exercise.graded
// 事件)。
//
// 修复口径:
//   · 写入前一次归属校验 — submission → exercise → lesson →
//     course.pair_id 链式 join, 与 read-back.ts 的 getSubmissionReadback
//     同款三级 WHERE (归属纪律头注: 不存在与不属于当前 pair 同一个
//     NOT_FOUND, 不泄露存在性)。找不到直接抛, 一次写入都还没发生。
//   · update 的 WHERE 同时带 submission ID 与 pair 归属子查询 (事务内
//     重新算一遍"这个 pair 名下的 exercise id 都有哪些", 不是复用查询期的
//     旧结果) —— 校验与写入之间理论上的竞态窗口也被同一个 WHERE 兜住:
//     真出现的话 UPDATE 落空, 事务整体回滚, submission/session_events
//     不留痕迹, 与"从未调用过"等价。
//   · grade 更新 + 事件追加在同一个 db.transaction 内提交, 是既有的
//     "Agent Surface Hardening 第一批" 保证, 这里原样保留。
//   · closure_progress 的组装留在 mcp/server.ts case 体里, 在事务之后 ——
//     这个先后顺序本身没有问题: 归属失败的可能性已经在写前一次排除,
//     写后阶段不再可能因为 lesson/pair 不匹配而抛错。

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { courses, lessons, exercises, exercise_submissions, type ExerciseSubmissionRow } from '../db/schema';
import { notFoundError, conflictError } from './mcp-errors';
import { appendSessionEvent } from './session-events';
import { resolveRegradeAttempt, type SubmissionGradeSnapshot } from './regrade';

function submissionNotFound(submissionId: string) {
  return notFoundError(
    `Submission ${submissionId} not found — the id may not exist, may have been deleted, or may not belong to the current pair.`,
    { submission_id: submissionId }
  );
}

interface SubmissionAttribution {
  exercise_id: string;
  lesson_id: string;
  expected_concepts: string[];
  snapshot: SubmissionGradeSnapshot;
}

/** 三级 join, 与 read-back.ts getSubmissionReadback 同款 WHERE — 归属校验
 *  与"取批改现状(供重批判定用)"合并成一次查询, 不另开第二趟。 */
async function findSubmissionAttribution(
  pairId: string,
  submissionId: string
): Promise<SubmissionAttribution | null> {
  const [row] = await db
    .select({
      status: exercise_submissions.status,
      graded_at: exercise_submissions.graded_at,
      agent_score: exercise_submissions.agent_score,
      agent_feedback: exercise_submissions.agent_feedback,
      exercise_id: exercise_submissions.exercise_id,
      lesson_id: lessons.id,
      expected_concepts: exercises.expected_concepts,
    })
    .from(exercise_submissions)
    .innerJoin(exercises, eq(exercise_submissions.exercise_id, exercises.id))
    .innerJoin(lessons, eq(exercises.lesson_id, lessons.id))
    .innerJoin(courses, eq(lessons.course_id, courses.id))
    .where(and(eq(exercise_submissions.id, submissionId), eq(courses.pair_id, pairId)))
    .limit(1);
  if (!row) return null;
  return {
    exercise_id: row.exercise_id,
    lesson_id: row.lesson_id,
    expected_concepts: row.expected_concepts,
    snapshot: {
      status: row.status,
      graded_at: row.graded_at,
      agent_score: row.agent_score,
      agent_feedback: row.agent_feedback,
    },
  };
}

export interface GradeSubmissionInput {
  feedback: string;
  score?: number;
  regrade?: boolean;
}

export interface GradeSubmissionResult {
  row: ExerciseSubmissionRow;
  /** true 当且仅当这是持证改判 (regrade:true 放行的二次批改)。 */
  regraded: boolean;
  lesson_id: string;
  expected_concepts: string[];
}

/** grade_exercise 的完整写路径: 归属校验 → 重批持证判定 → 事务内
 *  (update + event 追加) 原子提交。抛出的都是 McpToolError
 *  (NOT_FOUND / CONFLICT), case 体外层 catch 直接吃。 */
export async function gradeSubmission(
  pairId: string,
  submissionId: string,
  input: GradeSubmissionInput
): Promise<GradeSubmissionResult> {
  // 写入前一次完成归属校验 — 任何 UPDATE/INSERT 发生之前, 外 pair 与不存在
  // 已经在这里被同一个 NOT_FOUND 挡下, 结构上不再可能"先写后错"。
  const attribution = await findSubmissionAttribution(pairId, submissionId);
  if (!attribution) throw submissionNotFound(submissionId);

  const regradeResolution = resolveRegradeAttempt(attribution.snapshot, input.regrade);
  if (regradeResolution.kind === 'refused') {
    throw conflictError(regradeResolution.message, {
      submission_id: submissionId,
      field: 'regrade',
      previous_score: attribution.snapshot.agent_score,
      graded_at: attribution.snapshot.graded_at?.toISOString() ?? null,
    });
  }

  const row = await db.transaction(async (tx) => {
    // pair 归属子查询在事务内重新计算 (不是复用上面查询期的旧结果) ——
    // WHERE 同时带 submission ID 与 pair 归属, 校验与写入之间的竞态窗口
    // 也被兜住: 真发生的话这条 UPDATE 直接落空, 事务回滚, 不留痕迹。
    const pairScopedExerciseIds = tx
      .select({ id: exercises.id })
      .from(exercises)
      .innerJoin(lessons, eq(exercises.lesson_id, lessons.id))
      .innerJoin(courses, eq(lessons.course_id, courses.id))
      .where(eq(courses.pair_id, pairId));

    const [r] = await tx
      .update(exercise_submissions)
      .set({
        status: 'graded',
        agent_feedback: input.feedback,
        agent_score: input.score ?? null,
        graded_at: new Date(),
      })
      .where(
        and(
          eq(exercise_submissions.id, submissionId),
          inArray(exercise_submissions.exercise_id, pairScopedExerciseIds)
        )
      )
      .returning();
    if (!r) return null;

    await appendSessionEvent(
      {
        pair_id: pairId,
        event_type: 'exercise.graded',
        actor_type: 'agent',
        mode: 'exercise',
        payload: {
          submission_id: r.id,
          exercise_id: r.exercise_id,
          score: input.score ?? null,
          // 改判痕迹: 重批事件自带旧判决摘要, 不需要调用方交代。
          // 首判不带这几个键。
          ...(regradeResolution.kind === 'regrade'
            ? { regrade: true, ...regradeResolution.previous }
            : {}),
        },
      },
      tx
    );
    return r;
  });

  // 只有校验之后、提交之前的竞态 (attribution 刚查完就被删/改归属) 才会走
  // 到这里 —— 事务已经回滚, submission/session_events 与"从未调用过"等价,
  // 报同一个 NOT_FOUND (不泄露此前查到过的那份归属)。
  if (!row) throw submissionNotFound(submissionId);

  return {
    row,
    regraded: regradeResolution.kind === 'regrade',
    lesson_id: attribution.lesson_id,
    expected_concepts: attribution.expected_concepts,
  };
}
