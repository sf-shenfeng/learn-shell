// Tests for 反思挂锚聚合口径 (lib/lesson-closure-facts.ts)。
//
// 真实误读案例: reflect_on_teaching 成功 (拿到真实
// reflection id) → close_lesson_loop 成功, 但 closure_progress 仍报
// reflection 缺。两个写工具各自成功, 聚合状态却不认它们属于同一节课:
//   ① 反思行只带 live_session_id 不带 lesson_id (0035 起两列均可选) 时,
//      fetchAnchoredReflectionExists 曾只按 lesson_id 精确匹配 → 数不进;
//   ② pair 第一次关课时 fetchMostRecentCloseAt(skip=1) 得 null,
//      fetchReflectedSinceApprox 曾把 null 基准短路成 false → 近似兜底也失效。
// 本文件按 publish-gate.test.ts 的既定纪律 RUN_DB_TESTS=1 门控复现/验修:
// 本地无库自动 skip, 验收时开 (需已迁移至 0035+ 的 Postgres + DATABASE_URL)。
//
// node:test / node:assert, zero new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const dbSkip = process.env.RUN_DB_TESTS !== '1';
const skipNote = dbSkip && '需 RUN_DB_TESTS=1 + 已迁移(0035+)的 Postgres (待验收时跑)';

test(
  '复现/验修: 只带 live_session_id 的反思也算挂锚; 首关课(null 基准)近似判定认账; 全程 closure_progress 不再漏报',
  { skip: skipNote },
  async () => {
    const { requireBenchDatabase } = await import('./require-bench-db');
    // 硬闸门 — RUN_DB_TESTS=1 只管"要不要跑这条 DB 用例",不管
    // "DATABASE_URL 指的是哪个库"。7/19 t144test 入侵案就是后者出的事:
    // 库名不是 *_bench 就直接拒绝,不静默把测试数据(下面的 '测试学习者
    // #185'/'测试老师 #185')写进错的库。
    requireBenchDatabase(
      process.env.DATABASE_URL,
      'lesson-closure-facts.test.ts (creates 测试学习者/测试老师/测试 pair)'
    );

    const { db } = await import('../db/client');
    const { eq } = await import('drizzle-orm');
    const {
      learners,
      agents,
      learner_agent_pairs,
      courses,
      lessons,
      live_sessions,
      teacher_reflections,
    } = await import('../db/schema');
    const {
      fetchAnchoredReflectionExists,
      fetchReflectedSinceApprox,
      computeLessonClosureProgress,
    } = await import('./lesson-closure-facts');

    const suffix = `t185_${Date.now()}`;
    const learnerId = `lrn_${suffix}`;
    const agentId = `agt_${suffix}`;
    const pairId = `pair_${suffix}`;
    const courseId = `crs_${suffix}`;
    const lessonId = `les_${suffix}`;
    const otherLessonId = `les_other_${suffix}`;
    const liveId = `live_${suffix}`;
    const reflSessionOnlyId = `refl_s_${suffix}`;
    const reflUnanchoredId = `refl_u_${suffix}`;

    try {
      await db.insert(learners).values({
        id: learnerId,
        display_name: '测试学习者 #185',
        preferences: { timezone: 'Asia/Shanghai', locale: 'zh-CN' },
      });
      await db.insert(agents).values({ id: agentId, display_name: '测试老师 #185', provider: 'test' });
      await db.insert(learner_agent_pairs).values({ id: pairId, learner_id: learnerId, agent_id: agentId });
      await db.insert(courses).values({
        id: courseId,
        pair_id: pairId,
        topic: '#185 repro',
        structure: { lesson_ids: [lessonId, otherLessonId] },
      });
      await db.insert(lessons).values({ id: lessonId, course_id: courseId, order: 1, title: '#185 目标课' });
      await db.insert(lessons).values({ id: otherLessonId, course_id: courseId, order: 2, title: '#185 邻课' });
      // 本课挂的一场已完成 Live —— 反思将只挂它, 不挂 lesson_id (合法写法)。
      await db.insert(live_sessions).values({
        id: liveId,
        pair_id: pairId,
        context_type: 'lesson',
        context_id: lessonId,
        status: 'completed',
      });
      // ① 只带场次锚的反思 (lesson_id=null) — 病例主角。
      await db.insert(teacher_reflections).values({
        id: reflSessionOnlyId,
        pair_id: pairId,
        lesson_id: null,
        live_session_id: liveId,
        method: 'test',
        rationale: 'test',
        expected_outcome: '',
        actual_evidence: '',
        next_action: 'test',
        written_at: new Date(),
      });

      // 拓宽后的挂锚判定: 经 live_session→lesson 链路命中本课。
      assert.equal(
        await fetchAnchoredReflectionExists(pairId, lessonId),
        true,
        '只带 live_session_id 的反思必须算作本课挂锚 (live_sessions.context_id 链路)'
      );
      // 但不许错认到别的课头上 (场次挂的是目标课, 邻课不沾光)。
      assert.equal(
        await fetchAnchoredReflectionExists(pairId, otherLessonId),
        false,
        '场次锚只归它 context_id 指向的那节课'
      );

      // ② 首关课基准: pair 从没关过课 → sinceCloseAt=null → 有任意反思即算数。
      assert.equal(
        await fetchReflectedSinceApprox(pairId, null),
        true,
        'null 基准 (从未关课) 不得把已写的反思短路成"没反思过"'
      );

      // 端到端: 关课前状态机对本课的 reflection 项应判 completed, 不再漏报。
      const report = await computeLessonClosureProgress(pairId, lessonId);
      assert.ok(
        report.completed.includes('reflection'),
        `reflection 应在 completed[], 实得 completed=${report.completed.join(',')} missing=${report.missing.join(',')}`
      );
      assert.ok(!report.missing.includes('reflection'), 'reflection 不得再出现在 missing[]');

      // 对照组: 换一个全新 pair 粒度场景不好复用, 就地验"无主反思"仍不挂锚 ——
      // 先删掉场次锚反思, 只留完全无主的一条。
      await db.insert(teacher_reflections).values({
        id: reflUnanchoredId,
        pair_id: pairId,
        lesson_id: null,
        live_session_id: null,
        method: 'test',
        rationale: 'test',
        expected_outcome: '',
        actual_evidence: '',
        next_action: 'test',
        written_at: new Date(),
      });
      await db.delete(teacher_reflections).where(eq(teacher_reflections.id, reflSessionOnlyId));
      assert.equal(
        await fetchAnchoredReflectionExists(pairId, lessonId),
        false,
        '完全无主 (两列皆 null) 的反思不算挂锚——它只能靠近似兜底 + 写入侧警告'
      );
    } finally {
      // 逆序清理 (FK cascade 大多能兜, 仍显式删干净, 不给共享库留渣)。
      await db.delete(teacher_reflections).where(eq(teacher_reflections.pair_id, pairId));
      await db.delete(live_sessions).where(eq(live_sessions.pair_id, pairId));
      await db.delete(lessons).where(eq(lessons.course_id, courseId));
      await db.delete(courses).where(eq(courses.id, courseId));
      await db.delete(learner_agent_pairs).where(eq(learner_agent_pairs.id, pairId));
      await db.delete(agents).where(eq(agents.id, agentId));
      await db.delete(learners).where(eq(learners.id, learnerId));
    }
  }
);
