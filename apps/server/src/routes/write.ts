// Hono REST write routes — mutations (TEACHING-SPEC-v1 §7 Repository write methods).
//
// All routes mounted under /api. Server-side simulator (simulateGrading) is
// a demo stand-in gated behind LS_SIMULATE=true. With the gate off
// (default), submissions wait at 'submitted' for the real agent (MCP
// grade_exercise / pair://exercises/pending).
//
// (2026-07-11): the POST /contracts/:id/setup/start route and
// its simulateSetupProgress() demo timer were removed — dead code with zero
// real callers (no UI ever called startContractSetup; the only writer of
// setup_status: 'ready' / contract.active: true was this simulator, gated
// behind LS_SIMULATE which defaults off). 'established' is now the
// contract lifecycle's terminal state — see packages/contracts/src/pair.ts
// ContractSetupStatus.
//
// Body schema: best-effort runtime check via small helpers; trust the type
// system for now (W2+ add zod validators when we have time).

import { Hono } from 'hono';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { db, queryClient } from '../db/client';
import {
  teaching_contracts,
  courses,
  concepts,
  lessons,
  lesson_revisions,
  exercises,
  exercise_submissions,
  flashcards,
  mindmaps,
  mindmap_associations,
  pending_mindmap_cards,
  quiz_attempts,
  simulated_quizzes,
  simulated_quiz_attempts,
  syllabus_mappings,
  learner_feedback,
  reminders,
  learner_agent_pairs,
  learner_hypotheses,
  learners,
  agents,
  idempotency_keys,
  lesson_progress,
  lesson_patches,
  lesson_loop_receipts,
  lesson_revision_seen,
} from '../db/schema';
import type {
  CourseRow,
  LessonRow,
  ConceptRow,
  FlashcardRow,
  ExerciseRow,
  ExerciseSubmissionRow,
  LessonProgressRow,
  LessonRevisionRow,
  LessonPatchRow,
  LessonLoopReceiptRow,
  SimulatedQuizRow,
  SimulatedQuizAttemptRow,
  SyllabusMappingRow,
  MindmapAssociationRow,
} from '../db/schema';
import { applyRating, newCardState, type ReviewRatingLabel } from '../lib/fsrs';
import { parseFlashcardMarkdown, normalizeCardFace, type FlashcardImportParseError } from '../lib/flashcard-import';
import { appendSessionEvent } from '../lib/session-events';
import { buildIdentity } from '../lib/context-brief';
import { sweepLessonAnnotations } from '../lib/annotation-sweep';
import { isConfidenceCaptureAllowed } from '../lib/observation-gate';
import { isConfidenceLevel, type ConfidenceLevel } from '../lib/confidence';
import { getConfidenceAnchors, setConfidenceAnchors, resolveConfidencePct } from '../lib/confidence-anchors';
import { pickSkillStack } from '../lib/skillStack';
import { getCurrentContract } from '../lib/currentContract';
import { decideIdempotency } from '../lib/idempotency';
import { normalizeLearnerDisplayName, registerLearner, LEARNER_NAME_MAX_CHARS } from '../lib/first-run-onboarding';
import { checkLiveResponseRef } from '../lib/evidence-refs';
import { validateLesson, canPublish } from '../lib/validate-prep-core';
import type { SimulatedQuizAttemptAnswerWithConfidence } from '../db/schema/quiz';
import type {
  TeachingContract,
  ExerciseSubmission,
  Mindmap,
  MindmapNode,
  MindmapContent,
  Reminder,
  QuizAttempt,
  LearnerFeedback,
  MindmapAssociation,
  SourceRef,
  PendingCardSourceType,
  SimulatedQuestion,
  LessonChecklistSnapshot,
  LessonProgressState,
} from '@learn-shell/contracts';

const w = new Hono();

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Demo simulators are opt-in. Real teaching runs must never see a
// length-based auto-grader or a timer that fakes contract setup.
const SIMULATE = process.env.LS_SIMULATE === 'true';
if (SIMULATE) {
  console.log('[write] LS_SIMULATE=true — demo simulator active (grading)');
}

// ============================================================================
// 首跑学习者登记 — 名字亲手敲的落点 (设计单裁定: 名字的仪式感, 学习者自己
// 敲, 不走对话代填)。web 首跑页调用; 建的是"未配对 learner"一行, 与 agent
// 的 MCP create_pair (唯一真入学正门) 在 display_name 上汇合。幂等: 同名
// 未配对 learner 已存在 → 返回既有行。无鉴权 — v1 单机信任模型。
// 核心逻辑在 lib/first-run-onboarding.ts (registerLearner), 与 MCP 侧同源。
// ============================================================================

w.post('/onboarding/learner', async (c) => {
  const body = await c.req
    .json<{ display_name?: unknown; locale?: unknown }>()
    .catch(() => ({}) as { display_name?: unknown; locale?: unknown });
  const displayName = normalizeLearnerDisplayName(body.display_name);
  if (!displayName) {
    return c.json(
      {
        error: 'invalid_display_name',
        message: `display_name is required, 1-${LEARNER_NAME_MAX_CHARS} characters after trim.`,
      },
      400
    );
  }
  const locale = typeof body.locale === 'string' && body.locale.trim() ? body.locale.trim() : undefined;
  const result = await registerLearner(displayName, locale);
  return c.json(
    { learner_id: result.learner_id, display_name: result.display_name, reused: result.reused },
    result.reused ? 200 : 201
  );
});

// ============================================================================
// contract intake + 备课
// ============================================================================

w.post('/contracts', async (c) => {
  // 迁移 0027 领地补丁 (voided_at/void_reason 出域必要修复, 见 void_contract
  // 工单报告): a fresh contract is never created pre-voided, and voided_at's
  // Date column hits the same "JSON string ≠ Date column" mismatch already
  // documented below for created_at/updated_at/setup_started_at/
  // setup_completed_at — omit both from the POST body's accepted shape.
  // 迁移 0030 同理补丁: completed_at 是新增的 timestamp 列, 同一个 "JSON
  // string ≠ Date column" 错配 — 一份新建合约本就不该带着已结业时间戳落地,
  // 同样退出 POST body 的接受形状。
  const input = await c.req.json<Omit<TeachingContract, 'id' | 'version' | 'created_at' | 'updated_at' | 'setup_status' | 'setup_steps' | 'setup_started_at' | 'setup_completed_at' | 'voided_at' | 'void_reason' | 'completed_at'>>();
  const now = new Date();
  const id = genId('tc');
  const [row] = await db
    .insert(teaching_contracts)
    .values({
      ...input,
      id,
      version: 1,
      // 迁移 0030: teaching_contracts.active 列拆除 (退休列) — 不再
      // 有这个字段可写.
      created_at: now,
      updated_at: now,
      setup_status: 'draft',
      // skill_stack 冻结案 — all facet fields (goal/intensity/content_modality/
      // preferred_time_of_day) are already known at creation time, so
      // precompute a best-effort skill_stack here for parity with
      // MockRepository.createContract (which computes it eagerly). This
      // is NOT the "freeze at Establish" moment for the real backend —
      // this route always creates a pre-signature draft (setup_status
      // stays 'draft') — the PATCH /contracts/:id establish transition
      // below recomputes + overwrites this once the learner actually
      // signs, so it wins as the frozen value.
      skill_stack: pickSkillStack({
        goal: input.goal,
        intensity: input.intensity,
        content_modality: input.content_modality,
        preferred_time_of_day: input.preferred_time_of_day,
      }),
    })
    .returning();
  return c.json(row, 201);
});

w.patch('/contracts/:id', async (c) => {
  const id = c.req.param('id');
  const patch = await c.req.json<Partial<TeachingContract>>();
  // Drop fields whose Date columns don't accept string from JSON; pass any-typed
  // patch to Drizzle .set() — runtime values are still JSON-safe.
  const { created_at: _ca, updated_at: _ua, setup_started_at: _ss, setup_completed_at: _sc, ...rest } = patch;
  void _ca; void _ua; void _ss; void _sc;

  const updateValues: Record<string, unknown> = { ...(rest as Record<string, unknown>), updated_at: new Date() };

  // skill_stack 冻结案 — Establish 时刻冻结 skill_stack. The real web UI's
  // establish button (apps/web/src/pages/Contract/index.tsx establishMut)
  // PATCHes exactly this route with setup_status: 'established' — that
  // transition is this route's only real "Establish" trigger (POST never
  // creates an already-established/active row — see comment above). Freeze
  // here, once, using the merged final facet values (patch wins over the
  // row's current value), so later unrelated PATCHes to the same contract
  // (which won't carry setup_status: 'established' again) leave skill_stack
  // untouched — matching Stage 6a's "preference edits don't silently mutate
  // an in-flight contract" intent.
  if (rest.setup_status === 'established') {
    const [current] = await db
      .select({
        goal: teaching_contracts.goal,
        intensity: teaching_contracts.intensity,
        content_modality: teaching_contracts.content_modality,
        preferred_time_of_day: teaching_contracts.preferred_time_of_day,
      })
      .from(teaching_contracts)
      .where(eq(teaching_contracts.id, id))
      .limit(1);
    if (current) {
      updateValues.skill_stack = pickSkillStack({
        goal: (rest.goal as string | undefined) ?? current.goal,
        intensity: (rest.intensity as TeachingContract['intensity'] | undefined) ?? current.intensity,
        content_modality:
          (rest.content_modality as TeachingContract['content_modality'] | undefined) ?? current.content_modality,
        preferred_time_of_day:
          (rest.preferred_time_of_day as TeachingContract['preferred_time_of_day'] | undefined) ??
          current.preferred_time_of_day,
      });
    }
  }

  const [row] = await db
    .update(teaching_contracts)
    .set(updateValues)
    .where(eq(teaching_contracts.id, id))
    .returning();
  return c.json(row);
});

w.post('/contracts/:id/setup/cancel', async (c) => {
  const id = c.req.param('id');
  const [row] = await db
    .update(teaching_contracts)
    .set({ setup_status: 'cancelled', updated_at: new Date() })
    .where(eq(teaching_contracts.id, id))
    .returning();
  return c.json(row);
});

// 迁移 0027 (Void, not delete — 审计留痕): 学习者一侧的作废入口 — Settings.tsx
// 证书区(现役合约卡)/档案区(已作废历史行) 走这条路由。Agent 一侧走 MCP
// void_contract 工具(调用前须取得学习者逐字同意) — 两条路径共写同一对列
// (voided_at/void_reason), 幂等行为在两侧保持一致，见 mcp/server.ts 的
// void_contract case。学习者裁决 (2026-07-18): reason 对学习者可选——强制
// 留理由构成负担, 空/缺失时 void_reason 写 null。MCP 侧的 reason 必填不变:
// 给理由+逐字同意是代理人义务, 不是学习者义务。
w.post('/contracts/:id/void', async (c) => {
  const id = c.req.param('id');
  const body = await c
    .req
    .json<{ reason?: string }>()
    .catch(() => ({}) as { reason?: string });
  const trimmed = typeof body.reason === 'string' ? body.reason.trim() : '';
  const reason: string | null = trimmed || null;

  const [contract] = await db
    .select()
    .from(teaching_contracts)
    .where(eq(teaching_contracts.id, id))
    .limit(1);
  if (!contract) return c.json({ error: 'contract_not_found' }, 404);

  // pair 归属校验 — 合约行的 pair_id 必须能解析到一个真实存在的 pair, 呼应
  // mcp/server.ts void_contract 工具里 `current.pair_id !== pairId` 的校验意图
  // (W1 单租户自托管, 没有独立的调用方 pairId 可比对 — 这里退而求其次校验
  // pair_id 指向的行确实存在, 不对着悬空引用盲写), 也呼应本文件里
  // declare-completed 等路由 "先查存在性、不存在就 404" 的既有模式。
  const [pair] = await db
    .select({ id: learner_agent_pairs.id })
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.id, contract.pair_id))
    .limit(1);
  if (!pair) return c.json({ error: 'pair_not_found' }, 404);

  // 幂等: 已作废的合约重复调用返回现状, 不报错、不二次写入、不覆盖原
  // void_reason(第一次作废的理由才是历史真相) — 与 mcp/server.ts
  // void_contract 工具的幂等语义一致。
  if (contract.voided_at) {
    return c.json(contract);
  }

  const now = new Date();
  const [row] = await db
    .update(teaching_contracts)
    .set({ voided_at: now, void_reason: reason, updated_at: now })
    .where(eq(teaching_contracts.id, id))
    .returning();
  return c.json(row);
});

w.post('/pairs/:pairId/ical-token/rotate', async (c) => {
  const pairId = c.req.param('pairId');
  const url = `http://localhost:3000/api/u/${genId('tok')}.ics`;
  // (historical) used to target `active = true` (dead filter on real data,
  // see lib/currentContract.ts); now goes through the shared "current
  // contract" helper (signed non-terminal setup_status) like every other
  // former `active` consumer.
  const current = await getCurrentContract(pairId);
  if (current) {
    await db
      .update(teaching_contracts)
      .set({ ical_subscription_url: url, updated_at: new Date() })
      .where(eq(teaching_contracts.id, current.id));
  }
  return c.json({ url });
});

// ============================================================================
// identity edits (称谓体系, 2026-07-07) — write leg of the read-only
// IdentityBrief added to get_context/get_learner_brief in context-brief.ts.
// Settings' new Identity section is the only caller for now.
// ============================================================================

function normalizedDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  return trimmed;
}

w.patch('/pairs/:pairId/identity', async (c) => {
  const pairId = c.req.param('pairId');
  const body = await c.req.json<{
    learner_display_name?: string;
    agent_display_name?: string;
    agent_identity_note?: string;
  }>();

  const [pair] = await db
    .select()
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.id, pairId))
    .limit(1);
  if (!pair) return c.json({ error: 'pair_not_found' }, 404);

  if (body.learner_display_name !== undefined) {
    const name = normalizedDisplayName(body.learner_display_name);
    if (!name) return c.json({ error: 'learner_display_name_invalid' }, 400);
    await db.update(learners).set({ display_name: name }).where(eq(learners.id, pair.learner_id));
  }

  if (body.agent_display_name !== undefined) {
    const name = normalizedDisplayName(body.agent_display_name);
    if (!name) return c.json({ error: 'agent_display_name_invalid' }, 400);
    await db.update(agents).set({ display_name: name }).where(eq(agents.id, pair.agent_id));
  }

  if (body.agent_identity_note !== undefined) {
    await db
      .update(agents)
      .set({ identity_note: body.agent_identity_note })
      .where(eq(agents.id, pair.agent_id));
  }

  const identity = await buildIdentity(pairId);
  if (!identity) return c.json({ error: 'not_found' }, 404);
  return c.json(identity);
});

// ============================================================================
// Learner Model 批0/批1 — 观察禁区登记簿 +
// 把握度模式总开关. Reads (GET) live in read.ts; these are the mutations.
// ============================================================================

w.post('/pairs/:pairId/forbidden-observations', async (c) => {
  const pairId = c.req.param('pairId');
  const { category } = await c.req.json<{ category: string }>();
  const trimmed = (category ?? '').trim();
  if (!trimmed) return c.json({ error: 'category_required' }, 400);

  const [pair] = await db
    .select()
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.id, pairId))
    .limit(1);
  if (!pair) return c.json({ error: 'pair_not_found' }, 404);

  const next = pair.forbidden_observations.includes(trimmed)
    ? pair.forbidden_observations
    : [...pair.forbidden_observations, trimmed];
  const [row] = await db
    .update(learner_agent_pairs)
    .set({ forbidden_observations: next })
    .where(eq(learner_agent_pairs.id, pairId))
    .returning();
  return c.json({ forbidden_observations: row?.forbidden_observations ?? [] }, 201);
});

w.delete('/pairs/:pairId/forbidden-observations/:category', async (c) => {
  const pairId = c.req.param('pairId');
  const category = decodeURIComponent(c.req.param('category'));

  const [pair] = await db
    .select()
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.id, pairId))
    .limit(1);
  if (!pair) return c.json({ error: 'pair_not_found' }, 404);

  const next = pair.forbidden_observations.filter((x) => x !== category);
  const [row] = await db
    .update(learner_agent_pairs)
    .set({ forbidden_observations: next })
    .where(eq(learner_agent_pairs.id, pairId))
    .returning();
  return c.json({ forbidden_observations: row?.forbidden_observations ?? [] });
});

w.patch('/pairs/:pairId/confidence-mode', async (c) => {
  const pairId = c.req.param('pairId');
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  const [row] = await db
    .update(learner_agent_pairs)
    .set({ confidence_mode_enabled: !!enabled, confidence_mode_changed_at: new Date() })
    .where(eq(learner_agent_pairs.id, pairId))
    .returning();
  if (!row) return c.json({ error: 'pair_not_found' }, 404);
  return c.json({
    confidence_mode_enabled: row.confidence_mode_enabled,
    confidence_mode_changed_at: row.confidence_mode_changed_at
      ? row.confidence_mode_changed_at.toISOString()
      : null,
  });
});

// Confidence 主权立法 (学习者裁决版) — 映射权归学习者: 三档按钮折算成数值时
// 用的锚值, 由这份 pair 自己在 Settings 里调 (合法域 0-100, 严格递增
// guess<likely<certain). 教师侧 MCP 从不读这条路由——没有对应的 MCP
// tool/resource, 也不进 get_context/get_learner_brief, 见
// lib/confidence-anchors.ts 顶部注释。
w.patch('/pairs/:pairId/confidence-anchors', async (c) => {
  const pairId = c.req.param('pairId');
  const body = await c.req.json<unknown>();
  try {
    const anchors = await setConfidenceAnchors(pairId, body);
    return c.json({ confidence_anchor_pct: anchors });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'invalid_anchors';
    if (message === 'pair_not_found') return c.json({ error: 'pair_not_found' }, 404);
    return c.json({ error: 'invalid_anchors', detail: message }, 400);
  }
});

// ============================================================================
// lesson revision (update_lesson REST 对等) — same semantics/required
// fields as the MCP update_lesson tool: snapshot current version into
// lesson_revisions, apply patch, revision += 1.
// ============================================================================

w.patch('/lessons/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    revision_reason?: string;
    evidence?: string;
    content_markdown?: string;
    title?: string;
    concept_ids?: string[];
    estimated_minutes?: number;
  }>();

  if (!body.revision_reason) {
    return c.json({ error: 'revision_reason_required' }, 400);
  }

  const patch: Record<string, unknown> = {};
  if (body.content_markdown !== undefined) patch.content_markdown = body.content_markdown;
  if (body.title !== undefined) patch.title = body.title;
  if (body.concept_ids !== undefined) patch.concept_ids = body.concept_ids;
  if (body.estimated_minutes !== undefined) patch.estimated_minutes = body.estimated_minutes;
  if (Object.keys(patch).length === 0) {
    return c.json({ error: 'no_patch_fields' }, 400);
  }

  const [current] = await db.select().from(lessons).where(eq(lessons.id, id)).limit(1);
  if (!current) return c.json({ error: 'not_found' }, 404);

  // Agent Surface Hardening 第一批 ("同病同治") — same
  // fix as the MCP update_lesson tool: snapshot + revision bump used to be
  // two unguarded statements; a crash between them left a lesson_revisions
  // row with no matching revision bump (or vice versa). Both now commit
  // atomically.
  const revId = genId('lrev');
  const updated = await db.transaction(async (tx) => {
    await tx.insert(lesson_revisions).values({
      id: revId,
      lesson_id: id,
      revision: current.revision,
      prev_content_markdown: current.content_markdown,
      prev_title: current.title,
      reason: body.revision_reason!,
      evidence: body.evidence ?? null,
      revised_by: 'rest',
      revised_at: new Date(),
    });

    const [row] = await tx
      .update(lessons)
      .set({ ...patch, revision: current.revision + 1 })
      .where(eq(lessons.id, id))
      .returning();
    return row;
  });

  // 红队 P1-04 — REST 补发布闸: 已发布课 (published_at 非空) 的每次修订都要
  // 重新过发布门禁, 与 MCP update_lesson (mcp/server.ts) 同一套
  // validateLesson+canPublish 判定, 照抄它的调用形状——两个入口语义归一,
  // 不能一个查一个不查。validateLesson 走独立的 queryClient 连接读 DB,
  // 只有 commit 之后才看得见上面刚写的新内容, 所以这里放在事务 commit
  // 之后而不是里面; FAIL 时用 `current` 快照把 lesson 字段 + revision 计数
  // 撤回, 并删掉被拒的 revision 行——净效果与"事务内回滚"等价("拒绝写
  // 入"), 只是走了 commit+revert 两步, 不是真正的单事务回滚。草稿课
  // (published_at 为空) 不受影响, 行为不变。
  if (current.published_at != null) {
    const report = await validateLesson(queryClient, id);
    if (report && !canPublish(report.status)) {
      const reds = report.checks.filter((c) => c.severity === 'fail');
      await db.transaction(async (tx2) => {
        const revertFields: Record<string, unknown> = {};
        for (const key of Object.keys(patch)) {
          revertFields[key] = (current as unknown as Record<string, unknown>)[key];
        }
        await tx2
          .update(lessons)
          .set({ ...revertFields, revision: current.revision })
          .where(eq(lessons.id, id));
        await tx2.delete(lesson_revisions).where(eq(lesson_revisions.id, revId));
      });
      return c.json(
        {
          error: 'publish_gate_failed',
          detail:
            `Publish rejected — a published lesson's revision must clear the Publish Gate again: ${id} status=${report.status}. Red-light list: ` +
            reds.map((c) => `[${c.category}·${c.id}] ${c.detail}`).join('; ') +
            '. Every revision to a published lesson has to clear the publish gate again — fix the issues and resubmit, or unpublish first (contact an administrator if there is no unpublish endpoint).',
          lesson_id: id,
          status: report.status,
          red_lights: reds,
        },
        400
      );
    }
  }

  // 批D — same post-write resweep as
  // the MCP update_lesson tool (mcp/server.ts), only worth doing when the
  // text itself changed. Kept outside the transaction — best-effort repair
  // scan over a separate entity (lesson_annotations), not required for the
  // revision write's own atomicity.
  if (patch.content_markdown !== undefined) {
    await sweepLessonAnnotations(id);
  }

  return c.json(updated);
});

w.get('/lessons/:id/revisions/latest', async (c) => {
  const id = c.req.param('id');
  const rows = await db
    .select()
    .from(lesson_revisions)
    .where(eq(lesson_revisions.lesson_id, id))
    .orderBy(desc(lesson_revisions.revision))
    .limit(1);
  return c.json(rows[0] ?? null);
});

// ============================================================================
// learner hypotheses — sovereignty review (confirm / reject / freeze)
// ============================================================================

// 补洞: 这条路由此前对非法 action 静默兜底成 'freeze'（跟
// apps/web/src/repository/MockRepository.ts 的 reviewHypothesis 同款隐患,
// 该文件在同批一起修掉, 不是这里抄它的注释）——一个拼错的 action 字符串会被
// 悄悄当成"冻结"落库, 学习者的冻结/驳回主权动作出了错却查无凭据。现在显式校
// 验 action 合法性, 拼错/漏传直接 400, 不猜测意图；existence 检查挪到 mutate
// 之前, 找不到就是人话版 404, 不是裸
// 'not_found' 让调用方自己猜。幂等: 同一 action 重复提交只是把同一份状态再写
// 一遍（含 updated_at 刷新), 不报错、不产生副作用分叉——跟合约/闪卡等其它写
// 路由的"PATCH 可重放"惯例一致。
w.post('/hypotheses/:id/review', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    action?: 'confirm' | 'reject' | 'freeze';
    user_note?: string;
  }>();
  const { action, user_note } = body;

  if (action !== 'confirm' && action !== 'reject' && action !== 'freeze') {
    return c.json(
      {
        error: 'invalid_action',
        detail: 'This action must be one of confirm (accept), reject (decline), or freeze — the received value matches none of them.',
        allowed: ['confirm', 'reject', 'freeze'],
      },
      400
    );
  }

  const [existing] = await db
    .select({ id: learner_hypotheses.id })
    .from(learner_hypotheses)
    .where(eq(learner_hypotheses.id, id))
    .limit(1);
  if (!existing) {
    return c.json(
      { error: 'not_found', detail: `Learner hypothesis not found (id: ${id}) — it may have been cleaned up; refresh and try again.` },
      404
    );
  }

  const now = new Date();
  const patch: Record<string, unknown> = { updated_at: now };
  if (user_note !== undefined) patch.user_note = user_note;

  if (action === 'confirm') {
    patch.status = 'confirmed';
    patch.user_approved = true;
    patch.allowed_for_teaching = true;
    patch.last_verified_at = now;
  } else if (action === 'reject') {
    patch.status = 'rejected';
    patch.user_approved = false;
    patch.allowed_for_teaching = false;
  } else {
    patch.status = 'frozen';
    patch.allowed_for_teaching = false;
  }

  const [row] = await db
    .update(learner_hypotheses)
    .set(patch)
    .where(eq(learner_hypotheses.id, id))
    .returning();
  return c.json(row);
});

// ============================================================================
// learning evidence — review ratings (real FSRS) + client-observed events
// ============================================================================

async function pairIdForLearner(learnerId: string): Promise<string | null> {
  const [pair] = await db
    .select()
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.learner_id, learnerId))
    .limit(1);
  return pair?.id ?? null;
}

// 红队 P3 (item 4) —
// operation tag for this route's idempotency_keys rows, so a key reused
// against a different tool/route is caught rather than silently returning
// the wrong cached response (see grade_exercise etc in mcp/server.ts for the
// MCP-side equivalent).
const REVIEWS_IDEMPOTENCY_OPERATION = 'rest:reviews';

w.post('/reviews', async (c) => {
  const input = await c.req.json<{
    pair_id: string;
    card_id: string;
    rating: ReviewRatingLabel;
    answer_text?: string | null;
    time_to_answer_ms?: number | null;
    idempotency_key?: string;
  }>();

  // sweep — card_id reaches the select's eq() below; undefined there is
  // the lethal postgres-js UNDEFINED_VALUE position (see lib/tool-args.ts).
  // rating feeds applyRating's RATING_MAP — an unknown/missing label would
  // produce an undefined ts-fsrs Grade; both get a 400 up front.
  if (typeof input.card_id !== 'string' || input.card_id.trim() === '') {
    return c.json({ error: 'card_id_required' }, 400);
  }
  if (!(['Again', 'Hard', 'Good', 'Easy'] as string[]).includes(input.rating as string)) {
    return c.json({ error: 'rating_invalid', allowed: ['Again', 'Hard', 'Good', 'Easy'] }, 400);
  }

  const [card] = await db
    .select()
    .from(flashcards)
    .where(eq(flashcards.id, input.card_id))
    .limit(1);
  if (!card) return c.json({ error: 'not_found' }, 404);

  // 红队 P3 — mismatch risk: a caller-supplied pair_id that doesn't match the
  // card's actual owner would misattribute the review event (SessionEvent +
  // learning_sessions roll-up) to the wrong pair. Trust the card's own
  // pair_id, and reject loudly rather than silently writing under whichever
  // pair_id the client happened to send.
  if (input.pair_id !== card.pair_id) {
    return c.json(
      { error: 'pair_mismatch', card_pair_id: card.pair_id, requested_pair_id: input.pair_id },
      409
    );
  }

  const idempotencyKey = input.idempotency_key;
  if (idempotencyKey) {
    const [existing] = await db
      .select()
      .from(idempotency_keys)
      .where(eq(idempotency_keys.key, idempotencyKey))
      .limit(1);
    const decision = decideIdempotency<Record<string, unknown>>(
      idempotencyKey,
      existing ?? null,
      REVIEWS_IDEMPOTENCY_OPERATION
    );
    if (decision.action === 'reject') {
      return c.json(
        { error: 'idempotency_key_reused', stored_operation: existing!.operation },
        409
      );
    }
    if (decision.action === 'replay') {
      return c.json(decision.value);
    }
  }

  const now = new Date();
  // Agent Surface Hardening 第一批 — "读 FSRS → 算
  // → 更新卡 → 追加 event" (+ the idempotency claim, when a key was given) all
  // commit as one transaction: a crash mid-way used to be able to leave an
  // updated card with no matching review.rated event, or vice versa.
  const updated = await db.transaction(async (tx) => {
    const nextState = applyRating(card.fsrs_state, input.rating, now);
    const [row] = await tx
      .update(flashcards)
      .set({ fsrs_state: nextState, updated_at: now })
      .where(eq(flashcards.id, input.card_id))
      .returning();

    await appendSessionEvent(
      {
        pair_id: input.pair_id,
        event_type: 'review.rated',
        actor_type: 'learner',
        mode: 'review',
        card_id: card.id,
        concept_ids: card.concept_id ? [card.concept_id] : [],
        payload: {
          card_id: card.id,
          rating: input.rating,
          answer_text: input.answer_text ?? null,
          time_to_answer_ms: input.time_to_answer_ms ?? null,
        },
        occurred_at: now,
      },
      tx
    );

    if (idempotencyKey) {
      await tx
        .insert(idempotency_keys)
        .values({
          key: idempotencyKey,
          pair_id: input.pair_id,
          operation: REVIEWS_IDEMPOTENCY_OPERATION,
          response_json: row as unknown as Record<string, unknown>,
        })
        .onConflictDoNothing();
    }

    return row;
  });

  return c.json(updated);
});

// ============================================================================
// Flashcard management (Stage 7e-cards / batch 9 worker E) — these routes
// were missing entirely (Repository interface + Http/Mock impls existed,
// but no REST route backed them, and the `paused` column didn't exist on
// the table either — see db/schema/content.ts + drizzle/0011). Mirrors the
// MCP `add_flashcard` tool's `newCardState` init so both write paths agree.
// ============================================================================

w.post('/flashcards', async (c) => {
  const input = await c.req.json<{
    pair_id: string;
    concept_id: string | null;
    deck_id: string;
    front: string;
    back: string;
    tags?: string[];
    source_refs?: SourceRef[];
  }>();
  const now = new Date();
  const id = genId('fc');
  const [row] = await db
    .insert(flashcards)
    .values({
      id,
      pair_id: input.pair_id,
      concept_id: input.concept_id ?? null,
      deck_id: input.deck_id,
      front: input.front,
      back: input.back,
      tags: input.tags ?? [],
      source_refs: input.source_refs ?? [],
      fsrs_state: newCardState(now),
      paused: false,
      created_at: now,
      updated_at: now,
    })
    .returning();
  return c.json(row, 201);
});

w.patch('/flashcards/:id', async (c) => {
  const id = c.req.param('id');
  // extended from {paused}-only to a partial update; Cards page
  // select-mode "Move to deck" reassigns deck_id, at least one field required.
  const body = await c.req.json<{ paused?: boolean; deck_id?: string }>();
  const patch: { paused?: boolean; deck_id?: string; updated_at: Date } = {
    updated_at: new Date(),
  };
  if (body.paused !== undefined) patch.paused = body.paused;
  if (body.deck_id !== undefined) patch.deck_id = body.deck_id;
  if (body.paused === undefined && body.deck_id === undefined) {
    return c.json({ error: 'no_patch_fields' }, 400);
  }
  const [row] = await db
    .update(flashcards)
    .set(patch)
    .where(eq(flashcards.id, id))
    .returning();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

w.post('/flashcards/:id/reset', async (c) => {
  const id = c.req.param('id');
  const now = new Date();
  const [row] = await db
    .update(flashcards)
    .set({ fsrs_state: newCardState(now), updated_at: now })
    .where(eq(flashcards.id, id))
    .returning();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

w.delete('/flashcards/:id', async (c) => {
  const id = c.req.param('id');
  await db.delete(flashcards).where(eq(flashcards.id, id));
  return c.body(null, 204);
});

// ============================================================================
// Course deletion — footprint preview + hard delete.
//
// flashcards.concept_id and syllabus_mappings.asset_id / mindmap_associations
// .target_id are all unconstrained text columns (no FK — see
// db/schema/content.ts, db/schema/syllabus.ts, db/schema/mindmap.ts), so
// Postgres cascade (courses → lessons/concepts/exercises/simulated_quizzes,
// all ON DELETE cascade) does NOT reach them. Both routes below share the
// same "walk course → lessons → concepts, then match the two polymorphic
// tables against [course_id, ...lesson_ids]" derivation so the footprint
// preview and the actual delete never disagree on what's affected.
//
// (2026-07-14) — delete semantics now layered in two:
//   Archive (default): graveyard JSON written to disk, then DB rows deleted.
//     Recoverable via POST /courses/restore.
//   Purge (`?purge=true`): same delete, but the just-written graveyard file
//     is removed too — "系统永久留副本" no longer overrides "用户可删除";
//     purge is the learner's real, unrecoverable delete. Response body names
//     which semantics applied (courses used to return bare 204 — now 200 +
//     body, so a repository caller that only awaited Promise<void> still
//     works unchanged, see HttpRepository's `api()` 204-or-json handling).
// ============================================================================

w.get('/courses/:id/footprint', async (c) => {
  const id = c.req.param('id');
  const [course] = await db.select().from(courses).where(eq(courses.id, id)).limit(1);
  if (!course) return c.json({ error: 'not_found' }, 404);

  const lessonRows = await db.select({ id: lessons.id }).from(lessons).where(eq(lessons.course_id, id));
  const lessonIds = lessonRows.map((l) => l.id);
  const conceptRows = await db.select({ id: concepts.id }).from(concepts).where(eq(concepts.course_id, id));
  const conceptIds = conceptRows.map((cRow) => cRow.id);
  const assetIds = [id, ...lessonIds];

  const [exerciseRows, flashcardRows, quizRows, syllabusMappingRows, mindmapAssocRows] = await Promise.all([
    lessonIds.length
      ? db.select({ id: exercises.id }).from(exercises).where(inArray(exercises.lesson_id, lessonIds))
      : Promise.resolve([]),
    conceptIds.length
      ? db.select({ id: flashcards.id }).from(flashcards).where(inArray(flashcards.concept_id, conceptIds))
      : Promise.resolve([]),
    db.select({ id: simulated_quizzes.id }).from(simulated_quizzes).where(eq(simulated_quizzes.course_id, id)),
    db.select({ id: syllabus_mappings.id }).from(syllabus_mappings).where(inArray(syllabus_mappings.asset_id, assetIds)),
    db
      .select({ id: mindmap_associations.id })
      .from(mindmap_associations)
      .where(inArray(mindmap_associations.target_id, assetIds)),
  ]);

  return c.json({
    lessons: lessonIds.length,
    concepts: conceptIds.length,
    exercises: exerciseRows.length,
    flashcards: flashcardRows.length,
    quizzes: quizRows.length,
    syllabus_mappings: syllabusMappingRows.length,
    mindmap_associations: mindmapAssocRows.length,
  });
});

w.delete('/courses/:id', async (c) => {
  const id = c.req.param('id');
  const [course] = await db.select().from(courses).where(eq(courses.id, id)).limit(1);
  if (!course) return c.json({ error: 'not_found' }, 404);

  // ---- Gather everything this course touches, as a pre-delete snapshot ----
  const lessonRows = await db.select().from(lessons).where(eq(lessons.course_id, id));
  const lessonIds = lessonRows.map((l) => l.id);
  const conceptRows = await db.select().from(concepts).where(eq(concepts.course_id, id));
  const conceptIds = conceptRows.map((cRow) => cRow.id);
  const assetIds = [id, ...lessonIds];

  const [
    exerciseRows,
    lessonProgressRows,
    lessonRevisionRows,
    lessonPatchRows,
    lessonLoopReceiptRows,
    quizRows,
    flashcardRows,
    syllabusMappingRows,
    mindmapAssocRows,
  ] = await Promise.all([
    lessonIds.length
      ? db.select().from(exercises).where(inArray(exercises.lesson_id, lessonIds))
      : Promise.resolve([]),
    lessonIds.length
      ? db.select().from(lesson_progress).where(inArray(lesson_progress.lesson_id, lessonIds))
      : Promise.resolve([]),
    lessonIds.length
      ? db.select().from(lesson_revisions).where(inArray(lesson_revisions.lesson_id, lessonIds))
      : Promise.resolve([]),
    lessonIds.length
      ? db.select().from(lesson_patches).where(inArray(lesson_patches.lesson_id, lessonIds))
      : Promise.resolve([]),
    lessonIds.length
      ? db.select().from(lesson_loop_receipts).where(inArray(lesson_loop_receipts.lesson_id, lessonIds))
      : Promise.resolve([]),
    db.select().from(simulated_quizzes).where(eq(simulated_quizzes.course_id, id)),
    conceptIds.length
      ? db.select().from(flashcards).where(inArray(flashcards.concept_id, conceptIds))
      : Promise.resolve([]),
    db.select().from(syllabus_mappings).where(inArray(syllabus_mappings.asset_id, assetIds)),
    db.select().from(mindmap_associations).where(inArray(mindmap_associations.target_id, assetIds)),
  ]);

  const exerciseIds = exerciseRows.map((e) => e.id);
  const quizIds = quizRows.map((q) => q.id);
  const [submissionRows, quizAttemptRows] = await Promise.all([
    exerciseIds.length
      ? db.select().from(exercise_submissions).where(inArray(exercise_submissions.exercise_id, exerciseIds))
      : Promise.resolve([]),
    quizIds.length
      ? db.select().from(simulated_quiz_attempts).where(inArray(simulated_quiz_attempts.quiz_id, quizIds))
      : Promise.resolve([]),
  ]);

  // ---- Graveyard export — writes to disk BEFORE the delete transaction opens ----
  const graveyardDir = process.env.LS_GRAVEYARD_DIR ?? path.join(os.homedir(), 'learn-shell-graveyard');
  await fs.mkdir(graveyardDir, { recursive: true });
  const exportedAt = new Date();
  const filename = `course-${id}-${exportedAt.toISOString()}.json`;
  const graveyard = {
    format_version: 1,
    exported_at: exportedAt.toISOString(),
    course_id: id,

    course,
    lessons: lessonRows,
    concepts: conceptRows,
    exercises: exerciseRows,
    exercise_submissions: submissionRows,

    lesson_progress: lessonProgressRows,
    lesson_revisions: lessonRevisionRows,
    lesson_patches: lessonPatchRows,
    lesson_loop_receipts: lessonLoopReceiptRows,

    simulated_quizzes: quizRows,
    simulated_quiz_attempts: quizAttemptRows,

    // §1 口径: flashcards whose concept_id lands in this course's concept set.
    flashcards: flashcardRows,
    // Dangling polymorphic mappings — asset_id / target_id pointed at this
    // course or any of its lessons, no FK to have caught them automatically.
    syllabus_mappings: syllabusMappingRows,
    mindmap_associations: mindmapAssocRows,
  };
  const graveyardPath = path.join(graveyardDir, filename);
  await fs.writeFile(graveyardPath, JSON.stringify(graveyard, null, 2), 'utf8');

  // ---- Delete, in one transaction ----
  await db.transaction(async (tx) => {
    // (b) application-layer cleanup — the three cascade-blind tables.
    if (conceptIds.length) {
      await tx.delete(flashcards).where(inArray(flashcards.concept_id, conceptIds));
    }
    await tx.delete(syllabus_mappings).where(inArray(syllabus_mappings.asset_id, assetIds));
    await tx.delete(mindmap_associations).where(inArray(mindmap_associations.target_id, assetIds));

    // (c) course row — FK cascade takes lessons/concepts/exercises/
    // exercise_submissions/simulated_quizzes/simulated_quiz_attempts/
    // lesson_progress/lesson_revisions/lesson_patches/lesson_loop_receipts
    // with it (all verified ON DELETE cascade in db/schema/*).
    await tx.delete(courses).where(eq(courses.id, id));
  });

  // ---- Purge semantics: the DB rows are already gone above —
  // purge additionally removes the graveyard file just written, so nothing
  // recoverable survives this call. Archive (default) leaves the file for
  // POST /courses/restore.
  const purge = c.req.query('purge') === 'true';
  if (purge) {
    await fs.unlink(graveyardPath);
  }

  return c.json(
    {
      course_id: id,
      semantics: purge ? 'purge' : 'archive',
      graveyard_file: purge ? null : filename,
    },
    200
  );
});

// ============================================================================
// Course restore — reinsert an Archive-semantics graveyard export.
//
// Body carries the graveyard JSON verbatim (`{ graveyard: <the exported
// object> }`) rather than a server-side filename. This was the "which of the
// two" call the ledger left open: a filename param would need its own
// listing/lookup endpoint and path-traversal guarding against
// LS_GRAVEYARD_DIR just to become useful, and would make this route
// depend on disk state that a test can't control as directly as a JSON
// body it constructs itself. Passing the JSON straight through means the
// exact bytes DELETE /courses/:id wrote to disk (or a copy of them a human
// pasted in) round-trip through this route with zero extra surface — the
// one piece of glue a caller with only a filename needs is one `readFile`
// before the POST, which is exactly what the round-trip test below does.
//
// FK insert order mirrors the dependency graph in db/schema/*: course first
// (nothing points at it that isn't below), then lessons (course_id),
// concepts + exercises (lesson_id/course_id), exercise_submissions
// (exercise_id), the four lesson_progress-family tables (lesson_id),
// simulated_quizzes (course_id), simulated_quiz_attempts (quiz_id), and
// finally the three cascade-blind polymorphic tables (flashcards,
// syllabus_mappings, mindmap_associations) whose target ids all resolve
// against rows already inserted above (or against rows the course delete
// never touched in the first place — syllabus_nodes / mindmaps still exist,
// untouched by course deletion, so their FKs from syllabus_mappings /
// mindmap_associations are satisfied without this route doing anything
// about them).
//
// Collision policy: ANY id already present in the live tables aborts the
// whole restore with 409 — this is a revival tool, not a merge tool. A
// pre-flight existence check across every table gives a precise conflict
// report; the insert transaction is also wrapped to catch a 23505 unique
// violation as a fallback (e.g. a concurrent write between the check and
// the insert), so the guarantee holds even under a race, not just on the
// happy path.
// ============================================================================

// "Wire" row shapes — what a graveyard file actually contains once a real
// DB row (Date objects for every timestamp column, per drizzle's
// `timestamp(...)` "mode: date" default — see db/schema/*.ts) has been
// through `JSON.stringify` once (course delete, writing to disk) and
// `JSON.parse` again (this route, reading the request body). Every
// timestamp column comes back as a plain ISO string; the reviveXxx()
// helpers below turn each back into a Date immediately before insert()
// (drizzle's pg timestamp mapToDriverValue calls `.toISOString()` on the
// value, so it must be a real Date, not a string, or insert throws).
type CourseWire = Omit<CourseRow, 'created_at' | 'updated_at'> & {
  created_at: string;
  updated_at: string;
};
type ExerciseWire = Omit<ExerciseRow, 'created_at' | 'updated_at'> & {
  created_at: string;
  updated_at: string;
};
type ExerciseSubmissionWire = Omit<
  ExerciseSubmissionRow,
  'submitted_at' | 'withdrew_at' | 'graded_at'
> & {
  submitted_at: string | null;
  withdrew_at: string | null;
  graded_at: string | null;
};
type LessonProgressWire = Omit<LessonProgressRow, 'declared_at' | 'closed_at' | 'updated_at'> & {
  declared_at: string | null;
  closed_at: string | null;
  updated_at: string;
};
type LessonRevisionWire = Omit<LessonRevisionRow, 'revised_at'> & { revised_at: string };
type LessonPatchWire = Omit<LessonPatchRow, 'created_at'> & { created_at: string };
type LessonLoopReceiptWire = Omit<LessonLoopReceiptRow, 'created_at'> & { created_at: string };
type SimulatedQuizWire = Omit<SimulatedQuizRow, 'created_at'> & { created_at: string };
type SimulatedQuizAttemptWire = Omit<SimulatedQuizAttemptRow, 'started_at' | 'finished_at'> & {
  started_at: string;
  finished_at: string | null;
};
type FlashcardWire = Omit<FlashcardRow, 'created_at' | 'updated_at'> & {
  created_at: string;
  updated_at: string;
};
type SyllabusMappingWire = Omit<SyllabusMappingRow, 'created_at'> & { created_at: string };
type MindmapAssociationWire = Omit<MindmapAssociationRow, 'created_at'> & { created_at: string };

interface CourseGraveyard {
  format_version: number;
  exported_at?: string;
  course_id?: string;
  course: CourseWire;
  lessons?: LessonRow[];
  concepts?: ConceptRow[];
  exercises?: ExerciseWire[];
  exercise_submissions?: ExerciseSubmissionWire[];
  lesson_progress?: LessonProgressWire[];
  lesson_revisions?: LessonRevisionWire[];
  lesson_patches?: LessonPatchWire[];
  lesson_loop_receipts?: LessonLoopReceiptWire[];
  simulated_quizzes?: SimulatedQuizWire[];
  simulated_quiz_attempts?: SimulatedQuizAttemptWire[];
  flashcards?: FlashcardWire[];
  syllabus_mappings?: SyllabusMappingWire[];
  mindmap_associations?: MindmapAssociationWire[];
}

function toDate(v: string | null | undefined): Date | null {
  return v == null ? null : new Date(v);
}
function reviveCourse(row: CourseWire): CourseRow {
  return { ...row, created_at: new Date(row.created_at), updated_at: new Date(row.updated_at) };
}
function reviveExercises(rows: ExerciseWire[]): ExerciseRow[] {
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at), updated_at: new Date(r.updated_at) }));
}
function reviveExerciseSubmissions(rows: ExerciseSubmissionWire[]): ExerciseSubmissionRow[] {
  return rows.map((r) => ({
    ...r,
    submitted_at: toDate(r.submitted_at),
    withdrew_at: toDate(r.withdrew_at),
    graded_at: toDate(r.graded_at),
  }));
}
function reviveLessonProgress(rows: LessonProgressWire[]): LessonProgressRow[] {
  return rows.map((r) => ({
    ...r,
    declared_at: toDate(r.declared_at),
    closed_at: toDate(r.closed_at),
    updated_at: new Date(r.updated_at),
  }));
}
function reviveLessonRevisions(rows: LessonRevisionWire[]): LessonRevisionRow[] {
  return rows.map((r) => ({ ...r, revised_at: new Date(r.revised_at) }));
}
function reviveLessonPatches(rows: LessonPatchWire[]): LessonPatchRow[] {
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at) }));
}
function reviveLessonLoopReceipts(rows: LessonLoopReceiptWire[]): LessonLoopReceiptRow[] {
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at) }));
}
function reviveSimulatedQuizzes(rows: SimulatedQuizWire[]): SimulatedQuizRow[] {
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at) }));
}
function reviveSimulatedQuizAttempts(rows: SimulatedQuizAttemptWire[]): SimulatedQuizAttemptRow[] {
  return rows.map((r) => ({
    ...r,
    started_at: new Date(r.started_at),
    finished_at: toDate(r.finished_at),
  }));
}
function reviveFlashcards(rows: FlashcardWire[]): FlashcardRow[] {
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at), updated_at: new Date(r.updated_at) }));
}
function reviveSyllabusMappings(rows: SyllabusMappingWire[]): SyllabusMappingRow[] {
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at) }));
}
function reviveMindmapAssociations(rows: MindmapAssociationWire[]): MindmapAssociationRow[] {
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at) }));
}

w.post('/courses/restore', async (c) => {
  const body = await c.req.json<{ graveyard?: CourseGraveyard }>();
  const graveyard = body.graveyard;
  if (!graveyard || typeof graveyard !== 'object') {
    return c.json({ error: 'graveyard_required' }, 400);
  }
  if (graveyard.format_version !== 1) {
    return c.json(
      { error: 'unsupported_format_version', format_version: graveyard.format_version },
      400
    );
  }
  if (!graveyard.course || !graveyard.course.id) {
    return c.json({ error: 'course_required' }, 400);
  }

  const lessonRows = graveyard.lessons ?? [];
  const conceptRows = graveyard.concepts ?? [];
  const exerciseRows = graveyard.exercises ?? [];
  const submissionRows = graveyard.exercise_submissions ?? [];
  const lessonProgressRows = graveyard.lesson_progress ?? [];
  const lessonRevisionRows = graveyard.lesson_revisions ?? [];
  const lessonPatchRows = graveyard.lesson_patches ?? [];
  const lessonLoopReceiptRows = graveyard.lesson_loop_receipts ?? [];
  const quizRows = graveyard.simulated_quizzes ?? [];
  const quizAttemptRows = graveyard.simulated_quiz_attempts ?? [];
  const flashcardRows = graveyard.flashcards ?? [];
  const syllabusMappingRows = graveyard.syllabus_mappings ?? [];
  const mindmapAssocRows = graveyard.mindmap_associations ?? [];

  // ---- Pre-flight collision check — one SELECT per table, all in parallel ----
  const [
    existingCourse,
    existingLessons,
    existingConcepts,
    existingExercises,
    existingSubmissions,
    existingProgress,
    existingRevisions,
    existingPatches,
    existingReceipts,
    existingQuizzes,
    existingAttempts,
    existingFlashcards,
    existingMappings,
    existingAssociations,
  ] = await Promise.all([
    db.select({ id: courses.id }).from(courses).where(eq(courses.id, graveyard.course.id)),
    lessonRows.length
      ? db.select({ id: lessons.id }).from(lessons).where(inArray(lessons.id, lessonRows.map((r) => r.id)))
      : Promise.resolve([]),
    conceptRows.length
      ? db.select({ id: concepts.id }).from(concepts).where(inArray(concepts.id, conceptRows.map((r) => r.id)))
      : Promise.resolve([]),
    exerciseRows.length
      ? db.select({ id: exercises.id }).from(exercises).where(inArray(exercises.id, exerciseRows.map((r) => r.id)))
      : Promise.resolve([]),
    submissionRows.length
      ? db
          .select({ id: exercise_submissions.id })
          .from(exercise_submissions)
          .where(inArray(exercise_submissions.id, submissionRows.map((r) => r.id)))
      : Promise.resolve([]),
    lessonProgressRows.length
      ? db
          .select({ id: lesson_progress.id })
          .from(lesson_progress)
          .where(inArray(lesson_progress.id, lessonProgressRows.map((r) => r.id)))
      : Promise.resolve([]),
    lessonRevisionRows.length
      ? db
          .select({ id: lesson_revisions.id })
          .from(lesson_revisions)
          .where(inArray(lesson_revisions.id, lessonRevisionRows.map((r) => r.id)))
      : Promise.resolve([]),
    lessonPatchRows.length
      ? db
          .select({ id: lesson_patches.id })
          .from(lesson_patches)
          .where(inArray(lesson_patches.id, lessonPatchRows.map((r) => r.id)))
      : Promise.resolve([]),
    lessonLoopReceiptRows.length
      ? db
          .select({ id: lesson_loop_receipts.id })
          .from(lesson_loop_receipts)
          .where(inArray(lesson_loop_receipts.id, lessonLoopReceiptRows.map((r) => r.id)))
      : Promise.resolve([]),
    quizRows.length
      ? db
          .select({ id: simulated_quizzes.id })
          .from(simulated_quizzes)
          .where(inArray(simulated_quizzes.id, quizRows.map((r) => r.id)))
      : Promise.resolve([]),
    quizAttemptRows.length
      ? db
          .select({ id: simulated_quiz_attempts.id })
          .from(simulated_quiz_attempts)
          .where(inArray(simulated_quiz_attempts.id, quizAttemptRows.map((r) => r.id)))
      : Promise.resolve([]),
    flashcardRows.length
      ? db
          .select({ id: flashcards.id })
          .from(flashcards)
          .where(inArray(flashcards.id, flashcardRows.map((r) => r.id)))
      : Promise.resolve([]),
    syllabusMappingRows.length
      ? db
          .select({ id: syllabus_mappings.id })
          .from(syllabus_mappings)
          .where(inArray(syllabus_mappings.id, syllabusMappingRows.map((r) => r.id)))
      : Promise.resolve([]),
    mindmapAssocRows.length
      ? db
          .select({ id: mindmap_associations.id })
          .from(mindmap_associations)
          .where(inArray(mindmap_associations.id, mindmapAssocRows.map((r) => r.id)))
      : Promise.resolve([]),
  ]);

  const conflicts: Record<string, string[]> = {};
  const record = (label: string, rows: { id: string }[]) => {
    if (rows.length) conflicts[label] = rows.map((r) => r.id);
  };
  record('course', existingCourse);
  record('lessons', existingLessons);
  record('concepts', existingConcepts);
  record('exercises', existingExercises);
  record('exercise_submissions', existingSubmissions);
  record('lesson_progress', existingProgress);
  record('lesson_revisions', existingRevisions);
  record('lesson_patches', existingPatches);
  record('lesson_loop_receipts', existingReceipts);
  record('simulated_quizzes', existingQuizzes);
  record('simulated_quiz_attempts', existingAttempts);
  record('flashcards', existingFlashcards);
  record('syllabus_mappings', existingMappings);
  record('mindmap_associations', existingAssociations);

  if (Object.keys(conflicts).length) {
    return c.json({ error: 'id_conflict', conflicts }, 409);
  }

  // ---- Insert, in FK order, single transaction ----
  try {
    await db.transaction(async (tx) => {
      await tx.insert(courses).values(reviveCourse(graveyard.course));
      if (lessonRows.length) await tx.insert(lessons).values(lessonRows);
      if (conceptRows.length) await tx.insert(concepts).values(conceptRows);
      if (exerciseRows.length) await tx.insert(exercises).values(reviveExercises(exerciseRows));
      if (submissionRows.length) {
        await tx.insert(exercise_submissions).values(reviveExerciseSubmissions(submissionRows));
      }
      if (lessonProgressRows.length) {
        await tx.insert(lesson_progress).values(reviveLessonProgress(lessonProgressRows));
      }
      if (lessonRevisionRows.length) {
        await tx.insert(lesson_revisions).values(reviveLessonRevisions(lessonRevisionRows));
      }
      if (lessonPatchRows.length) {
        await tx.insert(lesson_patches).values(reviveLessonPatches(lessonPatchRows));
      }
      if (lessonLoopReceiptRows.length) {
        await tx.insert(lesson_loop_receipts).values(reviveLessonLoopReceipts(lessonLoopReceiptRows));
      }
      if (quizRows.length) await tx.insert(simulated_quizzes).values(reviveSimulatedQuizzes(quizRows));
      if (quizAttemptRows.length) {
        await tx.insert(simulated_quiz_attempts).values(reviveSimulatedQuizAttempts(quizAttemptRows));
      }
      if (flashcardRows.length) await tx.insert(flashcards).values(reviveFlashcards(flashcardRows));
      if (syllabusMappingRows.length) {
        await tx.insert(syllabus_mappings).values(reviveSyllabusMappings(syllabusMappingRows));
      }
      if (mindmapAssocRows.length) {
        await tx.insert(mindmap_associations).values(reviveMindmapAssociations(mindmapAssocRows));
      }
    });
  } catch (e) {
    const dbCode = (e as { code?: unknown } | null | undefined)?.code;
    if (dbCode === '23505') {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: 'id_conflict', message }, 409);
    }
    throw e;
  }

  return c.json(
    {
      restored: true,
      course_id: graveyard.course.id,
      counts: {
        lessons: lessonRows.length,
        concepts: conceptRows.length,
        exercises: exerciseRows.length,
        exercise_submissions: submissionRows.length,
        lesson_progress: lessonProgressRows.length,
        lesson_revisions: lessonRevisionRows.length,
        lesson_patches: lessonPatchRows.length,
        lesson_loop_receipts: lessonLoopReceiptRows.length,
        simulated_quizzes: quizRows.length,
        simulated_quiz_attempts: quizAttemptRows.length,
        flashcards: flashcardRows.length,
        syllabus_mappings: syllabusMappingRows.length,
        mindmap_associations: mindmapAssocRows.length,
      },
    },
    201
  );
});

// ============================================================================
// Flashcard Markdown batch import (2026-07-08) — learners write cards in
// Obsidian with a plain-text `#deck` / `Q:` / `A:` template, pastes/drops the
// file here. Parsing is delegated entirely to lib/flashcard-import.ts (pure,
// unit-tested); this route owns the DB-facing half: matching parsed cards
// against existing rows, and — only when dry_run is false — writing them.
//
// Local response types (packages/contracts stays read-only per this pass's
// red line — canonicalizing these into contracts, if wanted at all, is for
// whoever accepts this slice). No zod here either: this repo has zero zod
// usage anywhere reachable from apps/server (it's only a transitive dep of
// @modelcontextprotocol/sdk, not resolvable from this package, and adding it
// as a direct dependency means an apps/server package.json + lockfile change
// touching the whole monorepo mid-flight) — this route validates the body by
// hand, same "trust the type system, best-effort runtime check" convention
// every other route in this file already uses (see file header comment).
// ============================================================================

interface FlashcardImportPreviewItem {
  front: string;
  back: string;
  /** 1-indexed source line of this card's `Q:` marker (from the parser) —
   *  lets the client correlate a preview row back to the pasted file. */
  line: number;
  /** Only present on `updated` entries — the back currently stored in the
   *  DB, so the client can render a before/after diff. */
  previous_back?: string;
}

interface FlashcardImportDeckResult {
  new: FlashcardImportPreviewItem[];
  duplicates: FlashcardImportPreviewItem[];
  updated: FlashcardImportPreviewItem[];
}

interface FlashcardImportResponse {
  errors: FlashcardImportParseError[];
  decks: Record<string, FlashcardImportDeckResult>;
  /** Decks referenced by the import that don't have any card yet for this
   *  pair. Purely informational — decks are derived (no decks table), so
   *  "creating" one is a no-op beyond inserting its first card. */
  decks_to_create: string[];
}

w.post('/pairs/:pairId/flashcards/import', async (c) => {
  const pairId = c.req.param('pairId');
  const body = await c.req.json<{ content?: unknown; dry_run?: unknown }>();
  if (typeof body.content !== 'string') {
    return c.json({ error: 'content_required' }, 400);
  }
  // Default to dry-run whenever the flag is anything other than the literal
  // `false` — a write path should never fire by accident on a loose/omitted
  // flag.
  const dryRun = body.dry_run !== false;

  const { cards: parsedCards, errors } = parseFlashcardMarkdown(body.content);

  // Collapse same-file duplicate faces (deck + normalized front) before
  // touching the DB at all — later occurrences in the file win, matching
  // how a human re-reading top-to-bottom would resolve the conflict. This
  // is also what makes re-importing an unchanged file a no-op: every card
  // collapses back to exactly the state already in the DB.
  interface CollapsedCard {
    deck: string;
    front: string;
    back: string;
    line: number;
  }
  const collapsedByKey = new Map<string, CollapsedCard>();
  const keyOrder: string[] = [];
  for (const pc of parsedCards) {
    const key = `${pc.deck}\x00${normalizeCardFace(pc.front)}`;
    if (!collapsedByKey.has(key)) keyOrder.push(key);
    collapsedByKey.set(key, { deck: pc.deck, front: pc.front, back: pc.back, line: pc.line });
  }
  const collapsed = keyOrder.map((k) => collapsedByKey.get(k)!);

  const decksReferenced = Array.from(new Set(collapsed.map((cc) => cc.deck)));
  const existingRows =
    decksReferenced.length > 0
      ? await db
          .select()
          .from(flashcards)
          .where(and(eq(flashcards.pair_id, pairId), inArray(flashcards.deck_id, decksReferenced)))
      : [];

  const existingDecks = new Set(existingRows.map((r) => r.deck_id));
  const decksToCreate = decksReferenced.filter((d) => !existingDecks.has(d));

  const existingByKey = new Map<string, (typeof existingRows)[number]>();
  for (const row of existingRows) {
    existingByKey.set(`${row.deck_id}\x00${normalizeCardFace(row.front)}`, row);
  }

  const decksResult: Record<string, FlashcardImportDeckResult> = {};
  function bucketFor(deck: string): FlashcardImportDeckResult {
    let b = decksResult[deck];
    if (!b) {
      b = { new: [], duplicates: [], updated: [] };
      decksResult[deck] = b;
    }
    return b;
  }

  const toInsert: CollapsedCard[] = [];
  const toUpdate: { id: string; back: string }[] = [];

  for (const item of collapsed) {
    const key = `${item.deck}\x00${normalizeCardFace(item.front)}`;
    const existing = existingByKey.get(key);
    const bucket = bucketFor(item.deck);
    if (!existing) {
      bucket.new.push({ front: item.front, back: item.back, line: item.line });
      toInsert.push(item);
    } else if (existing.back.trim() === item.back.trim()) {
      bucket.duplicates.push({ front: item.front, back: item.back, line: item.line });
    } else {
      bucket.updated.push({
        front: item.front,
        back: item.back,
        line: item.line,
        previous_back: existing.back,
      });
      toUpdate.push({ id: existing.id, back: item.back });
    }
  }

  const response: FlashcardImportResponse = { errors, decks: decksResult, decks_to_create: decksToCreate };

  if (dryRun) {
    return c.json(response);
  }

  const now = new Date();
  for (const item of toInsert) {
    await db.insert(flashcards).values({
      id: genId('fc'),
      pair_id: pairId,
      concept_id: null,
      deck_id: item.deck,
      front: item.front,
      back: item.back,
      tags: [],
      source_refs: [],
      fsrs_state: newCardState(now),
      paused: false,
      created_at: now,
      updated_at: now,
    });
  }
  // Update leg only ever touches `back` (+ updated_at) — scheduling/FSRS
  // fields are never rewritten by an import, per spec ("不动任何调度状态字段").
  for (const u of toUpdate) {
    await db.update(flashcards).set({ back: u.back, updated_at: now }).where(eq(flashcards.id, u.id));
  }

  return c.json(response, 201);
});

const ALLOWED_SESSION_EVENT_TYPES = new Set([
  'lesson.viewed',
  'concept.touched',
  'trial.attempted',
  // Recents 最近接触 (2026-07-30) — 阅读文档/查看导图的已读信号, 与
  // lesson.viewed 同轨同权限, payload 只带 document_id / mindmap_id。
  'document.viewed',
  'mindmap.viewed',
  // 二期 (同日): 复习页的"最近在复习哪一组卡"信号, payload 只带 deck_id
  // (+ 可选 course_id)。与评卡事件 review.rated 分工不同 —— 那枚走 /reviews,
  // 带 rating 与用时; 这枚不带任何评分深度, 只服务 Recents 的最近性。
  'review.viewed',
]);

w.post('/sessions/events', async (c) => {
  const input = await c.req.json<{
    pair_id: string;
    event_type:
      | 'lesson.viewed'
      | 'concept.touched'
      | 'trial.attempted'
      | 'document.viewed'
      | 'mindmap.viewed'
      | 'review.viewed';
    payload: Record<string, unknown>;
    mode?: 'self_study' | 'live_teaching' | 'review' | 'quiz' | 'exercise';
  }>();
  if (!ALLOWED_SESSION_EVENT_TYPES.has(input.event_type)) {
    return c.json({ error: 'event_type_not_allowed' }, 400);
  }
  const sessionId = await appendSessionEvent({
    pair_id: input.pair_id,
    event_type: input.event_type,
    actor_type: 'learner',
    mode: input.mode ?? 'self_study',
    payload: input.payload,
  });
  return c.json({ session_id: sessionId }, 201);
});

// ============================================================================
// exercise submissions (4-state machine)
// ============================================================================

w.post('/submissions', async (c) => {
  const input = await c.req.json<
    Omit<ExerciseSubmission, 'id' | 'submitted_at' | 'status'> & {
      // Learner Model 批1 (LEARNER-MODEL-BRIEF §3/§9) — 可选, 可跳过, ExerciseSubmission
      // (packages/contracts) 还没有这两个字段, 就地扩了这里的输入类型 (server-local).
      confidence?: ConfidenceLevel;
      confidence_pct?: number;
      // 断链修复 (迁移 0044): 可选——本次提交引用的 Live 回答
      // (teaching_responses.id)。填了就必须真实且属本 pair (下方校验)。
      live_response_id?: string;
    }
  >();
  // sweep — learner_id reaches pairIdForLearner's eq() (the lethal
  // postgres-js UNDEFINED_VALUE position, see lib/tool-args.ts);
  // exercise_id/learner_answer are NOT NULL values-only (undefined → SQL
  // DEFAULT → clear violation), validated for a 400 instead of a 500.
  if (typeof input.learner_id !== 'string' || input.learner_id.trim() === '') {
    return c.json({ error: 'learner_id_required' }, 400);
  }
  if (typeof input.exercise_id !== 'string' || input.exercise_id.trim() === '') {
    return c.json({ error: 'exercise_id_required' }, 400);
  }
  if (typeof input.learner_answer !== 'string') {
    return c.json({ error: 'learner_answer_required' }, 400);
  }

  const now = new Date();
  const id = genId('sub');
  const pairId = await pairIdForLearner(input.learner_id);

  // Gate BEFORE the write, not after — 批0/批1 军规: mode off or the
  // metacognition category forbidden both mean "don't persist", never
  // "persist then redact".
  //
  // confidence_pct 双轨存储 (Confidence 主权立法): confidence 是事实层(她按
  // 的哪个按钮, 不可变); confidence_pct 是建模层, 用这个 pair *当刻*的锚值
  // (lib/confidence-anchors.ts) 折算——从不信任客户端传来的 input.confidence_pct
  // (前端算的那份可能是缓存的旧锚值, 服务端才是这个 pair 映射配置的真相源)。
  let confidence: ConfidenceLevel | null = null;
  let confidencePct: number | null = null;
  if (pairId && input.confidence !== undefined && (await isConfidenceCaptureAllowed(pairId))) {
    if (isConfidenceLevel(input.confidence)) {
      confidence = input.confidence;
      confidencePct = await resolveConfidencePct(pairId, input.confidence);
    }
  }

  // 断链修复: live_response_id 填了就必须指向本 pair 的真实 Live 回答
  // (teaching_responses ⋈ live_sessions.pair_id, lib/evidence-refs.ts)。
  // 幽灵引用 400 拒——证据先于叙事, 引用不许凭记忆拼。
  let liveResponseId: string | null = null;
  if (input.live_response_id !== undefined) {
    if (typeof input.live_response_id !== 'string' || input.live_response_id.trim() === '') {
      return c.json({ error: 'live_response_id_invalid', message: 'live_response_id must be a non-empty string.' }, 400);
    }
    if (!pairId) {
      return c.json(
        { error: 'live_response_id_invalid', message: 'This learner has no active pair, so live_response_id ownership cannot be verified.' },
        400
      );
    }
    const refCheck = await checkLiveResponseRef(pairId, input.live_response_id.trim());
    if (!refCheck.ok) {
      return c.json(
        {
          error: 'live_response_id_invalid',
          message: `live_response_id "${input.live_response_id}" does not exist or does not belong to the current pair — use a real Live response id (tr_ prefix); if unsure, leave it out.`,
        },
        400
      );
    }
    liveResponseId = input.live_response_id.trim();
  }

  // Agent Surface Hardening 第一批 ("同病同治") — insert
  // + event append used to be two unguarded statements; both now commit
  // atomically (the simulator kick-off below stays outside — it's a
  // fire-and-forget background task, not part of the write's own atomicity).
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .insert(exercise_submissions)
      .values({
        id,
        exercise_id: input.exercise_id,
        learner_id: input.learner_id,
        learner_answer: input.learner_answer,
        status: 'submitted',
        submitted_at: now,
        confidence,
        confidence_pct: confidencePct,
        live_response_id: liveResponseId,
      })
      .returning();
    if (pairId) {
      await appendSessionEvent(
        {
          pair_id: pairId,
          event_type: 'exercise.submitted',
          actor_type: 'learner',
          mode: 'exercise',
          payload: { submission_id: id, exercise_id: input.exercise_id },
        },
        tx
      );
    }
    return r;
  });
  // Demo mode only — real grading comes from the agent (grade_exercise)
  if (SIMULATE) void simulateGrading(id, input.learner_answer);
  return c.json(row, 201);
});

// §3 反刍窗口 — submit 是逗号不是句号: 提交后、批改前
// 答案永远可改; 批改落笔 (agent_feedback/agent_score/graded_at 任一落笔, 即
// status flips to 'graded') 即冻结成史。改判过的答案也是留痕 — 冻结后想改走
// resubmit (新开一版) 或留言, 不改原卷 (镜像 already_graded 409 的既有惯例,
// 见下面 /withdraw 路由)。
w.patch('/submissions/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ learner_answer?: string }>();
  if (typeof body.learner_answer !== 'string' || body.learner_answer.trim() === '') {
    return c.json({ error: 'learner_answer_required' }, 400);
  }
  const [cur] = await db.select().from(exercise_submissions).where(eq(exercise_submissions.id, id)).limit(1);
  if (!cur) return c.json({ error: 'not_found' }, 404);
  if (cur.status === 'graded' || cur.graded_at !== null) {
    return c.json(
      {
        error: 'already_graded',
        message: 'Grading is locked in — open a new submission (resubmit) or leave a note; the original submission is not editable.',
      },
      409
    );
  }
  const [row] = await db
    .update(exercise_submissions)
    .set({ learner_answer: body.learner_answer })
    .where(eq(exercise_submissions.id, id))
    .returning();
  return c.json(row);
});

w.post('/submissions/:id/withdraw', async (c) => {
  const id = c.req.param('id');
  const [cur] = await db.select().from(exercise_submissions).where(eq(exercise_submissions.id, id)).limit(1);
  if (!cur) return c.json({ error: 'not_found' }, 404);
  if (cur.status === 'graded') return c.json({ error: 'already_graded' }, 409);
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .update(exercise_submissions)
      .set({ status: 'draft', withdrew_at: new Date() })
      .where(eq(exercise_submissions.id, id))
      .returning();
    const pairId = r ? await pairIdForLearner(r.learner_id) : null;
    if (pairId && r) {
      await appendSessionEvent(
        {
          pair_id: pairId,
          event_type: 'exercise.withdrawn',
          actor_type: 'learner',
          mode: 'exercise',
          payload: { submission_id: r.id, exercise_id: r.exercise_id },
        },
        tx
      );
    }
    return r;
  });
  return c.json(row);
});

w.post('/submissions/:id/resubmit', async (c) => {
  const id = c.req.param('id');
  const { new_answer } = await c.req.json<{ new_answer: string }>();
  const [prev] = await db.select().from(exercise_submissions).where(eq(exercise_submissions.id, id)).limit(1);
  if (!prev) return c.json({ error: 'not_found' }, 404);
  const newId = genId('sub');
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .insert(exercise_submissions)
      .values({
        id: newId,
        exercise_id: prev.exercise_id,
        learner_id: prev.learner_id,
        learner_answer: new_answer,
        status: 'submitted',
        submitted_at: new Date(),
        previous_submission_id: id,
      })
      .returning();
    const pairId = r ? await pairIdForLearner(r.learner_id) : null;
    if (pairId && r) {
      await appendSessionEvent(
        {
          pair_id: pairId,
          event_type: 'exercise.resubmitted',
          actor_type: 'learner',
          mode: 'exercise',
          payload: {
            submission_id: r.id,
            exercise_id: r.exercise_id,
            previous_submission_id: id,
          },
        },
        tx
      );
    }
    return r;
  });
  if (SIMULATE) void simulateGrading(newId, new_answer);
  return c.json(row, 201);
});

w.post('/submissions/:id/grade', async (c) => {
  const id = c.req.param('id');
  const { feedback, score } = await c.req.json<{ feedback: string; score?: number }>();
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .update(exercise_submissions)
      .set({
        status: 'graded',
        agent_feedback: feedback,
        agent_score: score,
        graded_at: new Date(),
      })
      .where(eq(exercise_submissions.id, id))
      .returning();
    const pairId = r ? await pairIdForLearner(r.learner_id) : null;
    if (pairId && r) {
      await appendSessionEvent(
        {
          pair_id: pairId,
          event_type: 'exercise.graded',
          actor_type: 'agent',
          mode: 'exercise',
          payload: {
            submission_id: r.id,
            exercise_id: r.exercise_id,
            score: score ?? null,
          },
        },
        tx
      );
    }
    return r;
  });
  return c.json(row);
});

// ============================================================================
// lesson progress — 完成状态机 (§6):
//   not_started → in_progress → completed_declared → closed
// "已学完" 只能由这条学习者宣布接口写 (declared_at + checklist_snapshot,
// 核对单现算, 允许带缺口宣布)。"已回课"(closed) 是老师批改+回执送达触发的
// 教学闭环终态, 只能由 MCP close_lesson_loop 写 (mcp/server.ts) — 不可逆,
// 这条路由发现已 closed 时拒绝重新宣布。GET 批量查询在 routes/read.ts。
//
// 迁移 0037 (学习者裁决第三针, 2026-07-20) — pages_read 的计算源头换了: 此前
// declare-completed 直接信任客户端在宣布那一刻带来的"当前页"数字, 病根就是
// "当前页"≠"到过的页"——学完全部翻回第 4 页复习再声明, 会把 4 当成"读到第
// 几页"。现在 pages_read 改算 lesson_progress.pages_visited 足迹集合(POST
// /lessons/:id/progress/touch 每次翻页并入一页) ∪ 本次声明附带的当前页 的
// 并集大小——回看是美德不是倒退, 进度记足迹, 不记立足点。
// ============================================================================

async function computeChecklistSnapshot(
  lessonId: string,
  learnerId: string | null,
  pagesInput: { pages_total: number | null; pages_read: number | null },
  extraGaps: string[]
): Promise<LessonChecklistSnapshot> {
  const exRows = await db.select({ id: exercises.id }).from(exercises).where(eq(exercises.lesson_id, lessonId));
  const exercisesTotal = exRows.length;
  let exercisesSubmitted = 0;
  if (exercisesTotal > 0 && learnerId) {
    const exIds = exRows.map((r) => r.id);
    const subs = await db
      .select({ exercise_id: exercise_submissions.exercise_id })
      .from(exercise_submissions)
      .where(
        and(eq(exercise_submissions.learner_id, learnerId), inArray(exercise_submissions.exercise_id, exIds))
      );
    exercisesSubmitted = new Set(subs.map((s) => s.exercise_id)).size;
  }

  const gaps = [...extraGaps];
  if (exercisesSubmitted < exercisesTotal) {
    gaps.push(
      `${exercisesSubmitted}/${exercisesTotal} exercise(s) submitted — ${exercisesTotal - exercisesSubmitted} still not submitted`
    );
  }
  if (pagesInput.pages_total !== null && pagesInput.pages_read !== null && pagesInput.pages_read < pagesInput.pages_total) {
    gaps.push(`${pagesInput.pages_read}/${pagesInput.pages_total} page(s) read`);
  }

  return {
    pages_total: pagesInput.pages_total,
    pages_read: pagesInput.pages_read,
    exercises_total: exercisesTotal,
    exercises_submitted: exercisesSubmitted,
    gaps,
  };
}

w.post('/pairs/:pairId/lessons/:lessonId/declare-completed', async (c) => {
  const pairId = c.req.param('pairId');
  const lessonId = c.req.param('lessonId');
  const body = await c
    .req
    .json<{ pages_total?: number | null; current_page_index?: number | null; gaps?: string[] }>()
    .catch(() => ({}) as { pages_total?: number | null; current_page_index?: number | null; gaps?: string[] });

  const [pair] = await db.select().from(learner_agent_pairs).where(eq(learner_agent_pairs.id, pairId)).limit(1);
  if (!pair) return c.json({ error: 'pair_not_found' }, 404);
  const [lesson] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  if (!lesson) return c.json({ error: 'lesson_not_found' }, 404);

  const [existing] = await db
    .select()
    .from(lesson_progress)
    .where(and(eq(lesson_progress.pair_id, pairId), eq(lesson_progress.lesson_id, lessonId)))
    .limit(1);

  // §6: 已回课 (closed) 是教学闭环终态, 不可逆 — 拒绝在其上重新宣布已学完.
  if (existing?.state === 'closed') {
    return c.json(
      {
        error: 'already_closed',
        message: 'This lesson is already closed — closed is the terminal state of the teaching loop; it cannot be re-declared as completed.',
      },
      409
    );
  }

  // 足迹只增不减 (迁移 0037): 页数不再信任客户端"当前页"这个瞬时数字, 改算
  // 已持久化的 pages_visited 足迹集合 ∪ 本次声明附带的当前页(current_page_index,
  // 0-based, 兜底一次没赶上 touch() 的情况——即便那次网络请求丢包, 声明这一刻
  // 自带的页码也会并进集合, 不漏记)。
  const currentPageIndex =
    typeof body.current_page_index === 'number' && Number.isInteger(body.current_page_index) && body.current_page_index >= 0
      ? body.current_page_index
      : undefined;
  const existingPagesVisited = existing?.pages_visited ?? [];
  const mergedPagesVisited =
    currentPageIndex !== undefined && !existingPagesVisited.includes(currentPageIndex)
      ? [...existingPagesVisited, currentPageIndex]
      : existingPagesVisited;

  const snapshot = await computeChecklistSnapshot(
    lessonId,
    pair.learner_id,
    {
      pages_total: body.pages_total ?? null,
      pages_read: mergedPagesVisited.length > 0 ? mergedPagesVisited.length : null,
    },
    Array.isArray(body.gaps) ? body.gaps.filter((g): g is string => typeof g === 'string') : []
  );

  const now = new Date();

  if (existing) {
    const [row] = await db
      .update(lesson_progress)
      .set({
        state: 'completed_declared',
        declared_at: now,
        checklist_snapshot: snapshot,
        pages_visited: mergedPagesVisited,
        updated_at: now,
      })
      .where(eq(lesson_progress.id, existing.id))
      .returning();
    return c.json(row, 200);
  }

  // (2026-07-22，与下面同一病根): 上面这次 SELECT 到这里的 INSERT
  // 之间不是原子的——一次并发的 touch 抢先建了行 (state='in_progress')，或者
  // 另一次并发的 declare-completed 抢先声明并建了行，后到的这次撞
  // lesson_progress_pair_lesson_uniq 唯一键，500。改成真正的 upsert，惯用法
  // 同上面 POST /lessons/:id/progress/touch 的修复：插入照常插入这次声
  // 明的值；一旦撞车，在 SQL 层对目标表的现有行做合并——
  //   state:      §6 只进不退。撞车那一行若还停在 not_started/in_progress
  //               (被并发 touch 抢建, 还没人声明过), 才真正推进到
  //               completed_declared；若已经是 completed_declared (被并发
  //               declare 抢先声明) 或 closed (终态不可逆), 原样保留不动——
  //               "已声明过/已终态"是同一件事: 别覆盖已经写死的记录。这也是
  //               already_closed 409 之外唯一可能撞见 closed 的窗口 (预检查
  //               只看得到 SELECT 那一刻), 这道 CASE 顺手把它也挡住。
  //   declared_at / checklist_snapshot:
  //               "第一次宣布"说了算。撞车行若还在 not_started/in_progress
  //               (还没被声明过), 写这次新算的 declared_at/snapshot——跟没
  //               撞车时的正常声明等价。撞车行若已经 completed_declared/
  //               closed (已经被声明过), 保留那一次落下的值不覆盖, 双重声明
  //               对 declared_at/snapshot 幂等。
  //   pages_visited: 沿用同一条 jsonb 包含判断 (@>) 规则——只增不减, 合
  //               并到现有行的足迹集合, 不吞掉并发写入的其它页码。
  //   updated_at: 只在真的发生了推进/合并时刷新, 否则原样保留 (跟"已有行"
  //               分支里 UPDATE 必然刷新是同一件事的两种落笔时机)。
  const insertedId = genId('lprog');
  const conflictPagesVisited =
    currentPageIndex !== undefined
      ? sql`CASE WHEN ${lesson_progress.pages_visited} @> ${JSON.stringify([currentPageIndex])}::jsonb
              THEN ${lesson_progress.pages_visited}
              ELSE ${lesson_progress.pages_visited} || ${JSON.stringify([currentPageIndex])}::jsonb
            END`
      : sql`${lesson_progress.pages_visited}`;
  const conflictUpdatedAt =
    currentPageIndex !== undefined
      ? sql`CASE WHEN ${lesson_progress.state} = 'not_started' OR ${lesson_progress.state} = 'in_progress'
                  OR NOT (${lesson_progress.pages_visited} @> ${JSON.stringify([currentPageIndex])}::jsonb)
                THEN now() ELSE ${lesson_progress.updated_at} END`
      : sql`CASE WHEN ${lesson_progress.state} = 'not_started' OR ${lesson_progress.state} = 'in_progress'
                THEN now() ELSE ${lesson_progress.updated_at} END`;

  const [row] = await db
    .insert(lesson_progress)
    .values({
      id: insertedId,
      pair_id: pairId,
      lesson_id: lessonId,
      state: 'completed_declared',
      declared_at: now,
      checklist_snapshot: snapshot,
      pages_visited: mergedPagesVisited,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [lesson_progress.pair_id, lesson_progress.lesson_id],
      set: {
        state: sql`CASE WHEN ${lesson_progress.state} = 'not_started' OR ${lesson_progress.state} = 'in_progress'
                    THEN 'completed_declared' ELSE ${lesson_progress.state} END`,
        declared_at: sql`CASE WHEN ${lesson_progress.state} = 'not_started' OR ${lesson_progress.state} = 'in_progress'
                    THEN ${now.toISOString()}::timestamptz ELSE ${lesson_progress.declared_at} END`,
        checklist_snapshot: sql`CASE WHEN ${lesson_progress.state} = 'not_started' OR ${lesson_progress.state} = 'in_progress'
                    THEN ${JSON.stringify(snapshot)}::jsonb ELSE ${lesson_progress.checklist_snapshot} END`,
        pages_visited: conflictPagesVisited,
        updated_at: conflictUpdatedAt,
      },
    })
    .returning();

  if (!row) return c.json({ error: 'insert_failed' }, 500);
  // 真插入成功: row.id 是自己生成的 insertedId, 201 (跟没撞车时一样是"新建")。
  // 撞车走了合并分支: id 是先到那次请求 (touch 或另一次 declare) 生成的, 不
  // 等于这次自己生成的, 说明行早就在了, 200——同 touch 端点修复同一条
  // 201-creator / 200-merger 判定惯用法。
  return c.json(row, row.id === insertedId ? 201 : 200);
});

// ============================================================================
// State 2.0 四轴 (lib/lesson-state.ts) 落笔的两条写路由 —— 命名契约由总设计师
// 钦定, MCP 纵队 / 网页纵队按同一契约并行施工。
// ============================================================================

/** W1: 单租户自托管 — "当前 pair" 取 active=true 的那一行, 与 read.ts 的
 *  `GET /pair/current` / mcp/server.ts 的 getCurrentPairId 同一惯例, 各处
 *  没有共享成一个 lib 函数(三处实现都只是一次 `WHERE active = true LIMIT 1`,
 *  抽出来意义不大, 也不在这批施工领地内)。 */
async function getActivePairId(): Promise<string | null> {
  // 与其余隐式解析点同一口径 — 真 pair 优先于样板间 (is_demo ASC),
  // 同身份内资历优先 (established_at ASC)。此处原先连 ORDER BY
  // 都没有 (漏网的第五处解析点), 本批一并对齐。
  const [row] = await db
    .select({ id: learner_agent_pairs.id })
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.active, true))
    .orderBy(asc(learner_agent_pairs.is_demo), asc(learner_agent_pairs.established_at))
    .limit(1);
  return row?.id ?? null;
}

// 学习态状态机的先后次序 (§6: not_started → in_progress → completed_declared
// → closed) —— touch 只负责把 not_started 推到 in_progress, 已经在更高态的
// (含 in_progress 本身) 一律原样返回不动, 幂等。
const LESSON_PROGRESS_RANK: Record<LessonProgressState, number> = {
  not_started: 0,
  in_progress: 1,
  completed_declared: 2,
  closed: 3,
};

// 迁移 0037 (学习者裁决第三针) — page_index 可选: 学习者翻到一页, PagedLesson
// 静默带着这页的 0-based 索引 touch 一次, 服务端把它并入 pages_visited 集合
// (去重, 只增不减)。回看是美德不是倒退——进度记足迹, 不记立足点: 集合并入
// 不看 state 处在哪一档, 已经 completed_declared/closed 之后继续翻页复习照样
// 记(不追溯改写已经写死的 checklist_snapshot, 只是让下一次——如果还有下一次
// ——的足迹更完整)。
w.post('/lessons/:id/progress/touch', async (c) => {
  const lessonId = c.req.param('id');
  const body = await c.req.json<{ page_index?: number }>().catch(() => ({}) as { page_index?: number });
  const pageIndex =
    typeof body.page_index === 'number' && Number.isInteger(body.page_index) && body.page_index >= 0
      ? body.page_index
      : undefined;

  const [lesson] = await db.select({ id: lessons.id }).from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  if (!lesson) return c.json({ error: 'lesson_not_found' }, 404);

  const pairId = await getActivePairId();
  if (!pairId) return c.json({ error: 'pair_not_found' }, 404);

  const [existing] = await db
    .select()
    .from(lesson_progress)
    .where(and(eq(lesson_progress.pair_id, pairId), eq(lesson_progress.lesson_id, lessonId)))
    .limit(1);

  // 无行 = not_started, 直接建行 state='in_progress' — 幂等推进. page_index
  // 若带了, 顺手种下这节课的第一枚足迹。
  //
  // (2026-07-22): 上面这次 SELECT 到这里的 INSERT 之间不是原子的
  // ——两次翻页请求前后脚都查到"无行", 都往下插, 后到的那个撞
  // lesson_progress_pair_lesson_uniq 唯一键, 500。改成真正的 upsert (惯用法
  // 同下面 POST /lessons/:id/revision-seen 的 onConflictDoUpdate): 插入照常
  // 插入自己这套"新建行"的值; 一旦撞车, 在 SQL 层对目标表的当前行做合并 ——
  // pages_visited 用 jsonb 包含判断 (@>) 决定要不要 append 这一页, 和下面
  // "已有行"分支里的并集逻辑同一条规则; state 只在仍是 not_started 时推进到
  // in_progress (幂等, 不倒退); updated_at 只在真的发生合并/推进时刷新, 否
  // 则原样保留——跟"已有行"分支 !pagesVisitedChanged 时提前 return 不落笔是
  // 同一件事的两种写法(那边是不发 UPDATE, 这边撞车必然有一次 UPDATE, 但落地
  // 的值等价)。
  if (!existing) {
    const now = new Date();
    const insertedId = genId('lprog');
    const conflictPagesVisited =
      pageIndex !== undefined
        ? sql`CASE WHEN ${lesson_progress.pages_visited} @> ${JSON.stringify([pageIndex])}::jsonb
                THEN ${lesson_progress.pages_visited}
                ELSE ${lesson_progress.pages_visited} || ${JSON.stringify([pageIndex])}::jsonb
              END`
        : sql`${lesson_progress.pages_visited}`;
    const conflictUpdatedAt =
      pageIndex !== undefined
        ? sql`CASE WHEN ${lesson_progress.state} = 'not_started'
                    OR NOT (${lesson_progress.pages_visited} @> ${JSON.stringify([pageIndex])}::jsonb)
                  THEN now() ELSE ${lesson_progress.updated_at} END`
        : sql`CASE WHEN ${lesson_progress.state} = 'not_started' THEN now() ELSE ${lesson_progress.updated_at} END`;

    const [row] = await db
      .insert(lesson_progress)
      .values({
        id: insertedId,
        pair_id: pairId,
        lesson_id: lessonId,
        state: 'in_progress',
        pages_visited: pageIndex !== undefined ? [pageIndex] : [],
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [lesson_progress.pair_id, lesson_progress.lesson_id],
        set: {
          pages_visited: conflictPagesVisited,
          state: sql`CASE WHEN ${lesson_progress.state} = 'not_started' THEN 'in_progress' ELSE ${lesson_progress.state} END`,
          updated_at: conflictUpdatedAt,
        },
      })
      .returning();
    if (!row) return c.json({ error: 'insert_failed' }, 500);
    // 真插入成功: row.id 是自己生成的 insertedId, 201。撞车走了合并分支: id
    // 是先到那次请求生成的, 不等于这次自己生成的, 说明行早就在了, 200。
    return c.json(row, row.id === insertedId ? 201 : 200);
  }

  const mergedPagesVisited =
    pageIndex !== undefined && !existing.pages_visited.includes(pageIndex)
      ? [...existing.pages_visited, pageIndex]
      : existing.pages_visited;
  const pagesVisitedChanged = mergedPagesVisited !== existing.pages_visited;

  // 已在 in_progress 或更高态 — state 原样返回不动 (touch 对 state 只单向
  // 前进, 从不倒退), 但 pages_visited 的并入不受这道闸限制。
  if (LESSON_PROGRESS_RANK[existing.state] >= LESSON_PROGRESS_RANK.in_progress) {
    if (!pagesVisitedChanged) return c.json(existing, 200);
    const [row] = await db
      .update(lesson_progress)
      .set({ pages_visited: mergedPagesVisited, updated_at: new Date() })
      .where(eq(lesson_progress.id, existing.id))
      .returning();
    return c.json(row, 200);
  }

  const [row] = await db
    .update(lesson_progress)
    .set({ state: 'in_progress', pages_visited: mergedPagesVisited, updated_at: new Date() })
    .where(eq(lesson_progress.id, existing.id))
    .returning();
  return c.json(row, 200);
});

w.post('/lessons/:id/revision-seen', async (c) => {
  const lessonId = c.req.param('id');
  const [lesson] = await db
    .select({ id: lessons.id, revision: lessons.revision })
    .from(lessons)
    .where(eq(lessons.id, lessonId))
    .limit(1);
  if (!lesson) return c.json({ error: 'lesson_not_found' }, 404);

  const pairId = await getActivePairId();
  if (!pairId) return c.json({ error: 'pair_not_found' }, 404);

  const now = new Date();
  // upsert (pair_id, lesson_id) — 幂等: 重复调用只是把 revision/seen_at
  // 刷新到"当下的 lessons.revision / 当下这一刻", 不留旧回执行.
  const [row] = await db
    .insert(lesson_revision_seen)
    .values({
      id: genId('lrseen'),
      pair_id: pairId,
      lesson_id: lessonId,
      revision: lesson.revision,
      seen_at: now,
    })
    .onConflictDoUpdate({
      target: [lesson_revision_seen.pair_id, lesson_revision_seen.lesson_id],
      set: { revision: lesson.revision, seen_at: now },
    })
    .returning();
  return c.json(row, 200);
});

// ============================================================================
// mindmap
// ============================================================================

w.post('/mindmaps', async (c) => {
  const input = await c.req.json<
    Omit<Mindmap, 'id' | 'created_at' | 'updated_at' | 'has_been_reset' | 'agent_seed_snapshot'> & {
      agent_seed_snapshot?: MindmapContent;
    }
  >();
  const now = new Date();
  const seed = input.agent_seed_snapshot ?? input.content;
  const id = genId('mm');
  const [row] = await db
    .insert(mindmaps)
    .values({
      ...input,
      id,
      agent_seed_snapshot: JSON.parse(JSON.stringify(seed)),
      has_been_reset: false,
      created_at: now,
      updated_at: now,
    })
    .returning();
  return c.json(row, 201);
});

w.patch('/mindmaps/:id/content', async (c) => {
  const id = c.req.param('id');
  const { content } = await c.req.json<{ content: MindmapContent }>();
  const [row] = await db
    .update(mindmaps)
    .set({ content, updated_at: new Date() })
    .where(eq(mindmaps.id, id))
    .returning();
  return c.json(row);
});

w.patch('/mindmaps/:id/title', async (c) => {
  const id = c.req.param('id');
  const { title } = await c.req.json<{ title: string }>();
  const [row] = await db
    .update(mindmaps)
    .set({ title, updated_at: new Date() })
    .where(eq(mindmaps.id, id))
    .returning();
  return c.json(row);
});

w.post('/mindmaps/:id/reset', async (c) => {
  const id = c.req.param('id');
  const [row] = await db
    .update(mindmaps)
    .set({
      content: { nodes: [], links: [] },
      has_been_reset: true,
      updated_at: new Date(),
    })
    .where(eq(mindmaps.id, id))
    .returning();
  return c.json(row);
});

w.post('/mindmaps/:id/restore', async (c) => {
  const id = c.req.param('id');
  const [cur] = await db.select().from(mindmaps).where(eq(mindmaps.id, id)).limit(1);
  if (!cur) return c.json({ error: 'not_found' }, 404);
  const [row] = await db
    .update(mindmaps)
    .set({
      content: JSON.parse(JSON.stringify(cur.agent_seed_snapshot)),
      has_been_reset: false,
      updated_at: new Date(),
    })
    .where(eq(mindmaps.id, id))
    .returning();
  return c.json(row);
});

w.post('/mindmaps/:id/associations', async (c) => {
  const id = c.req.param('id');
  const { target_type, target_id } = await c.req.json<{
    target_type: MindmapAssociation['target_type'];
    target_id: string;
  }>();
  const [row] = await db
    .insert(mindmap_associations)
    .values({
      id: genId('mma'),
      mindmap_id: id,
      target_type,
      target_id,
      created_at: new Date(),
    })
    .returning();
  return c.json(row, 201);
});

w.delete('/mindmap-associations/:id', async (c) => {
  const id = c.req.param('id');
  await db.delete(mindmap_associations).where(eq(mindmap_associations.id, id));
  return c.body(null, 204);
});

// ============================================================================
// pending card → manual toss into pool (Cards page "To pool")
//
// Route existed only for GET (read.ts) + place/delete below; the create leg
// (HttpRepository.addPendingCard → POST /pairs/:pairId/pending-cards) had no
// backing route yet. Mirrors the field set 1:1 off PendingMindmapCard —
// there's no separate tag/headline pair on this entity, just
// title/content/source_type/source_id/source_title/reason.
// ============================================================================

w.post('/pairs/:pairId/pending-cards', async (c) => {
  const pairId = c.req.param('pairId');
  const input = await c.req.json<{
    title: string;
    content: string;
    source_type: PendingCardSourceType;
    source_id?: string;
    source_title?: string;
    reason?: string;
  }>();
  const now = new Date();
  const id = genId('pcard');
  const [row] = await db
    .insert(pending_mindmap_cards)
    .values({
      id,
      owner_pair_id: pairId,
      title: input.title,
      content: input.content,
      source_type: input.source_type,
      source_id: input.source_id ?? null,
      source_title: input.source_title ?? null,
      reason: input.reason ?? null,
      created_at: now,
    })
    .returning();
  return c.json(row, 201);
});

// ============================================================================
// pending card → place into mindmap as 'note' node
// ============================================================================

w.post('/pending-cards/:id/place', async (c) => {
  const id = c.req.param('id');
  const { mindmap_id, pos } = await c.req.json<{
    mindmap_id: string;
    pos: { x: number; y: number };
  }>();

  // sweep — mindmap_id reaches the select's eq() below (lethal
  // postgres-js UNDEFINED_VALUE position, see lib/tool-args.ts); pos is
  // dereferenced (pos.x/pos.y) — undefined would TypeError into a 500.
  if (typeof mindmap_id !== 'string' || mindmap_id.trim() === '') {
    return c.json({ error: 'mindmap_id_required' }, 400);
  }
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
    return c.json({ error: 'pos_required' }, 400);
  }

  const [card] = await db.select().from(pending_mindmap_cards).where(eq(pending_mindmap_cards.id, id)).limit(1);
  if (!card) return c.json({ error: 'not_found' }, 404);
  const [mm] = await db.select().from(mindmaps).where(eq(mindmaps.id, mindmap_id)).limit(1);
  if (!mm) return c.json({ error: 'mindmap_not_found' }, 404);

  const node: MindmapNode = {
    id: genId('n'),
    title: card.title,
    content: card.content,
    level: 'note',
    source_type: card.source_type === 'agent_seed' ? 'custom' : (card.source_type as MindmapNode['source_type']),
    source_id: card.source_id ?? undefined,
    source_title: card.source_title ?? undefined,
    pos_x: pos.x,
    pos_y: pos.y,
    is_expanded: false,
    sort_order: mm.content.nodes.length,
  };

  const newContent: MindmapContent = {
    nodes: [...mm.content.nodes, node],
    links: mm.content.links,
  };

  // Agent Surface Hardening 第一批 ("同病同治") — the
  // mindmap content update + the pending-card's placed_in_mindmap_id update
  // used to be two unguarded statements; a crash between them left the node
  // written into the mindmap but the source card still showing as "pending"
  // (available for another place-call to double-add it). Both now commit
  // atomically.
  await db.transaction(async (tx) => {
    await tx
      .update(mindmaps)
      .set({ content: newContent, updated_at: new Date() })
      .where(eq(mindmaps.id, mindmap_id));

    await tx
      .update(pending_mindmap_cards)
      .set({ placed_in_mindmap_id: mindmap_id })
      .where(eq(pending_mindmap_cards.id, id));
  });

  return c.json(node, 201);
});

w.delete('/pending-cards/:id', async (c) => {
  const id = c.req.param('id');
  await db.delete(pending_mindmap_cards).where(eq(pending_mindmap_cards.id, id));
  return c.body(null, 204);
});

// ============================================================================
// quiz attempts
// ============================================================================

w.post('/quiz-attempts', async (c) => {
  const input = await c.req.json<Omit<QuizAttempt, 'id' | 'started_at' | 'finished_at' | 'score'>>();
  // sweep — answers is dereferenced immediately (.filter); a missing
  // array would TypeError into a 500. 400 with the field named instead.
  if (!Array.isArray(input.answers)) {
    return c.json({ error: 'answers_required' }, 400);
  }
  const correctCount = input.answers.filter((a) => a.correct).length;
  const score = input.answers.length > 0 ? correctCount / input.answers.length : 0;
  const [row] = await db
    .insert(quiz_attempts)
    .values({
      ...input,
      id: genId('qa'),
      started_at: new Date(),
      score,
    })
    .returning();
  return c.json(row, 201);
});

w.post('/quiz-attempts/:id/finish', async (c) => {
  const id = c.req.param('id');
  const [row] = await db
    .update(quiz_attempts)
    .set({ finished_at: new Date() })
    .where(eq(quiz_attempts.id, id))
    .returning();
  return c.json(row);
});

// ============================================================================
// SimulatedQuiz (agent 出题) — round 3 (2026-07-07 Quiz 通电).
//
// Distinct from quiz_attempts above: single/multi choice auto-判分 happens
// server-side here (client posts raw {question_id, answer} only, no
// pre-computed `correct` — unlike the real-quiz path where the client
// self-grades against the fetched answer key before posting). Open-ended
// questions (short_answer / essay, or question_type omitted — round 2
// compat default) stay ungraded: `correct` is left off the answer and
// doesn't count toward `score`'s denominator.
// ============================================================================

// multi_choice packs a set of choices into SimulatedQuestion.reference_answer
// (a single string, per contract) as a comma-separated list — same encoding
// on the learner's submitted answer. No contract change needed for this;
// it's a convention, not a type.
function gradeSimulatedAnswer(q: SimulatedQuestion, answer: string): boolean | undefined {
  const qType = q.question_type ?? 'short_answer';
  if (qType === 'single_choice') {
    return answer.trim() === q.reference_answer.trim();
  }
  if (qType === 'multi_choice') {
    // ' || ' separator (not comma — choices legitimately contain commas).
    const given = new Set(
      answer
        .split('||')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    const ref = new Set(
      q.reference_answer
        .split('||')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    if (given.size === 0 || given.size !== ref.size) return false;
    for (const g of given) if (!ref.has(g)) return false;
    return true;
  }
  return undefined; // short_answer / essay — ungraded, learner self-checks vs reference_answer
}

w.post('/pairs/:pairId/simulated-quizzes', async (c) => {
  const pairId = c.req.param('pairId');
  const input = await c.req.json<{
    course_id: string;
    agent_skill_used?: string;
    questions: SimulatedQuestion[];
  }>();

  if (!input.course_id) return c.json({ error: 'course_id_required' }, 400);
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    return c.json({ error: 'questions_required' }, 400);
  }
  for (const q of input.questions) {
    if (q.question_type === 'single_choice' || q.question_type === 'multi_choice') {
      if (!q.choices || q.choices.length === 0) {
        return c.json({ error: 'choices_required', question_id: q.id }, 400);
      }
      // single_choice: exact membership, never split (choices legitimately
      // contain commas in English — the comma convention broke on the first
      // EN quiz). multi_choice: ' || ' separator convention.
      const refParts =
        q.question_type === 'single_choice'
          ? [q.reference_answer.trim()]
          : q.reference_answer
              .split('||')
              .map((s) => s.trim())
              .filter(Boolean);
      const allInChoices = refParts.length > 0 && refParts.every((part) => q.choices!.includes(part));
      if (!allInChoices) {
        return c.json({ error: 'reference_answer_not_in_choices', question_id: q.id }, 400);
      }
    }
  }

  const now = new Date();
  const questionsWithIds = input.questions.map((q) => ({ ...q, id: q.id || genId('sqq') }));
  const [row] = await db
    .insert(simulated_quizzes)
    .values({
      id: genId('sq'),
      pair_id: pairId,
      course_id: input.course_id,
      agent_skill_used: input.agent_skill_used ?? '',
      questions: questionsWithIds,
      created_at: now,
    })
    .returning();
  return c.json(row, 201);
});

w.post('/simulated-quizzes/:id/attempts', async (c) => {
  const quizId = c.req.param('id');
  const input = await c.req.json<{
    learner_id: string;
    answers: Array<{
      question_id: string;
      answer: string;
      // Learner Model 批1 (LEARNER-MODEL-BRIEF §9 考场条款) — 逐题可选, 可跳过.
      confidence?: ConfidenceLevel;
      confidence_pct?: number;
    }>;
  }>();

  const [quiz] = await db
    .select()
    .from(simulated_quizzes)
    .where(eq(simulated_quizzes.id, quizId))
    .limit(1);
  if (!quiz) return c.json({ error: 'not_found' }, 404);

  // One gate check for the whole attempt — every answer in it shares the
  // same pair (simulated_quizzes.pair_id), so this isn't per-answer state.
  // Same for the anchor lookup: one fetch of this pair's *current* anchors,
  // reused for every answer's confidence_pct — server-derived, never trusts
  // the client's a.confidence_pct (Confidence 主权立法 双轨存储, see
  // routes/write.ts's /submissions handler for the fuller rationale).
  const confidenceAllowed = await isConfidenceCaptureAllowed(quiz.pair_id);
  const anchors = confidenceAllowed ? await getConfidenceAnchors(quiz.pair_id) : null;

  const graded: SimulatedQuizAttemptAnswerWithConfidence[] = (input.answers ?? []).map((a) => {
    const q = quiz.questions.find((qq) => qq.id === a.question_id);
    const correct = q ? gradeSimulatedAnswer(q, a.answer) : undefined;
    const base: SimulatedQuizAttemptAnswerWithConfidence =
      correct === undefined
        ? { question_id: a.question_id, answer: a.answer }
        : { question_id: a.question_id, answer: a.answer, correct };
    if (anchors && isConfidenceLevel(a.confidence)) {
      base.confidence = a.confidence;
      base.confidence_pct = anchors[a.confidence];
    }
    return base;
  });
  const gradable = graded.filter((g) => g.correct !== undefined);
  const score = gradable.length > 0 ? gradable.filter((g) => g.correct).length / gradable.length : null;

  const now = new Date();
  const [row] = await db
    .insert(simulated_quiz_attempts)
    .values({
      id: genId('sqa'),
      quiz_id: quizId,
      learner_id: input.learner_id,
      started_at: now,
      finished_at: now,
      answers: graded,
      score,
    })
    .returning();
  return c.json(row, 201);
});

// ============================================================================
// SimulatedQuiz deletion (遗照工艺借自 course delete) — a
// probe/practice quiz can now be cleaned up instead of needing a SQL hand
// job (内部事故记录曾两次记下删除工具缺失的代价).
//
// db/schema/quiz.ts: simulated_quiz_attempts.quiz_id already declares
// `onDelete: 'cascade'` — confirmed by reading the schema per this task's
// instruction, so deleting the quiz row alone takes its attempts with it;
// no manual cascade delete needed here (unlike courses, which has three
// cascade-blind polymorphic tables to hand-clean).
//
// Same tombstone convention as course delete: a small graveyard file
// {quiz, attempts} lands in LS_GRAVEYARD_DIR before the delete, so a
// mistaken probe-quiz cleanup isn't silently unrecoverable — but there's no
// restore endpoint for this scope (only course-level restore was asked
// for); this is insurance, not a promised recovery path.
// ============================================================================

w.delete('/simulated-quizzes/:id', async (c) => {
  const id = c.req.param('id');
  const [quiz] = await db.select().from(simulated_quizzes).where(eq(simulated_quizzes.id, id)).limit(1);
  if (!quiz) return c.json({ error: 'not_found' }, 404);

  const attemptRows = await db
    .select()
    .from(simulated_quiz_attempts)
    .where(eq(simulated_quiz_attempts.quiz_id, id));

  const graveyardDir = process.env.LS_GRAVEYARD_DIR ?? path.join(os.homedir(), 'learn-shell-graveyard');
  await fs.mkdir(graveyardDir, { recursive: true });
  const exportedAt = new Date();
  const filename = `quiz-${id}-${exportedAt.toISOString()}.json`;
  const graveyard = {
    format_version: 1,
    exported_at: exportedAt.toISOString(),
    quiz_id: id,
    simulated_quizzes: [quiz],
    simulated_quiz_attempts: attemptRows,
  };
  await fs.writeFile(path.join(graveyardDir, filename), JSON.stringify(graveyard, null, 2), 'utf8');

  // Row delete alone is enough — see header comment (cascade confirmed).
  await db.delete(simulated_quizzes).where(eq(simulated_quizzes.id, id));

  return c.json({ quiz_id: id, attempts_deleted: attemptRows.length, graveyard_file: filename }, 200);
});

// ============================================================================
// feedback + reminders
// ============================================================================

w.post('/feedback', async (c) => {
  const input = await c.req.json<Omit<LearnerFeedback, 'id' | 'submitted_at'>>();
  const [row] = await db
    .insert(learner_feedback)
    .values({
      ...input,
      id: genId('fb'),
      submitted_at: new Date(),
      // Drizzle expects Date for timestamp; week_of from JSON is string, cast
      week_of: new Date(input.week_of),
    })
    .returning();
  return c.json(row, 201);
});

w.post('/reminders/dispatch', async (c) => {
  const input = await c.req.json<Omit<Reminder, 'id' | 'created_at' | 'fired_at'>>();
  const now = new Date();
  const [row] = await db
    .insert(reminders)
    .values({
      id: genId('rmd'),
      pair_id: input.pair_id,
      type: input.type,
      channel: input.channel,
      payload: input.payload,
      scheduled_for: new Date(input.scheduled_for),
      created_at: now,
      fired_at: now,
      dismissed_at: input.dismissed_at ? new Date(input.dismissed_at) : null,
    })
    .returning();
  return c.json(row, 201);
});

w.post('/reminders/:id/dismiss', async (c) => {
  const id = c.req.param('id');
  const [row] = await db
    .update(reminders)
    .set({ dismissed_at: new Date() })
    .where(eq(reminders.id, id))
    .returning();
  return c.json(row);
});

// ============================================================================
// Async simulators (run in Hono process)
// ============================================================================

function tick(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function simulateGrading(submissionId: string, learnerAnswer: string): Promise<void> {
  await tick(3_000);
  const [cur] = await db.select().from(exercise_submissions).where(eq(exercise_submissions.id, submissionId)).limit(1);
  if (!cur || cur.status !== 'submitted') return;
  // pending_grade phase
  await db
    .update(exercise_submissions)
    .set({ status: 'pending_grade' })
    .where(eq(exercise_submissions.id, submissionId));
  await tick(2_000);

  const len = learnerAnswer.trim().length;
  const score = len < 40 ? 0.45 : len < 120 ? 0.7 : 0.85;
  const feedback =
    score < 0.6
      ? "The direction is right, but the reasoning isn't developed enough. Try going one more layer into the \"why.\""
      : score < 0.8
        ? 'Basically right ✓ — this would be sturdier with an example tied to your own portfolio.'
        : 'Great — this answer could go straight into your notes. Keep it up.';

  await db
    .update(exercise_submissions)
    .set({
      status: 'graded',
      agent_feedback: feedback,
      agent_score: score,
      graded_at: new Date(),
    })
    .where(eq(exercise_submissions.id, submissionId));
}

// Silence unused imports
void learner_agent_pairs;
void exercises;

export default w;
