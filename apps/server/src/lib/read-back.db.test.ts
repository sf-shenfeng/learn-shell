// 读回面三工具核心测试 — getLessonReadback / getExerciseReadback /
// getSubmissionReadback。
//
// 两组:
//   A) excerptOf — 纯节选, DB-free, 随套件常跑。
//   B) DB 集成 (bench 库): 三工具各覆盖 成功读回 + include_content 开关
//      (get_lesson) + 他 pair NOT_FOUND (与不存在同报文, 不泄露存在性)。
//
// 按既定纪律 RUN_DB_TESTS=1 门控 + requireBenchDatabase 硬闸门。
// node:test / node:assert, zero new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excerptOf, READBACK_EXCERPT_CHARS } from './read-back';
import { McpToolError } from './mcp-errors';

// ---- A) excerptOf (纯, DB-free) ----

test('excerptOf: 短文原样, 长文截断加省略号', () => {
  assert.equal(excerptOf('短'), '短');
  const long = 'x'.repeat(READBACK_EXCERPT_CHARS + 50);
  const cut = excerptOf(long);
  assert.equal(cut.length, READBACK_EXCERPT_CHARS + 1);
  assert.ok(cut.endsWith('…'));
});

// ---- B) DB 集成 (bench 库) ----

const dbSkip = process.env.RUN_DB_TESTS !== '1';
const skipNote = dbSkip && '需 RUN_DB_TESTS=1 + 已迁移的 bench Postgres (待验收时跑)';

test('读回面三工具: 成功读回 / include_content 开关 / 归属 NOT_FOUND 不泄露', { skip: skipNote }, async () => {
  const { requireBenchDatabase } = await import('./require-bench-db');
  requireBenchDatabase(
    process.env.DATABASE_URL,
    'read-back.db.test.ts (creates 测试 pair/course/lesson/exercise/submission 数据)'
  );

  const { db } = await import('../db/client');
  const { eq, inArray } = await import('drizzle-orm');
  const {
    learners,
    agents,
    learner_agent_pairs,
    courses,
    lessons,
    concepts,
    exercises,
    exercise_submissions,
  } = await import('../db/schema');
  const { getLessonReadback, getExerciseReadback, getSubmissionReadback } = await import('./read-back');

  const suffix = `rb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const learnerId = `lrn_${suffix}`;
  const agentId = `agt_${suffix}`;
  const pairA = `pair_${suffix}_a`;
  const pairB = `pair_${suffix}_b`;
  const courseId = `crs_${suffix}`;
  const lessonId = `lsn_${suffix}`;
  const conceptIds = [`cpt_${suffix}_1`, `cpt_${suffix}_2`];
  const exercise1 = `ex_${suffix}_1`;
  const exercise2 = `ex_${suffix}_2`;
  const exerciseIds = [exercise1, exercise2];
  const submissionId = `sub_${suffix}`;

  const fullContent = `# 测试课文 ${suffix}\n\n` + '正文句子。'.repeat(120); // > 280 chars

  /** 断言某个读回调用抛 NOT_FOUND, 并归一化 id 后返回报文 (供不泄露对比)。 */
  const expectNotFound = async (fn: () => Promise<unknown>, id: string): Promise<string> => {
    try {
      await fn();
    } catch (e) {
      assert.ok(e instanceof McpToolError, '应抛 McpToolError');
      assert.equal(e.code, 'NOT_FOUND');
      return e.message.replace(id, '<id>');
    }
    assert.fail('应抛 NOT_FOUND 而不是成功返回');
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
      { id: pairA, learner_id: learnerId, agent_id: agentId, active: false },
      { id: pairB, learner_id: learnerId, agent_id: agentId, active: false },
    ]);
    await db.insert(courses).values({
      id: courseId,
      pair_id: pairA,
      topic: `测试课程 ${suffix}`,
      structure: { lesson_ids: [lessonId] },
    });
    await db.insert(lessons).values({
      id: lessonId,
      course_id: courseId,
      order: 1,
      title: `第一课 ${suffix}`,
      content_markdown: fullContent,
      summary: '一句话摘要',
      concept_ids: conceptIds,
      estimated_minutes: 20,
      modality_declarations: { mindmap: '背诵类内容, 关系不是难点' },
      // published_at 留空 — 先验草稿态读回。
    });
    await db.insert(concepts).values(
      conceptIds.map((id, i) => ({
        id,
        lesson_id: lessonId,
        course_id: courseId,
        name: `概念${i + 1}`,
      }))
    );
    await db.insert(exercises).values([
      {
        id: exercise1,
        lesson_id: lessonId,
        order: 1,
        prompt: '题面一: 请解释概念1。',
        reference_answer: '参考答案一 (评分钥匙)。',
        expected_concepts: [conceptIds[0]!],
        tags: [],
        agent_skill_used: 'test-skill',
      },
      {
        id: exercise2,
        lesson_id: lessonId,
        order: 2,
        prompt: '题面二 (探针)。',
        reference_answer: '参考答案二。',
        expected_concepts: [],
        tags: ['probe'],
        agent_skill_used: 'test-skill',
      },
    ]);
    await db.insert(exercise_submissions).values({
      id: submissionId,
      exercise_id: exercise1,
      learner_id: learnerId,
      learner_answer: '学习者的作答正文。',
      status: 'graded',
      submitted_at: new Date('2026-07-20T10:00:00Z'),
      agent_feedback: '判词: 讲对了主干。',
      agent_score: 0.85,
      graded_at: new Date('2026-07-20T11:00:00Z'),
      // 双轨都落库 (Confidence 主权立法): 序数是事实层, 百分比是建模层。
      // 存的时候两份都在 —— 才能验出读回时百分比被挡在门外 (N5)。
      confidence: 'certain',
      confidence_pct: 97,
    });

    // ---- 1. get_lesson 紧凑默认: 结构+元数据, 无全文 ----
    const compact = await getLessonReadback(pairA, lessonId, false);
    assert.equal(compact.lesson_id, lessonId);
    assert.equal(compact.course_id, courseId);
    assert.equal(compact.title, `第一课 ${suffix}`);
    assert.equal(compact.published, false, 'published_at 为空应读作草稿');
    assert.equal(compact.published_at, null);
    assert.equal(compact.revision, 1);
    assert.deepEqual(compact.modality_declarations, { mindmap: '背诵类内容, 关系不是难点' });
    assert.equal(compact.concepts.length, 2);
    assert.deepEqual(
      compact.exercises.map((e) => e.exercise_id),
      exerciseIds,
      '习题按 order 升序'
    );
    assert.deepEqual(compact.exercises[1]!.tags, ['probe']);
    assert.equal(compact.content_chars, fullContent.length);
    assert.equal(compact.content_excerpt, excerptOf(fullContent));
    assert.ok(
      !('content_markdown' in compact),
      '紧凑模式 content_markdown 字段整个缺席 (不是 null) — token 经济'
    );

    // ---- 2. include_content: true 给全文; 发布后 published 翻真 ----
    const publishedAt = new Date('2026-07-21T08:00:00Z');
    await db.update(lessons).set({ published_at: publishedAt }).where(eq(lessons.id, lessonId));
    const full = await getLessonReadback(pairA, lessonId, true);
    assert.equal(full.content_markdown, fullContent, '全文无损');
    assert.equal(full.published, true);
    assert.equal(full.published_at, publishedAt.toISOString());

    // ---- 3. get_exercise: 题面+评分钥匙+lesson 链 ----
    const ex = await getExerciseReadback(pairA, exercise1);
    assert.equal(ex.prompt, '题面一: 请解释概念1。');
    assert.equal(ex.reference_answer, '参考答案一 (评分钥匙)。');
    assert.deepEqual(ex.expected_concepts, [conceptIds[0]!]);
    assert.deepEqual(ex.tags, []);
    assert.equal(ex.lesson_id, lessonId);
    assert.equal(ex.lesson_title, `第一课 ${suffix}`);
    assert.equal(ex.course_id, courseId);

    // ---- 4. get_submission: 答案正文+批改状态+grade/feedback+exercise 链 ----
    const sub = await getSubmissionReadback(pairA, submissionId);
    assert.equal(sub.learner_answer, '学习者的作答正文。');
    assert.equal(sub.status, 'graded');
    assert.equal(sub.agent_score, 0.85);
    assert.equal(sub.agent_feedback, '判词: 讲对了主干。');
    assert.equal(sub.exercise_id, exercise1);
    assert.equal(sub.lesson_id, lessonId);
    assert.equal(sub.course_id, courseId);
    assert.equal(sub.exercise_prompt_excerpt, '题面一: 请解释概念1。');
    assert.equal(sub.submitted_at, '2026-07-20T10:00:00.000Z');
    assert.equal(sub.graded_at, '2026-07-20T11:00:00.000Z');
    // Confidence 主权红线 (N5) 的端到端复核 —— 序数在, 百分比不在。逐键的常跑守卫
    // 在 read-back.confidence-redaction.test.ts (DB-free); 这里只补一句真库确认,
    // 证明 drizzle 取回的整行经过映射后确实没把建模层数值带出来。
    assert.equal(sub.confidence, 'certain');
    assert.equal(Object.hasOwn(sub, 'confidence_pct'), false, 'confidence_pct 不进教师读路径');

    // ---- 5. 归属守卫: 他 pair 一律 NOT_FOUND, 与不存在同报文 ----
    const foreignLessonMsg = await expectNotFound(() => getLessonReadback(pairB, lessonId, false), lessonId);
    const missingLessonMsg = await expectNotFound(
      () => getLessonReadback(pairA, `lsn_${suffix}_nope`, false),
      `lsn_${suffix}_nope`
    );
    assert.equal(foreignLessonMsg, missingLessonMsg, 'lesson: 他 pair 与不存在必须同一句话');

    const foreignExMsg = await expectNotFound(() => getExerciseReadback(pairB, exercise1), exercise1);
    const missingExMsg = await expectNotFound(
      () => getExerciseReadback(pairA, `ex_${suffix}_nope`),
      `ex_${suffix}_nope`
    );
    assert.equal(foreignExMsg, missingExMsg, 'exercise: 他 pair 与不存在必须同一句话');

    const foreignSubMsg = await expectNotFound(() => getSubmissionReadback(pairB, submissionId), submissionId);
    const missingSubMsg = await expectNotFound(
      () => getSubmissionReadback(pairA, `sub_${suffix}_nope`),
      `sub_${suffix}_nope`
    );
    assert.equal(foreignSubMsg, missingSubMsg, 'submission: 他 pair 与不存在必须同一句话');
  } finally {
    // 清账自下而上 (FK cascade 其实会带走大半, 但显式删干净不赌级联)。
    await db.delete(exercise_submissions).where(eq(exercise_submissions.id, submissionId));
    await db.delete(exercises).where(inArray(exercises.id, exerciseIds));
    await db.delete(concepts).where(inArray(concepts.id, conceptIds));
    await db.delete(lessons).where(eq(lessons.id, lessonId));
    await db.delete(courses).where(eq(courses.id, courseId));
    await db.delete(learner_agent_pairs).where(inArray(learner_agent_pairs.id, [pairA, pairB]));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(learners).where(eq(learners.id, learnerId));
  }
});
