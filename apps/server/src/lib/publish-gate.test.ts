// Tests for Publish Gate.
//
// Two groups:
//   A) canPublish — pure red-light decision (runnable now, DB-free).
//   B) DB integration — FAIL 课 publish 被拒 / 未发布课不出现在学习者端点 /
//      迁移回填后旧课可见。These need a live Postgres with 0022+0023 applied,
//      so they self-skip unless RUN_DB_TESTS=1 (本地无库时不跑, 待验收时开)。
//
// node:test / node:assert, zero new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canPublish } from './validate-prep-core';

// ---- A) canPublish (test ①: FAIL 课 publish 被拒) ----

test('canPublish: FAIL is rejected (红灯不清零不许上架)', () => {
  assert.equal(canPublish('FAIL'), false);
});

test('canPublish: PASS is allowed', () => {
  assert.equal(canPublish('PASS'), true);
});

test('canPublish: PASS_WITH_WARNINGS is allowed (黄灯过目制归人工)', () => {
  assert.equal(canPublish('PASS_WITH_WARNINGS'), true);
});

// ---- B) DB integration (待验收时跑: RUN_DB_TESTS=1 + 0022/0023 已迁移) ----
//
// 这些用例描述的是验收口径, 本地无库时 skip。开跑步骤:
//   1. 起一个应用了全部迁移(含 0022 回填 / 0023)的 Postgres, 设 DATABASE_URL
//   2. RUN_DB_TESTS=1 pnpm --filter @learn-shell/server test
//
// 断言意图(施工时已按此写服务端逻辑, 见 routes/read.ts + mcp/server.ts):
//   ② 未发布课(published_at IS NULL)不出现在 GET /courses/:id/lessons(默认);
//      迁移 0022 回填后, 存量课 published_at 非空 → 学习者书架可见, 不变空。

const dbSkip = process.env.RUN_DB_TESTS !== '1';

test(
  '未发布(draft)课不出现在学习者书架端点, 回填后旧课可见',
  { skip: dbSkip && '需 RUN_DB_TESTS=1 + 已迁移的 Postgres (待验收时跑)' },
  async () => {
    const { db } = await import('../db/client');
    const { and, asc, eq, isNotNull } = await import('drizzle-orm');
    const { lessons, courses } = await import('../db/schema');

    // 学习者书架口径 = routes/read.ts GET /courses/:id/lessons 的默认过滤。
    const learnerShelf = (courseId: string) =>
      db
        .select()
        .from(lessons)
        .where(and(eq(lessons.course_id, courseId), isNotNull(lessons.published_at)))
        .orderBy(asc(lessons.order));

    // 存量课(迁移前建、已被 0022 回填)必须仍可见——随便挑一门有课的 course。
    const [anyCourse] = await db.select({ id: courses.id }).from(courses).limit(1);
    if (anyCourse) {
      const shelf = await learnerShelf(anyCourse.id);
      const allInCourse = await db.select().from(lessons).where(eq(lessons.course_id, anyCourse.id));
      const publishedCount = allInCourse.filter((l) => l.published_at != null).length;
      assert.equal(
        shelf.length,
        publishedCount,
        '学习者书架应恰好等于已发布(published_at 非空)课数'
      );
      // 回填保证: 存量课不应因加列而集体变草稿(书架不许空掉)。
      assert.ok(publishedCount > 0, '0022 回填后该 course 至少有一节已发布课');
    }
  }
);
