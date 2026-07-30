// grade_exercise 核心写路径测试 — lib/grade-submission.ts。
//
// 回归考 v2 核心 finding: 外
// pair 的 submission 调 grade_exercise 曾经先把它判成 graded、记一条归错
// pair 的 exercise.graded 事件, 之后才在 closure_progress 环节发现归属不
// 对再报错 —— 失败响应与真实写入结果相反。这里补的就是"外 pair 一律
// NOT_FOUND, 且 submission 行与 session_events 零变化"的反向测试, 外加
// 正常批改/持证改判两条路径的零回归确认。
//
// 按既定纪律 RUN_DB_TESTS=1 门控 + requireBenchDatabase 硬闸门。
// node:test / node:assert, zero new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpToolError } from './mcp-errors';

const dbSkip = process.env.RUN_DB_TESTS !== '1';
const skipNote = dbSkip && '需 RUN_DB_TESTS=1 + 已迁移的 bench Postgres (待验收时跑)';

test('grade_exercise 写路径: 外 pair NOT_FOUND 零写入 / 本 pair 正常批改 / 持证改判', { skip: skipNote }, async () => {
  const { requireBenchDatabase } = await import('./require-bench-db');
  requireBenchDatabase(
    process.env.DATABASE_URL,
    'grade-submission.db.test.ts (creates 测试 pair/course/lesson/exercise/submission 数据)'
  );

  const { db } = await import('../db/client');
  const { and, eq, inArray } = await import('drizzle-orm');
  const {
    learners,
    agents,
    learner_agent_pairs,
    courses,
    lessons,
    exercises,
    exercise_submissions,
    session_events,
  } = await import('../db/schema');
  const { gradeSubmission } = await import('./grade-submission');

  const suffix = `gs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const learnerId = `lrn_${suffix}`;
  const agentId = `agt_${suffix}`;
  const pairOwn = `pair_${suffix}_own`; // 提交真正归属的 pair
  const pairForeign = `pair_${suffix}_foreign`; // 外 pair —— 无权批改
  const courseId = `crs_${suffix}`;
  const lessonId = `lsn_${suffix}`;
  const exerciseId = `ex_${suffix}`;
  const submissionId = `sub_${suffix}`;
  const conceptId = `cpt_${suffix}_1`;

  /** submission 本行的可变字段快照 (status/agent_feedback/agent_score/
   *  graded_at) —— 断言"零变化"就是断言这四个字段的快照前后相等。 */
  const snapshotSubmission = async () => {
    const [row] = await db
      .select({
        status: exercise_submissions.status,
        agent_feedback: exercise_submissions.agent_feedback,
        agent_score: exercise_submissions.agent_score,
        graded_at: exercise_submissions.graded_at,
      })
      .from(exercise_submissions)
      .where(eq(exercise_submissions.id, submissionId))
      .limit(1);
    return row ?? null;
  };

  const countGradedEvents = async (): Promise<number> => {
    const rows = await db
      .select({ event_id: session_events.event_id })
      .from(session_events)
      .where(and(inArray(session_events.pair_id, [pairOwn, pairForeign]), eq(session_events.event_type, 'exercise.graded')));
    return rows.length;
  };

  try {
    await db.insert(learners).values({
      id: learnerId,
      display_name: `测试学习者 ${suffix}`,
      preferences: { timezone: 'Asia/Shanghai', locale: 'zh-CN' },
    });
    await db.insert(agents).values({ id: agentId, display_name: `测试老师 ${suffix}`, provider: 'test' });
    // active: false — 不干扰 bench 服务的"当前 pair"解析。
    await db.insert(learner_agent_pairs).values([
      { id: pairOwn, learner_id: learnerId, agent_id: agentId, active: false },
      { id: pairForeign, learner_id: learnerId, agent_id: agentId, active: false },
    ]);
    await db.insert(courses).values({
      id: courseId,
      pair_id: pairOwn,
      topic: `测试课程 ${suffix}`,
      structure: { lesson_ids: [lessonId] },
    });
    await db.insert(lessons).values({
      id: lessonId,
      course_id: courseId,
      order: 1,
      title: `第一课 ${suffix}`,
      content_markdown: '正文。',
      summary: '一句话摘要',
      concept_ids: [conceptId],
      estimated_minutes: 20,
    });
    await db.insert(exercises).values({
      id: exerciseId,
      lesson_id: lessonId,
      order: 1,
      prompt: '题面: 请解释概念1。',
      reference_answer: '参考答案 (评分钥匙)。',
      expected_concepts: [conceptId],
      tags: [],
      agent_skill_used: 'test-skill',
    });
    await db.insert(exercise_submissions).values({
      id: submissionId,
      exercise_id: exerciseId,
      learner_id: learnerId,
      learner_answer: '学习者的作答正文。',
      status: 'submitted',
      submitted_at: new Date('2026-07-24T10:00:00Z'),
    });

    // ---- 1. 外 pair NOT_FOUND, submission/session_events 零变化 ----
    const beforeSubmission = await snapshotSubmission();
    const beforeEventCount = await countGradedEvents();
    assert.equal(beforeSubmission?.status, 'submitted', '前置: 尚未批改');
    assert.equal(beforeEventCount, 0, '前置: 尚无 exercise.graded 事件');

    await assert.rejects(
      () => gradeSubmission(pairForeign, submissionId, { feedback: '外 pair 不该能批到这份' }),
      (e: unknown) => {
        assert.ok(e instanceof McpToolError, '应抛 McpToolError');
        assert.equal(e.code, 'NOT_FOUND', '外 pair 与不存在同报文, 不泄露存在性');
        return true;
      }
    );

    const afterForeignSubmission = await snapshotSubmission();
    const afterForeignEventCount = await countGradedEvents();
    assert.deepEqual(afterForeignSubmission, beforeSubmission, '外 pair 调用失败后 submission 行零变化');
    assert.equal(afterForeignEventCount, 0, '外 pair 调用失败后 session_events 零变化 (没有归错 pair 的事件)');

    // 与"提交不存在"同一报文 (不泄露"这个 id 其实存在, 只是不归你") ----
    await assert.rejects(
      () => gradeSubmission(pairForeign, `sub_${suffix}_nope`, { feedback: '不存在的提交' }),
      (e: unknown) => {
        assert.ok(e instanceof McpToolError);
        assert.equal(e.code, 'NOT_FOUND');
        return true;
      }
    );

    // ---- 2. 本 pair 正常批改路径 —— 零回归 ----
    const graded = await gradeSubmission(pairOwn, submissionId, {
      feedback: '判词: 讲对了主干。',
      score: 0.85,
    });
    assert.equal(graded.row.status, 'graded');
    assert.equal(graded.row.agent_score, 0.85);
    assert.equal(graded.row.agent_feedback, '判词: 讲对了主干。');
    assert.equal(graded.regraded, false, '首判不是改判');
    assert.equal(graded.lesson_id, lessonId, '归属查询顺手带出的 lesson_id 正确');
    assert.deepEqual(graded.expected_concepts, [conceptId]);

    const afterFirstGradeEventCount = await countGradedEvents();
    assert.equal(afterFirstGradeEventCount, 1, '首判记一条 exercise.graded 事件');

    // ---- 3. 已批改再批: 无 regrade:true 应拒 (CONFLICT), 持证改判应放行 ----
    await assert.rejects(
      () => gradeSubmission(pairOwn, submissionId, { feedback: '没带 regrade 的二次批改' }),
      (e: unknown) => {
        assert.ok(e instanceof McpToolError);
        assert.equal(e.code, 'CONFLICT', '无证重批应被拦, 不是静默覆盖');
        return true;
      }
    );
    const afterRefusedEventCount = await countGradedEvents();
    assert.equal(afterRefusedEventCount, 1, '被拒的重批不应留下新事件');

    const regraded = await gradeSubmission(pairOwn, submissionId, {
      feedback: '改判: 更细的判词。',
      score: 0.6,
      regrade: true,
    });
    assert.equal(regraded.regraded, true);
    assert.equal(regraded.row.agent_score, 0.6);
    const afterRegradeEventCount = await countGradedEvents();
    assert.equal(afterRegradeEventCount, 2, '持证改判追加第二条事件, 旧判决不删除不覆盖历史条数');
  } finally {
    await db.delete(session_events).where(inArray(session_events.pair_id, [pairOwn, pairForeign]));
    await db.delete(exercise_submissions).where(eq(exercise_submissions.id, submissionId));
    await db.delete(exercises).where(eq(exercises.id, exerciseId));
    await db.delete(lessons).where(eq(lessons.id, lessonId));
    await db.delete(courses).where(eq(courses.id, courseId));
    await db.delete(learner_agent_pairs).where(inArray(learner_agent_pairs.id, [pairOwn, pairForeign]));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(learners).where(eq(learners.id, learnerId));
  }
});
