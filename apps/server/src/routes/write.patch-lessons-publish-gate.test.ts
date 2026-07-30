// 红队 P1-04 — REST PATCH /lessons/:id 补发布闸。
//
// MCP update_lesson (mcp/server.ts) 对已发布课 (published_at 非空) 会在
// patch 落库后重跑 validateLesson+canPublish, FAIL 就把这次 patch 撤回;
// REST 的同名端点此前不做这一步 —— 两个入口能把同一节已发布课改出两种
// 结局。这个文件验的是 REST 侧补上的那一半:
//   ① 草稿课 (published_at 为空) 不受影响 —— PATCH 照旧不过闸。
//   ② 已发布课 PATCH 后重新验尺, FAIL 就整次拒绝 (4xx) 并把 lessons 行 +
//      revision 计数撤回原样, 不留下被拒的 lesson_revisions 行。
//
// 与 write.restore.test.ts 同一硬闸门纪律: before() 先探活 Postgres 探不到
// 就整体 skip, 探到了先 requireBenchDatabase 卡库名(/_bench$/), 拒绝在生产
// 库写 t144test_ 前缀的测试数据(7/19 事故同款闸门)。用 app.request() 走真
// 实 Hono app, 不开真实网络 socket。

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sql, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { requireBenchDatabase } from '../lib/require-bench-db';
import { agents, learners, learner_agent_pairs, courses, lessons, lesson_revisions } from '../db/schema';
import app from '../index';

let dbAvailable = true;
before(async () => {
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbAvailable = false;
    console.log(
      '[write.patch-lessons-publish-gate.test] no live Postgres reachable in this sandbox — DB-backed tests will report as skipped, not passed or failed.'
    );
    return;
  }
  requireBenchDatabase(
    process.env.DATABASE_URL,
    'write.patch-lessons-publish-gate.test.ts (seedFixture creates Test Learner/Test Agent pairs)'
  );
});

function uid(prefix: string): string {
  return `${prefix}_t144test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

interface Fixture {
  agentId: string;
  learnerId: string;
  pairId: string;
  courseId: string;
  draftLessonId: string;
  publishedLessonId: string;
}

// content_markdown left empty on purpose — checkLessonContent's very first
// check (validate-prep-core.ts `content_present`) fails hard on empty/blank
// content, so both lessons start life already FAIL under validateLesson.
// That's exactly the fixture this gate needs: no valid 8–14-page/kicker
// markdown to hand-build, just a guaranteed-FAIL report to prove the revert
// path fires (and doesn't fire for the draft).
async function seedFixture(): Promise<Fixture> {
  const f: Fixture = {
    agentId: uid('agent'),
    learnerId: uid('learner'),
    pairId: uid('pair'),
    courseId: uid('course'),
    draftLessonId: uid('lesson'),
    publishedLessonId: uid('lesson'),
  };

  await db.insert(agents).values({ id: f.agentId, display_name: 'Test Agent', provider: 'test' });
  await db
    .insert(learners)
    .values({ id: f.learnerId, display_name: 'Test Learner', preferences: { timezone: 'UTC', locale: 'en' } });
  await db.insert(learner_agent_pairs).values({ id: f.pairId, learner_id: f.learnerId, agent_id: f.agentId });
  await db.insert(courses).values({
    id: f.courseId,
    pair_id: f.pairId,
    topic: 'Publish gate fixture',
    structure: { lesson_ids: [f.draftLessonId, f.publishedLessonId] },
  });
  await db.insert(lessons).values([
    {
      id: f.draftLessonId,
      course_id: f.courseId,
      order: 1,
      title: 'Draft lesson (unpublished)',
      content_markdown: '',
      published_at: null,
    },
    {
      id: f.publishedLessonId,
      course_id: f.courseId,
      order: 2,
      title: 'Published lesson (original title)',
      content_markdown: '',
      published_at: new Date(),
    },
  ]);

  return f;
}

async function teardownFixture(f: Fixture) {
  await db.delete(courses).where(eq(courses.id, f.courseId));
  await db.delete(learner_agent_pairs).where(eq(learner_agent_pairs.id, f.pairId));
  await db.delete(learners).where(eq(learners.id, f.learnerId));
  await db.delete(agents).where(eq(agents.id, f.agentId));
}

test('PATCH /lessons/:id on a draft (unpublished) lesson is unaffected by the publish gate', async (t) => {
  if (!dbAvailable) {
    t.skip('no live Postgres reachable in this sandbox — run against docker-compose db to validate');
    return;
  }

  const fixture = await seedFixture();
  try {
    const res = await app.request(`/api/lessons/${fixture.draftLessonId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision_reason: 'draft edit, still failing content — should not be gated',
        title: 'Draft lesson (edited)',
      }),
    });
    const bodyText = await res.text();
    assert.equal(res.status, 200, `draft PATCH should succeed regardless of validateLesson status, got: ${bodyText}`);

    const [row] = await db.select().from(lessons).where(eq(lessons.id, fixture.draftLessonId));
    assert.equal(row?.title, 'Draft lesson (edited)');
    assert.equal(row?.revision, 2);
  } finally {
    await teardownFixture(fixture);
  }
});

test('PATCH /lessons/:id on a published lesson re-validates and reverts on FAIL (Publish Gate parity with MCP update_lesson)', async (t) => {
  if (!dbAvailable) {
    t.skip('no live Postgres reachable in this sandbox — run against docker-compose db to validate');
    return;
  }

  const fixture = await seedFixture();
  try {
    const res = await app.request(`/api/lessons/${fixture.publishedLessonId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision_reason: 'title tweak on an already-failing published lesson',
        title: 'Published lesson (should never land)',
      }),
    });
    const bodyText = await res.text();
    assert.ok(
      res.status >= 400 && res.status < 500,
      `published-lesson PATCH against a FAIL report must be rejected with a 4xx, got ${res.status}: ${bodyText}`
    );
    const body = JSON.parse(bodyText) as { error: string; status: string; red_lights: unknown[] };
    assert.equal(body.error, 'publish_gate_failed');
    assert.equal(body.status, 'FAIL');
    assert.ok(Array.isArray(body.red_lights) && body.red_lights.length > 0);

    // Revert must be real: title/revision back to pre-patch state, no
    // dangling lesson_revisions row left behind for the rejected patch.
    const [row] = await db.select().from(lessons).where(eq(lessons.id, fixture.publishedLessonId));
    assert.equal(row?.title, 'Published lesson (original title)');
    assert.equal(row?.revision, 1);

    const revisionRows = await db
      .select()
      .from(lesson_revisions)
      .where(eq(lesson_revisions.lesson_id, fixture.publishedLessonId));
    assert.equal(revisionRows.length, 0, 'rejected patch must not leave a lesson_revisions row behind');
  } finally {
    await teardownFixture(fixture);
  }
});
