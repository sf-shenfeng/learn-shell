// Observation gate — 批0.
//
// The one checkpoint every profile-writing ("画像类") code path must call
// BEFORE an insert. A hit means the write is skipped entirely — never
// written then hidden (brief §4 军规 3: "禁区归学习者... 采集层直接不写入
// (不是写入后隐藏)"). Two independent reasons a write can be gated:
//
//   1. forbidden_observations — the learner's own registry of categories
//      the agent must never record about them (批0's "登记簿"). Lives on
//      learner_agent_pairs, not teaching_contracts — see pair.ts's column
//      comment for why (multiple simultaneously-active contracts per pair).
//   2. confidence_mode_enabled — 批1's separate opt-out for the whole
//      metacognition-confidence capture surface. Same "don't write, don't
//      hide" semantics, different switch (可选功能).
//
// Both are read from the same pair row in one query — callers that need
// both checks (batch 1's confidence writes) get them for the price of one
// lookup via getObservationGateState.
//
// What must NOT happen: this module's state must never leak into teacher-
// facing read pipelines (get_context / get_learner_brief in context-brief.ts)
// — the registry itself is not something the teaching agent's reasoning
// should see (brief §0/§9: "禁区清单本身不进教师侧管道"). Neither of those
// two functions imports this module — keep it that way.

import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { learner_agent_pairs } from '../db/schema';

/** Category used to gate batch 1's confidence-capture writes (exercise
 *  submissions + simulated quiz answers) through the same registry that
 *  gates every other profile observation. Currently nothing forbids this
 *  by default ("百无禁忌") — the learner can still add it by hand via
 *  Settings' 观察禁区 section, same as any other category string. */
export const CONFIDENCE_OBSERVATION_CATEGORY = 'metacognition_confidence';

/** Category used to gate the attribution-as-observation content that
 *  reflect_on_teaching (0018, §4/§5)
 *  writes for non-weather primary attributions (①-⑤, ⑦): primary_attribution,
 *  secondary_attribution, evidence, counterfactual, action_link are all an
 *  observation about the learner and go through this same registry, same
 *  as any other profile-writing path. ⑥ (weather) never checks this — it's
 *  same-day noise, structurally out of scope for the registry by design
 *  (brief §1/§3), not merely opted out of it. */
export const TEACHING_ATTRIBUTION_OBSERVATION_CATEGORY = 'teaching_attribution';

export interface ObservationGateState {
  forbidden_observations: string[];
  confidence_mode_enabled: boolean;
  confidence_mode_changed_at: string | null;
}

export async function getObservationGateState(pairId: string): Promise<ObservationGateState> {
  const [row] = await db
    .select({
      forbidden_observations: learner_agent_pairs.forbidden_observations,
      confidence_mode_enabled: learner_agent_pairs.confidence_mode_enabled,
      confidence_mode_changed_at: learner_agent_pairs.confidence_mode_changed_at,
    })
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.id, pairId))
    .limit(1);
  return {
    forbidden_observations: row?.forbidden_observations ?? [],
    // Unknown pair defaults to the same "on" default as the column itself —
    // there's no meaningful "off" to fall back to when the pair can't be found.
    confidence_mode_enabled: row?.confidence_mode_enabled ?? true,
    confidence_mode_changed_at: row?.confidence_mode_changed_at
      ? row.confidence_mode_changed_at.toISOString()
      : null,
  };
}

/** True when `category` is on this pair's forbidden_observations list —
 *  callers must skip the write entirely (not write-then-redact) when true. */
export async function isObservationForbidden(pairId: string, category: string): Promise<boolean> {
  const state = await getObservationGateState(pairId);
  return state.forbidden_observations.includes(category);
}

export async function isConfidenceModeEnabled(pairId: string): Promise<boolean> {
  const state = await getObservationGateState(pairId);
  return state.confidence_mode_enabled;
}

/** Combined check for batch 1's confidence writes: mode must be on AND the
 *  confidence category must not be individually forbidden. */
export async function isConfidenceCaptureAllowed(pairId: string): Promise<boolean> {
  const state = await getObservationGateState(pairId);
  return (
    state.confidence_mode_enabled &&
    !state.forbidden_observations.includes(CONFIDENCE_OBSERVATION_CATEGORY)
  );
}
