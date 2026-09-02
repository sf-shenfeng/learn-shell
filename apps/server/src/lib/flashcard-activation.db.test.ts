// 闪卡激活门测试 (迁移 0045) —— 复习队列"全量涌入"病的验收尺。
//
// 两组:
//   A) 纯函数 (DB-free, 随套件常跑): defaultActivatedForConcept 的默认值
//      分流, 与 isFlashcardInReviewQueue 的三道闸 (未激活/已暂停/未到期)。
//      这两个函数是本单的全部判断力所在 —— 四条创建路径的默认值和三处
//      due 查询的过滤都只是在调它们, 所以它们值得一组无库的硬测。
//   B) DB 集成 (bench 库): 建卡→未激活不入 due→declare-completed 后入 due
//      →重复激活幂等→concept_id 空的卡默认激活。
//
// 按既定纪律 RUN_DB_TESTS=1 门控 + requireBenchDatabase 硬闸门 (7/19
// t144test 入侵案后规矩)。node:test / node:assert, zero new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultActivatedForConcept, isFlashcardInReviewQueue } from './flashcard-activation';

// ---- A) 纯函数 (DB-free) ----

test('defaultActivatedForConcept: 有 concept 的课程卡默认休眠', () => {
  assert.equal(defaultActivatedForConcept('cpt_time_value'), false);
});

test('defaultActivatedForConcept: concept_id 空的卡默认激活 (null/undefined/空串/纯空白)', () => {
  // 挂不上课就永远等不到激活那道门 —— 这四种形状都必须是 true, 否则导入卡
  // 和手写卡会被永久埋掉。
  assert.equal(defaultActivatedForConcept(null), true);
  assert.equal(defaultActivatedForConcept(undefined), true);
  assert.equal(defaultActivatedForConcept(''), true);
  assert.equal(defaultActivatedForConcept('   '), true);
});

test('isFlashcardInReviewQueue: 未激活的到期卡不进队列 (本单的病根)', () => {
  const now = Date.parse('2026-09-02T00:00:00Z');
  const card = {
    activated: false,
    paused: false,
    fsrs_state: { due_at: '2026-09-01T00:00:00Z' }, // 早就到期
  };
  assert.equal(isFlashcardInReviewQueue(card, now), false);
});

test('isFlashcardInReviewQueue: 已激活 + 已到期 + 未暂停 才进队列', () => {
  const now = Date.parse('2026-09-02T00:00:00Z');
  assert.equal(
    isFlashcardInReviewQueue(
      { activated: true, paused: false, fsrs_state: { due_at: '2026-09-01T00:00:00Z' } },
      now
    ),
    true
  );
});

test('isFlashcardInReviewQueue: paused 仍然挡得住 (MCP resource 此前漏的那道闸)', () => {
  const now = Date.parse('2026-09-02T00:00:00Z');
  assert.equal(
    isFlashcardInReviewQueue(
      { activated: true, paused: true, fsrs_state: { due_at: '2026-09-01T00:00:00Z' } },
      now
    ),
    false
  );
});

test('isFlashcardInReviewQueue: 未到期不进队列', () => {
  const now = Date.parse('2026-09-02T00:00:00Z');
  assert.equal(
    isFlashcardInReviewQueue(
      { activated: true, paused: false, fsrs_state: { due_at: '2026-09-03T00:00:00Z' } },
      now
    ),
    false
  );
});

test('isFlashcardInReviewQueue: 缺字段按 DDL 默认解读 (activated 缺 = 醒着, paused 缺 = 没暂停)', () => {
  // 契约层两个字段都是可选的; 老 fixture / 外部构造的对象不写它们, 不该
  // 因为"没写"就被静默踢出队列。
  const now = Date.parse('2026-09-02T00:00:00Z');
  assert.equal(isFlashcardInReviewQueue({ fsrs_state: { due_at: '2026-09-01T00:00:00Z' } }, now), true);
  assert.equal(
    isFlashcardInReviewQueue({ activated: null, paused: null, fsrs_state: { due_at: '2026-09-01T00:00:00Z' } }, now),
    true
  );
});

test('isFlashcardInReviewQueue: due_at 恰好等于此刻算到期 (边界闭区间, 与既有 <= 语义一致)', () => {
  const now = Date.parse('2026-09-02T00:00:00Z');
  assert.equal(
    isFlashcardInReviewQueue(
      { activated: true, paused: false, fsrs_state: { due_at: '2026-09-02T00:00:00.000Z' } },
      now
    ),
    true
  );
});

// ---- B) DB 集成 (bench 库) ----

const dbSkip = process.env.RUN_DB_TESTS !== '1';
const skipNote = dbSkip && '需 RUN_DB_TESTS=1 + 已迁移的 bench Postgres (待验收时跑)';

test(
  'activateFlashcardsForLesson: 休眠→不入 due→学完唤醒→入 due→重复幂等; 无 concept 的卡自始激活',
  { skip: skipNote },
  async () => {
    const { requireBenchDatabase } = await import('./require-bench-db');
    requireBenchDatabase(
      process.env.DATABASE_URL,
      'flashcard-activation.db.test.ts (creates 测试 pair/course/lesson/concept/flashcard 数据)'
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
      flashcards,
    } = await import('../db/schema');
    const { newCardState } = await import('./fsrs');
    const { activateFlashcardsForLesson, defaultActivatedForConcept, isFlashcardInReviewQueue } =
      await import('./flashcard-activation');

    const suffix = `fca_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const learnerId = `lrn_${suffix}`;
    const agentId = `agt_${suffix}`;
    const pairId = `pair_${suffix}`;
    const otherPairId = `pair_${suffix}_other`;
    const courseId = `crs_${suffix}`;
    const lessonA = `lsn_${suffix}_a`;
    const lessonB = `lsn_${suffix}_b`;
    const conceptA = `cpt_${suffix}_a`;
    const conceptB = `cpt_${suffix}_b`;
    const cardA = `fc_${suffix}_a`; // 挂 lessonA
    const cardB = `fc_${suffix}_b`; // 挂 lessonB —— 唤醒 A 不许波及它
    const cardFree = `fc_${suffix}_free`; // concept_id 空
    const cardOtherPair = `fc_${suffix}_other`; // 挂 lessonA 但属别的 pair
    const allCardIds = [cardA, cardB, cardFree, cardOtherPair];

    // 全部卡都是"早就到期的新卡" —— 到期与否不是本测试的变量, 激活才是。
    const dueLongAgo = newCardState(new Date('2026-01-01T00:00:00Z'));

    try {
      await db.insert(learners).values({
        id: learnerId,
        display_name: `测试学习者 ${suffix}`,
        preferences: { timezone: 'Asia/Shanghai', locale: 'zh-CN' },
      });
      await db.insert(agents).values({ id: agentId, display_name: `测试老师 ${suffix}`, provider: 'test' });
      // active: false — 不参与 getCurrentPairId 的"当前 pair"解析, 不干扰
      // 并行跑着的 bench 服务 (同 flashcard-update.db.test.ts 的姿态)。
      await db.insert(learner_agent_pairs).values([
        { id: pairId, learner_id: learnerId, agent_id: agentId, active: false },
        { id: otherPairId, learner_id: learnerId, agent_id: agentId, active: false },
      ]);
      await db.insert(courses).values({
        id: courseId,
        pair_id: pairId,
        topic: `测试课程 ${suffix}`,
        structure: { lesson_ids: [lessonA, lessonB] },
      });
      await db.insert(lessons).values([
        { id: lessonA, course_id: courseId, title: '第一课', order: 1 },
        { id: lessonB, course_id: courseId, title: '第二课', order: 2 },
      ]);
      await db.insert(concepts).values([
        { id: conceptA, lesson_id: lessonA, course_id: courseId, name: '概念A' },
        { id: conceptB, lesson_id: lessonB, course_id: courseId, name: '概念B' },
      ]);

      // ---- 1. 创建默认值分流 ----
      await db.insert(flashcards).values([
        {
          id: cardA,
          pair_id: pairId,
          concept_id: conceptA,
          deck_id: 'deck-test',
          front: 'A 面',
          back: 'A 背',
          source_refs: [],
          fsrs_state: dueLongAgo,
          activated: defaultActivatedForConcept(conceptA),
        },
        {
          id: cardB,
          pair_id: pairId,
          concept_id: conceptB,
          deck_id: 'deck-test',
          front: 'B 面',
          back: 'B 背',
          source_refs: [],
          fsrs_state: dueLongAgo,
          activated: defaultActivatedForConcept(conceptB),
        },
        {
          id: cardFree,
          pair_id: pairId,
          concept_id: null,
          deck_id: 'deck-test',
          front: '散卡面',
          back: '散卡背',
          source_refs: [],
          fsrs_state: dueLongAgo,
          activated: defaultActivatedForConcept(null),
        },
        {
          id: cardOtherPair,
          pair_id: otherPairId,
          concept_id: conceptA,
          deck_id: 'deck-test',
          front: '他 pair 的 A',
          back: '他 pair 的 A 背',
          source_refs: [],
          fsrs_state: dueLongAgo,
          activated: defaultActivatedForConcept(conceptA),
        },
      ]);

      const read = async (id: string) => {
        const [r] = await db.select().from(flashcards).where(eq(flashcards.id, id));
        assert.ok(r, `card ${id} 应存在`);
        return r;
      };

      assert.equal((await read(cardA)).activated, false, '挂 concept 的卡出生休眠');
      assert.equal((await read(cardFree)).activated, true, 'concept_id 空的卡出生即激活');

      // ---- 2. 未激活的到期卡不进复习队列 ----
      const now = Date.now();
      const inQueue = async (id: string) => isFlashcardInReviewQueue(await read(id), now);
      assert.equal(await inQueue(cardA), false, '休眠的到期卡不入 due —— 这就是要治的病');
      assert.equal(await inQueue(cardFree), true, '散卡照常入 due');

      // ---- 3. 学完 lessonA ⇒ 唤醒 ----
      const n1 = await activateFlashcardsForLesson(db, pairId, lessonA);
      assert.equal(n1, 1, '只唤醒 lessonA 下本 pair 的那一张');
      assert.equal((await read(cardA)).activated, true);
      assert.equal(await inQueue(cardA), true, '唤醒后到期卡进 due');
      assert.equal((await read(cardB)).activated, false, '别的课的卡不受波及');
      assert.equal((await read(cardOtherPair)).activated, false, '他 pair 的同课卡不受波及 (归属守卫)');

      // ---- 4. 幂等: 再唤醒一次命中 0 行 ----
      const n2 = await activateFlashcardsForLesson(db, pairId, lessonA);
      assert.equal(n2, 0, '重复激活幂等 —— WHERE activated = false 天然挡住');
      assert.equal((await read(cardA)).activated, true);

      // ---- 5. 没有 concept 的课 ⇒ 0, 不炸 ----
      const emptyLesson = `lsn_${suffix}_empty`;
      await db.insert(lessons).values({ id: emptyLesson, course_id: courseId, title: '空课', order: 3 });
      assert.equal(
        await activateFlashcardsForLesson(db, pairId, emptyLesson),
        0,
        '课下无 concept ⇒ 0 行, 不发退化的 IN ()'
      );
      await db.delete(lessons).where(eq(lessons.id, emptyLesson));
    } finally {
      await db.delete(flashcards).where(inArray(flashcards.id, allCardIds));
      await db.delete(concepts).where(inArray(concepts.id, [conceptA, conceptB]));
      await db.delete(lessons).where(inArray(lessons.id, [lessonA, lessonB]));
      await db.delete(courses).where(eq(courses.id, courseId));
      await db.delete(learner_agent_pairs).where(inArray(learner_agent_pairs.id, [pairId, otherPairId]));
      await db.delete(agents).where(eq(agents.id, agentId));
      await db.delete(learners).where(eq(learners.id, learnerId));
    }
  }
);
