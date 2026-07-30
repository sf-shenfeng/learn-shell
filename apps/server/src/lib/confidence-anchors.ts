// Confidence anchor config — 主权立法 (学习者裁决版, 迁移 0031).
//
// 三档把握度按钮 (guess/likely/certain, 展示层"没把握/偏有把握/很稳") 折算成
// 数值时用的锚值, 归学习者所有. Default 40/70/100 (词义诚实映射) —— 一对
// pair 可以在 Settings 里把它调成任何满足"0-100 整数 + 严格递增"的另一组数,
// 这是学习者对自己心智模型的定义权, 不是老师的.
//
// What must NOT happen (镜 observation-gate.ts 同款红线): this module's
// state must never leak into teacher-facing read pipelines — no MCP tool,
// no MCP resource, no get_context/get_learner_brief field ever surfaces a
// pair's confidence_anchor_pct. Only two REST routes touch it (routes/read.ts
// GET, routes/write.ts PATCH), both consumed by the web app's own Settings
// page — never by the teaching agent's MCP transport. Keep it that way.
//
// Dual-track write contract ("Confidence 权属"):
// exercise_submissions.confidence / simulated_quiz_attempts.answers[].confidence
// are the fact layer (the ordinal the learner actually pressed — never
// rewritten). ...confidence_pct is the modeling layer, computed via
// resolveConfidencePct() AT WRITE TIME from whatever this pair's anchors are
// *right now* — never trust a client-submitted pct, and never recompute a
// historical row's pct when the anchors change later (history is history).

import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { learner_agent_pairs } from '../db/schema';
import {
  CONFIDENCE_ANCHOR_PCT,
  validateConfidenceAnchors,
  type ConfidenceAnchorConfig,
  type ConfidenceLevel,
} from './confidence';

/** Unknown pair (or a row somehow missing the column pre-migration) falls
 *  back to the same default the column itself carries. */
export async function getConfidenceAnchors(pairId: string): Promise<ConfidenceAnchorConfig> {
  const [row] = await db
    .select({ confidence_anchor_pct: learner_agent_pairs.confidence_anchor_pct })
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.id, pairId))
    .limit(1);
  return row?.confidence_anchor_pct ?? CONFIDENCE_ANCHOR_PCT;
}

/** Validates (0-100 integers, strictly increasing) then persists. Throws a
 *  plain Error with a human-readable message on invalid input — callers
 *  (routes/write.ts) turn that into a 400, same pattern as every other
 *  hand-validated write route in this file. */
export async function setConfidenceAnchors(
  pairId: string,
  anchors: unknown
): Promise<ConfidenceAnchorConfig> {
  const err = validateConfidenceAnchors(anchors);
  if (err) throw new Error(err);
  const next = anchors as ConfidenceAnchorConfig;
  const [row] = await db
    .update(learner_agent_pairs)
    .set({ confidence_anchor_pct: next })
    .where(eq(learner_agent_pairs.id, pairId))
    .returning({ confidence_anchor_pct: learner_agent_pairs.confidence_anchor_pct });
  if (!row) throw new Error('pair_not_found');
  return row.confidence_anchor_pct;
}

/** The number a submission's confidence_pct gets written as, for `level`,
 *  using this pair's *current* anchors — call this at write time, never
 *  cache it across requests. */
export async function resolveConfidencePct(pairId: string, level: ConfidenceLevel): Promise<number> {
  const anchors = await getConfidenceAnchors(pairId);
  return anchors[level];
}
