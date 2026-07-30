// Hono REST routes — read paths (TEACHING-SPEC-v1 §7 Repository read methods).
//
// All routes mounted under /api. Pair-scoped reads use path param :pairId;
// "current pair" is resolved server-side (W1: hardcoded; W2-W3: from session/auth).
//
// Response shape: bare JSON body matching the Repository interface return types.
// HTTP errors: 404 with { error: 'not_found' } / 500 with { error: 'internal' }.

import { Hono } from 'hono';
import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  agents,
  learner_agent_pairs,
  learners,
  teaching_contracts,
  courses,
  lessons,
  flashcards,
  learning_sessions,
  session_events,
  learner_hypotheses,
  teacher_reflections,
  exercises,
  exercise_submissions,
  question_banks,
  quiz_questions,
  quiz_attempts,
  simulated_quizzes,
  simulated_quiz_attempts,
  mindmaps,
  mindmap_associations,
  pending_mindmap_cards,
  learner_feedback,
  reminders,
  post_lesson_evaluations,
  lesson_revisions,
  lesson_progress,
  lesson_patches,
  lesson_loop_receipts,
} from '../db/schema';
import {
  buildContextSnapshot,
  buildLearnerBrief,
  listAvailablePairs,
  notExpiredWeatherFilter,
  pairExists,
} from '../lib/context-brief';
import { getObservationGateState } from '../lib/observation-gate';
import { computeCalibrationCurve } from '../lib/calibration';
import { computeBrierTrend } from '../lib/brier-trend';
import { getConfidenceAnchors } from '../lib/confidence-anchors';
import { getCurrentContract } from '../lib/currentContract';
import { buildTeacherInbox } from '../lib/teacher-inbox';
import { getLessonAxesForLessons } from '../lib/lesson-state';

const r = new Hono();

// ============================================================================
// pair + contract
// ============================================================================

// 资历优先——婚约不许被任何后来者顶替(7/19 t144test 入侵案)。
// "current pair" 的隐式默认解析一律按 established_at 升序取最早建立的那对
// active pair,不取最新的——7/19 一批测试数据 (pair_t144test_...) 就是靠
// "谁排前面就当谁是当前 pair" 的隐式规则顶替了真实 pair。需要某个后建立的
// pair 时,调用方必须显式传 pair id;这里改的只是"没人明确指定时选谁"。
//
// 首跑入学 (迁移 0042): 资历之上再叠一层身份 —— ORDER BY is_demo ASC,
// established_at ASC。真 pair (is_demo=false) 永远优先于样板间 (seed:demo)
// 当选"当前关系"; 同身份内仍是资历优先。
r.get('/pair/current', async (c) => {
  // W1: take the earliest-established active pair (single-tenant local self-host).
  // W2-W3 (Lucia auth): resolve from session.
  const rows = await db
    .select()
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.active, true))
    .orderBy(asc(learner_agent_pairs.is_demo), asc(learner_agent_pairs.established_at))
    .limit(1);
  if (rows.length === 0) return c.json(null);
  return c.json(rows[0]);
});

r.get('/learners/me', async (c) => {
  // 真 pair 优先于样板间, 同身份内资历优先 (同上)。
  const pairRows = await db
    .select()
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.active, true))
    .orderBy(asc(learner_agent_pairs.is_demo), asc(learner_agent_pairs.established_at))
    .limit(1);
  if (pairRows.length === 0) return c.json(null);
  const lrn = await db.select().from(learners).where(eq(learners.id, pairRows[0]!.learner_id)).limit(1);
  return c.json(lrn[0] ?? null);
});

r.get('/agents/:id', async (c) => {
  const id = c.req.param('id');
  const rows = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return c.json(rows[0] ?? null);
});

// 首跑轻端点 — web 首跑页判断"这台机器上有没有任何 pair / 有没有真
// pair"。GET /pair/current 只能回答"当前解析到谁"(demo 也算), 分不出
// "只有样板间"和"真关系已建立"两种状态, 首跑页恰恰要分 —— 所以多这一个
// 只读小端点, 不改 /pair/current 的既有契约。无鉴权 (v1 单机信任模型)。
r.get('/onboarding/status', async (c) => {
  const rows = await db
    .select({ id: learner_agent_pairs.id, is_demo: learner_agent_pairs.is_demo })
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.active, true));
  const realPairs = rows.filter((p) => !p.is_demo);
  return c.json({
    has_active_pair: rows.length > 0,
    has_real_pair: realPairs.length > 0,
    real_pair_count: realPairs.length,
    demo_pair_count: rows.length - realPairs.length,
  });
});

// route path kept as-is (web's HttpRepository.getActiveContract
// still calls this exact URL) but the selection semantics no longer read
// `teaching_contracts.active` (retired — see lib/currentContract.ts header):
// "the" contract is now the most-recently-updated one in a signed,
// non-terminal setup_status, picked via the shared helper.
r.get('/pairs/:pairId/contract/active', async (c) => {
  const pairId = c.req.param('pairId');
  const contract = await getCurrentContract(pairId);
  return c.json(contract ?? null);
});

r.get('/pairs/:pairId/contracts', async (c) => {
  const pairId = c.req.param('pairId');
  const rows = await db
    .select()
    .from(teaching_contracts)
    .where(eq(teaching_contracts.pair_id, pairId))
    .orderBy(desc(teaching_contracts.created_at));
  return c.json(rows);
});

// ============================================================================
// Learner Model 批0/批1 — 观察禁区登记簿读回 +
// 校准曲线. Mutations (add/remove registry entry, confidence-mode toggle,
// the writes that feed the curve) live in write.ts.
// ============================================================================

r.get('/pairs/:pairId/observation-gate', async (c) => {
  const pairId = c.req.param('pairId');
  const state = await getObservationGateState(pairId);
  return c.json(state);
});

r.get('/pairs/:pairId/calibration', async (c) => {
  const pairId = c.req.param('pairId');
  const courseId = c.req.query('course_id');
  const curve = await computeCalibrationCurve(pairId, courseId || undefined);
  return c.json(curve);
});

// 誓言三 (Settings CertificateCard, brief "confidence 可视化两视图" 视图三) —
// 按 ISO 周分桶的 Brier trend. 正误判定与上面 /calibration 同源, 见
// lib/brier-trend.ts 顶部注释。
r.get('/pairs/:pairId/brier-trend', async (c) => {
  const pairId = c.req.param('pairId');
  const trend = await computeBrierTrend(pairId);
  return c.json(trend);
});

// Confidence 主权立法 — 映射锚值读回. 学习者自己的 Settings 页面用这个;
// write-side (PATCH) 在 write.ts. 教师侧 MCP 没有对应 tool/resource, 这条
// 路由只服务 web app 自己的 Settings 页 — 见 lib/confidence-anchors.ts。
r.get('/pairs/:pairId/confidence-anchors', async (c) => {
  const pairId = c.req.param('pairId');
  const anchors = await getConfidenceAnchors(pairId);
  return c.json({ confidence_anchor_pct: anchors });
});

// ============================================================================
// content (courses / lessons / flashcards)
// ============================================================================

r.get('/pairs/:pairId/courses', async (c) => {
  const pairId = c.req.param('pairId');
  const rows = await db.select().from(courses).where(eq(courses.pair_id, pairId));
  return c.json(rows);
});

r.get('/courses/:id', async (c) => {
  const id = c.req.param('id');
  const rows = await db.select().from(courses).where(eq(courses.id, id)).limit(1);
  return c.json(rows[0] ?? null);
});

// Publish Gate — 学习者书架读端点: 默认只出已发布课 (published_at 非
// 空)。这是学习者面 (apps/web 的 HttpRepository.getLessons 走这条 URL); 教师/MCP
// 面读课走 mcp/server.ts 的 pair:// resources / get_context 直查 DB, 不经此路由,
// 天然全可见。教师侧若要经 REST 看含草稿的全量, 传 ?include_unpublished=1 显式开闸
// (web 学习者从不传, 故书架永远只见已发布)。迁移 0022 已把 52 节存量课回填为
// 已发布, 旧书架无缝不变空。
// State 2.0 (迁移 0030 同批) — 每课带上 axes: LessonAxes (lib/lesson-state.ts
// 单点), 用批量函数一次取全, 不逐课查询 (N+1 禁令)。四轴是 pair 视角的状态
// (learning/evaluated/revision_seen 都挂在 pair 上), 这条路由本身不带 pairId
// 参数 (书架路由历来如此, W1 单租户) —— 取 active pair 的轴; 查无活跃 pair 时
// (理论上不该发生, 留作防御) 每课 axes 退化为 null, 不阻断既有字段的返回。
// 现有字段(裸 lesson 行)不动, 这是纯加法, 不是破坏性变更。
r.get('/courses/:id/lessons', async (c) => {
  const id = c.req.param('id');
  const includeUnpublished = c.req.query('include_unpublished') === '1';
  const rows = await db
    .select()
    .from(lessons)
    .where(
      includeUnpublished
        ? eq(lessons.course_id, id)
        : and(eq(lessons.course_id, id), isNotNull(lessons.published_at))
    )
    .orderBy(asc(lessons.order));

  // 真 pair 优先于样板间, 同身份内资历优先 (见 /pair/current 头注)。
  const [activePair] = await db
    .select({ id: learner_agent_pairs.id })
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.active, true))
    .orderBy(asc(learner_agent_pairs.is_demo), asc(learner_agent_pairs.established_at))
    .limit(1);

  const axesByLesson =
    activePair && rows.length > 0
      ? await getLessonAxesForLessons(db, activePair.id, rows.map((r) => r.id))
      : new Map();

  return c.json(rows.map((r) => ({ ...r, axes: axesByLesson.get(r.id) ?? null })));
});

// full revision history ("病历本") for the Revised pill's popover.
// Note: the sibling "latest only" route (`GET /lessons/:id/revisions/latest`)
// actually lives in routes/write.ts (colocated with the PATCH that writes
// lesson_revisions), not here — a pre-existing inconsistency, not introduced
// by this route. This one is read-only and belongs in read.ts per the
// Repository read/write split.
//
// 迁移 0033 (双轨修订) — 可选 ?kind= 查询参数: 缺省(不传)= 只回 kind='teaching'
// 的行 (学习者界面默认口径, 工程性修订对她隐身); ?kind=technical 只回后厨
// 事务那半; ?kind=all 两轨都要, 不加过滤。这是端点默认行为的收紧, 不是签名
// 破坏性变化 —— 既有调用 (不传 kind) 拿到的仍是"这节课的修订历史", 只是范围
// 从"全部"变成"面向学习者的那部分", 与本批展示层的双轨隐身原则一致。
r.get('/lessons/:id/revisions', async (c) => {
  const id = c.req.param('id');
  const kindParam = c.req.query('kind');
  const conditions = [eq(lesson_revisions.lesson_id, id)];
  if (kindParam !== 'all') {
    conditions.push(eq(lesson_revisions.kind, kindParam === 'technical' ? 'technical' : 'teaching'));
  }
  const rows = await db
    .select()
    .from(lesson_revisions)
    .where(and(...conditions))
    .orderBy(desc(lesson_revisions.revision));
  return c.json(rows);
});

// Cards 页管理视图: 全量闪卡(含 paused). Mock 端 getAllFlashcards
// 只按 pair_id 过滤、不做二次排序(数组天然保持插入序); SQL 端用 created_at asc
// 落实同样的"先建的卡在前"稳定序,两端行为对齐。
r.get('/pairs/:pairId/flashcards', async (c) => {
  const pairId = c.req.param('pairId');
  const rows = await db
    .select()
    .from(flashcards)
    .where(eq(flashcards.pair_id, pairId))
    .orderBy(asc(flashcards.created_at));
  return c.json(rows);
});

r.get('/pairs/:pairId/reviews/due', async (c) => {
  const pairId = c.req.param('pairId');
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Number(limitParam) : undefined;
  const all = await db.select().from(flashcards).where(eq(flashcards.pair_id, pairId));
  // FSRS due_at is inside the jsonb; filter in JS for now (W3 will optimize via generated column / index)
  // Paused cards never enter the review queue (batch 9 验收补刀 — Mock's
  // getDueReviews already filtered these; live path must agree or Suspend
  // is decorative).
  const now = new Date().getTime();
  const due = all
    .filter((f) => !f.paused)
    .filter((f) => new Date(f.fsrs_state.due_at).getTime() <= now)
    .sort(
      (a, b) =>
        new Date(a.fsrs_state.due_at).getTime() - new Date(b.fsrs_state.due_at).getTime()
    );
  return c.json(limit ? due.slice(0, limit) : due);
});

// ============================================================================
// lesson progress (§6 完成状态机) + lesson patches (§4
// 改课三律落点) + lesson loop receipts (§5 回执制). Writes: POST declare-
// completed lives in write.ts; MCP add_lesson_patch / close_lesson_loop live
// in mcp/server.ts. These are the read paths only.
// ============================================================================

function synthesizedProgress(pairId: string, lessonId: string) {
  // No row yet = 'not_started' — synthesized rather than persisted, so a
  // lesson nobody has touched doesn't need a pre-seeded row per (pair, lesson).
  return {
    id: null,
    pair_id: pairId,
    lesson_id: lessonId,
    state: 'not_started' as const,
    declared_at: null,
    closed_at: null,
    checklist_snapshot: null,
    prerequisite_skips: [] as unknown[],
    updated_at: null,
    synthesized: true,
  };
}

r.get('/pairs/:pairId/lessons/:lessonId/progress', async (c) => {
  const pairId = c.req.param('pairId');
  const lessonId = c.req.param('lessonId');
  const [row] = await db
    .select()
    .from(lesson_progress)
    .where(and(eq(lesson_progress.pair_id, pairId), eq(lesson_progress.lesson_id, lessonId)))
    .limit(1);
  return c.json(row ?? synthesizedProgress(pairId, lessonId));
});

// 课程列表批量拉状态 (brief §1) — one row per lesson in the course, in lesson
// order; lessons with no lesson_progress row yet get the synthesized default
// so the client never has to special-case "row missing" vs "not_started".
r.get('/pairs/:pairId/courses/:courseId/progress', async (c) => {
  const pairId = c.req.param('pairId');
  const courseId = c.req.param('courseId');
  // 与学习者书架 (GET /courses/:id/lessons) 同口径——未发布课的进度
  // 也不该露给学习者 (否则数组长度/lesson_id 泄漏草稿课存在)。teacher 面走 MCP,
  // 不经此路由。
  const includeUnpublished = c.req.query('include_unpublished') === '1';
  const courseLessons = await db
    .select({ id: lessons.id })
    .from(lessons)
    .where(
      includeUnpublished
        ? eq(lessons.course_id, courseId)
        : and(eq(lessons.course_id, courseId), isNotNull(lessons.published_at))
    )
    .orderBy(asc(lessons.order));
  if (courseLessons.length === 0) return c.json([]);

  const lessonIds = courseLessons.map((l) => l.id);
  const rows = await db
    .select()
    .from(lesson_progress)
    .where(and(eq(lesson_progress.pair_id, pairId), inArray(lesson_progress.lesson_id, lessonIds)));
  const byLessonId = new Map(rows.map((row) => [row.lesson_id, row]));

  return c.json(
    courseLessons.map((l) => byLessonId.get(l.id) ?? synthesizedProgress(pairId, l.id))
  );
});

r.get('/lessons/:id/patches', async (c) => {
  const id = c.req.param('id');
  const rows = await db
    .select()
    .from(lesson_patches)
    .where(eq(lesson_patches.lesson_id, id))
    .orderBy(asc(lesson_patches.created_at));
  return c.json(rows);
});

r.get('/lessons/:id/receipts', async (c) => {
  const id = c.req.param('id');
  const rows = await db
    .select()
    .from(lesson_loop_receipts)
    .where(eq(lesson_loop_receipts.lesson_id, id))
    .orderBy(asc(lesson_loop_receipts.created_at));
  return c.json(rows);
});

// ============================================================================
// sessions + events + evaluations
// ============================================================================

r.get('/pairs/:pairId/sessions/recent', async (c) => {
  const pairId = c.req.param('pairId');
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Number(limitParam) : 10;
  const rows = await db
    .select()
    .from(learning_sessions)
    .where(eq(learning_sessions.pair_id, pairId))
    .orderBy(desc(learning_sessions.started_at))
    .limit(limit);
  return c.json(rows);
});

r.get('/sessions/:id', async (c) => {
  const id = c.req.param('id');
  const rows = await db.select().from(learning_sessions).where(eq(learning_sessions.id, id)).limit(1);
  return c.json(rows[0] ?? null);
});

r.get('/sessions/:id/events', async (c) => {
  const id = c.req.param('id');
  const rows = await db
    .select()
    .from(session_events)
    .where(eq(session_events.session_id, id))
    .orderBy(asc(session_events.occurred_at));
  return c.json(rows);
});

r.get('/pairs/:pairId/evaluations', async (c) => {
  const pairId = c.req.param('pairId');
  const rows = await db
    .select()
    .from(post_lesson_evaluations)
    .where(eq(post_lesson_evaluations.pair_id, pairId))
    .orderBy(desc(post_lesson_evaluations.created_at));
  return c.json(rows);
});

// ============================================================================
// teacher growth (hypotheses + reflections)
// ============================================================================

r.get('/pairs/:pairId/hypotheses', async (c) => {
  const pairId = c.req.param('pairId');
  const rows = await db
    .select()
    .from(learner_hypotheses)
    .where(eq(learner_hypotheses.pair_id, pairId))
    .orderBy(desc(learner_hypotheses.created_at));
  return c.json(rows);
});

r.get('/pairs/:pairId/reflections', async (c) => {
  const pairId = c.req.param('pairId');
  // 0018 (§1/§5): expired ⑥ (weather) rows are
  // excluded from every read path, this HTTP route included.
  const rows = await db
    .select()
    .from(teacher_reflections)
    .where(and(eq(teacher_reflections.pair_id, pairId), notExpiredWeatherFilter()))
    .orderBy(desc(teacher_reflections.written_at));
  return c.json(rows);
});

// ============================================================================
// exercise + submissions
// ============================================================================

r.get('/lessons/:id/exercises', async (c) => {
  const id = c.req.param('id');
  const rows = await db
    .select()
    .from(exercises)
    .where(eq(exercises.lesson_id, id))
    .orderBy(asc(exercises.order));
  return c.json(rows);
});

r.get('/learners/:learnerId/submissions', async (c) => {
  const learnerId = c.req.param('learnerId');
  const exerciseId = c.req.query('exercise_id');
  const rows = await db
    .select()
    .from(exercise_submissions)
    .where(
      exerciseId
        ? and(
            eq(exercise_submissions.learner_id, learnerId),
            eq(exercise_submissions.exercise_id, exerciseId)
          )
        : eq(exercise_submissions.learner_id, learnerId)
    );
  return c.json(rows);
});

// ============================================================================
// quiz: SimulatedQuiz (agent 出题) + banks / questions / attempts (真题路径)
// ============================================================================

// round 3 (2026-07-07 Quiz 通电): 换掉空数组桩 — 按 course 分组是产品要求
// (Web Quiz 页按 course 分组列出), 这里给全 pair 列表 + 可选 course_id 过滤,
// 分组本身在前端做。"附每卷题数" — question_count 是 questions.length 的便利
// 冗余字段, 不在 SimulatedQuiz 契约类型里, 前端可忽略只用 questions.length。
r.get('/pairs/:pairId/simulated-quizzes', async (c) => {
  const pairId = c.req.param('pairId');
  const courseId = c.req.query('course_id');
  const rows = await db
    .select()
    .from(simulated_quizzes)
    .where(
      courseId
        ? and(eq(simulated_quizzes.pair_id, pairId), eq(simulated_quizzes.course_id, courseId))
        : eq(simulated_quizzes.pair_id, pairId)
    )
    .orderBy(desc(simulated_quizzes.created_at));
  return c.json(rows.map((row) => ({ ...row, question_count: row.questions.length })));
});

r.get('/simulated-quizzes/:id', async (c) => {
  const id = c.req.param('id');
  const rows = await db.select().from(simulated_quizzes).where(eq(simulated_quizzes.id, id)).limit(1);
  return c.json(rows[0] ?? null);
});

r.get('/simulated-quizzes/:id/attempts', async (c) => {
  const id = c.req.param('id');
  const rows = await db
    .select()
    .from(simulated_quiz_attempts)
    .where(eq(simulated_quiz_attempts.quiz_id, id))
    .orderBy(desc(simulated_quiz_attempts.started_at));
  return c.json(rows);
});

r.get('/question-banks', async (c) => {
  const rows = await db.select().from(question_banks);
  return c.json(rows);
});

r.get('/question-banks/:id/questions', async (c) => {
  const id = c.req.param('id');
  const rows = await db.select().from(quiz_questions).where(eq(quiz_questions.bank_id, id));
  return c.json(rows);
});

r.get('/learners/:learnerId/quiz-attempts', async (c) => {
  const learnerId = c.req.param('learnerId');
  const rows = await db
    .select()
    .from(quiz_attempts)
    .where(eq(quiz_attempts.learner_id, learnerId))
    .orderBy(desc(quiz_attempts.started_at));
  return c.json(rows);
});

// ============================================================================
// mindmap + associations + pending cards
// ============================================================================

r.get('/lessons/:id/mindmaps', async (c) => {
  const id = c.req.param('id');
  // mindmaps 表没有 target 列——association 是 lesson↔图 的唯一真相。
  // 裸查 scope='lesson' 会把全库每节课的图都端上来。
  const assocs = await db
    .select()
    .from(mindmap_associations)
    .where(and(eq(mindmap_associations.target_type, 'lesson'), eq(mindmap_associations.target_id, id)));
  const assocIds = assocs.map((a) => a.mindmap_id);
  const rows = assocIds.length
    ? await db.select().from(mindmaps).where(inArray(mindmaps.id, assocIds))
    : [];
  return c.json(rows);
});

r.get('/courses/:id/mindmaps', async (c) => {
  const id = c.req.param('id');
  const assocs = await db
    .select()
    .from(mindmap_associations)
    .where(and(eq(mindmap_associations.target_type, 'course'), eq(mindmap_associations.target_id, id)));
  const assocIds = assocs.map((a) => a.mindmap_id);
  const rows = assocIds.length
    ? await db.select().from(mindmaps).where(inArray(mindmaps.id, assocIds))
    : [];
  return c.json(rows);
});

// 排序键 = "最近接触" (2026-07-30, 同 documents/recent 一条规则): 此前无
// ORDER BY, 由调用方 (RecentRail) 自己按 updated_at 排——而 updated_at 只写在
// 编辑时, 看图不动它。改为 greatest(updated_at, 该图最近一条 mindmap.viewed
// 事件时间) 降序; 无 viewed 事件的存量图 GREATEST 忽略 NULL, 退化成纯
// updated_at 序。Mindmap 页按 scope/course 分组渲染, 组内顺序随之变成"最近看
// 过的在前", 不改变分组本身。
r.get('/pairs/:pairId/mindmaps', async (c) => {
  const pairId = c.req.param('pairId');
  const scope = c.req.query('scope'); // optional filter: 'custom' / 'all'
  const lastViewed = db
    .select({
      mindmap_id: sql<string>`${session_events.payload}->>'mindmap_id'`.as('mindmap_id'),
      last_viewed_at: sql<Date>`max(${session_events.occurred_at})`.as('last_viewed_at'),
    })
    .from(session_events)
    .where(
      and(eq(session_events.pair_id, pairId), eq(session_events.event_type, 'mindmap.viewed'))
    )
    .groupBy(sql`${session_events.payload}->>'mindmap_id'`)
    .as('last_viewed');
  const all = await db
    .select()
    .from(mindmaps)
    .leftJoin(lastViewed, eq(lastViewed.mindmap_id, mindmaps.id))
    .where(eq(mindmaps.owner_pair_id, pairId))
    .orderBy(desc(sql`greatest(${mindmaps.updated_at}, ${lastViewed.last_viewed_at})`))
    .then((rows) => rows.map((row) => row.mindmaps));
  if (scope && scope !== 'all') {
    return c.json(all.filter((m) => m.scope === scope));
  }
  return c.json(all);
});

r.get('/mindmaps/:id', async (c) => {
  const id = c.req.param('id');
  const rows = await db.select().from(mindmaps).where(eq(mindmaps.id, id)).limit(1);
  return c.json(rows[0] ?? null);
});

r.get('/mindmaps/:id/associations', async (c) => {
  const id = c.req.param('id');
  const rows = await db
    .select()
    .from(mindmap_associations)
    .where(eq(mindmap_associations.mindmap_id, id));
  return c.json(rows);
});

r.get('/pairs/:pairId/pending-cards', async (c) => {
  const pairId = c.req.param('pairId');
  const rows = await db
    .select()
    .from(pending_mindmap_cards)
    .where(eq(pending_mindmap_cards.owner_pair_id, pairId))
    .orderBy(desc(pending_mindmap_cards.created_at));
  return c.json(rows);
});

// ============================================================================
// feedback + reminders
// ============================================================================

// 现场反馈笔: rows now carry kind/status/status_note/anchors
// (select() 全列返回, web 端历史视图直接可用)。排序从 ritual 的 week_of
// 改为 submitted_at desc——事件式反馈的"最新在前"看落账时刻, 不看周桶。
r.get('/pairs/:pairId/feedback', async (c) => {
  const pairId = c.req.param('pairId');
  const rows = await db
    .select()
    .from(learner_feedback)
    .where(eq(learner_feedback.pair_id, pairId))
    .orderBy(desc(learner_feedback.submitted_at));
  return c.json(rows);
});

r.get('/pairs/:pairId/reminders', async (c) => {
  const pairId = c.req.param('pairId');
  const rows = await db
    .select()
    .from(reminders)
    .where(eq(reminders.pair_id, pairId))
    .orderBy(asc(reminders.scheduled_for));
  return c.json(rows);
});

// ============================================================================
// agent orient (get_context / get_learner_brief MCP tools mirror these 1:1)
// ============================================================================
//
// Both are cold-start / pre-lesson reads for the agent — the "eyes" to match
// the write-only memory tools (record_learner_hypothesis etc had no read-back
// before this). Token-frugal by design; see src/lib/context-brief.ts for the
// field-level rationale. Errors are self-healing: an unknown pairId lists the
// pairs that do exist (cheap query, small table) instead of a bare 404.

r.get('/pairs/:pairId/context', async (c) => {
  const pairId = c.req.param('pairId');
  if (!(await pairExists(pairId))) {
    return c.json(
      { error: 'pair_not_found', pair_id: pairId, available_pairs: await listAvailablePairs() },
      404
    );
  }
  return c.json(await buildContextSnapshot(pairId));
});

r.get('/pairs/:pairId/learner-brief', async (c) => {
  const pairId = c.req.param('pairId');
  if (!(await pairExists(pairId))) {
    return c.json(
      { error: 'pair_not_found', pair_id: pairId, available_pairs: await listAvailablePairs() },
      404
    );
  }
  const limitParam = c.req.query('limit');
  const limit = Math.max(1, Math.min(20, limitParam ? Number(limitParam) : 5));
  return c.json(await buildLearnerBrief(pairId, limit));
});

// ============================================================================
// get_teacher_inbox (Agent Surface Hardening 第一批) — REST
// mirror of the MCP tool of the same name. No new table, no server-held
// cursor: `since` (ISO timestamp) is whatever the caller last saw; omitted
// means "from the beginning" (full outstanding backlog). See
// lib/teacher-inbox.ts for the derivation logic shared by both surfaces.
// ============================================================================

r.get('/pairs/:pairId/teacher-inbox', async (c) => {
  const pairId = c.req.param('pairId');
  if (!(await pairExists(pairId))) {
    return c.json(
      { error: 'pair_not_found', pair_id: pairId, available_pairs: await listAvailablePairs() },
      404
    );
  }
  const since = c.req.query('since');
  return c.json(await buildTeacherInbox(pairId, since));
});

// Silence unused import warnings for ops we'll use in B6 (write paths)
void lte;

export default r;
