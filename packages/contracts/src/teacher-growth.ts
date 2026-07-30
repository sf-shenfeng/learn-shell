// LearnerHypothesis + TeacherReflection — VISION-v4 共生闭环 core.
//
// hypothesis 必须有领域、证据、置信度 + 用户状态.
// reflection 必须指向一个 intervention 和 actual evidence,
//             并写出下一次可验证的具体改变 (ROADMAP-v2.1 风险 4 制动器).

import type { PairId } from './pair';
import type { SessionId } from './session';

export type LearnerHypothesisId = string & { readonly __brand: 'LearnerHypothesisId' };
export type TeacherReflectionId = string & { readonly __brand: 'TeacherReflectionId' };

// 'tentative' 是设计文档（evaluation.ts 头注）明确的首写初始态，record_learner_hypothesis
// 一直在写它——此前枚举漏收导致契约与运行时不一致（2026-07-07 get_learner_brief 开发时发现）。
// 生命周期：tentative → active/confirmed/rejected/frozen/expired。
// 0041 假设生命周期立法后的判决分层（不加新枚举值，服从既有状态）：
//   · confirmed/rejected/frozen 是学习者的主权判决（REST /hypotheses/:id/review），
//     压倒一切——rejected/frozen 永不回到简报，老师的 reinforce/revise/retire
//     不得动它们（confirmed 例外：允许 reinforce 续证据，不许改写/退役）。
//   · 'expired' 是老师侧的死状态：retire（判旧）与 revise（新文本超越旧行）
//     都把旧行写成 expired——与学习者的 rejected 分属两支，语义不混。
//   · "陈旧"(stale) 不是状态：读取时按 last_evidence_at 现算，永不落库。
export type HypothesisStatus = 'tentative' | 'active' | 'rejected' | 'frozen' | 'confirmed' | 'expired';

export interface LearnerHypothesis {
  id: LearnerHypothesisId;
  pair_id: PairId;
  domain: string; // e.g. 'CFA Financial Reporting' / 'Japanese N3 Vocab'
  observation: string;
  evidence_event_ids: string[]; // session_event ids that support
  counterevidence_event_ids: string[]; // session_event ids that argue against
  confidence: number; // 0..1
  status: HypothesisStatus;
  written_by_agent_id: string;
  from_session_id: SessionId;
  user_approved: boolean | null; // null = not yet reviewed
  user_note: string | null;
  last_verified_at: string | null;
  /** 0041 假设生命周期 — 最近一次证据喂养的时刻 (创建/reinforce/revise 时
   *  推进; 存量行回填 = created_at)。可选: 迁移前的 fixture/mock 可以没有。
   *  陈旧与否只在读取时按它现算, 永不作为状态落库。 */
  last_evidence_at?: string | null;
  allowed_for_teaching: boolean; // if user freezes, this goes false
  created_at: string;
  updated_at: string;
}

export type HypothesisChange =
  | { hypothesis_id: LearnerHypothesisId; change: 'created'; reason: string }
  | { hypothesis_id: LearnerHypothesisId; change: 'confidence-up'; from: number; to: number; reason: string }
  | { hypothesis_id: LearnerHypothesisId; change: 'confidence-down'; from: number; to: number; reason: string }
  | { hypothesis_id: LearnerHypothesisId; change: 'rejected'; reason: string };

// Seven-way attribution taxonomy for why a teaching move did or didn't land.
// Stored as semantic slugs — these
// values land in the DB, JSON exports, and the MCP inputSchema (a permanent
// data contract), so they must stay readable to open-source users and
// English-speaking agents; the ①-⑦ numbering lives in comments only.
// 'weather' (⑥) is the odd one out: a same-day state-transient noise
// category (tired/hurting/distracted), never a durable claim about the
// learner — it must never touch the hypothesis pipeline,
// and expires (weather_expires_at) rather than persisting.
// 'path_worked' (⑦, 红队第四轮) is the taxonomy's only *success* branch —
// added because a closed enum with no way to say "this worked as expected"
// structurally pressures agents toward hollow "weather"/"not_yet_mastered"
// picks on a fully-successful lesson, or toward skipping reflection
// altogether. It still carries the full §2-§4 evidence/counterfactual/
// action_link discipline — success is not exempt from having to show its
// work.
export type PrimaryAttribution =
  | 'not_yet_mastered' // ① 学生尚未掌握
  | 'material_flaw' // ② 教学材料有误或不完整
  | 'difficulty_timing' // ③ 难度与时机不合适
  | 'path_mismatch' // ④ 解释路径不适合这个人
  | 'judgment_error' // ⑤ 原判断本身就错
  | 'weather' // ⑥ 天气 — 同日状态性噪音，不是特质
  | 'path_worked'; // ⑦ 路径适配、如预期奏效 — 唯一的成功归因分支

// brief §4 — the forced attribution → action link. Each primary attribution
// has exactly one valid action_link.type (server-enforced in
// mcp/server.ts's reflect_on_teaching handler). 'path_worked' (⑦) reuses
// 'hypothesis_update' rather than minting a new type: a lesson that worked
// exactly as expected is confirming evidence for whatever learner hypothesis
// predicted it would — the correct action is the same pipeline judgment_error
// (⑤) uses to correct a wrong hypothesis, just running in the confidence-up
// direction instead of down/rejected.
export type ActionLinkType =
  | 'review_action' // ① not_yet_mastered
  | 'lesson_revision' // ② material_flaw
  | 'course_adjustment' // ③ difficulty_timing
  | 'intervention_note' // ④ path_mismatch
  | 'hypothesis_update' // ⑤ judgment_error, ⑦ path_worked
  | 'retest_only'; // ⑥ weather

export interface ActionLink {
  type: ActionLinkType;
  ref_id: string;
}

export interface TeacherReflection {
  id: TeacherReflectionId;
  pair_id: PairId;
  from_session_id: SessionId;
  linked_intervention_event_id: string | null;
  // 0035 (反思挂锚, W1C) — 课/Live 场粒度锚点, 均可选+可空: 存量
  // 反思(本迁移之前落库的行)恒为 null, 历史反思仍是 pair 级记录, 不是缺失
  // 数据。新写入经 reflect_on_teaching 的 lesson_id/live_session_id 参数
  // 挂锚, 至少 lesson_id 是推荐做法(下一任老师才能按课读回)。
  lesson_id?: string | null;
  live_session_id?: string | null;
  method: string;
  rationale: string;
  expected_outcome: string;
  actual_evidence: string;
  what_worked: string[];
  what_failed: string[];
  hypothesis_changes: HypothesisChange[];
  next_action: string; // a specific, verifiable change for the next session
  // 0018 attribution skeleton. Optional +
  // nullable: pre-0018 rows (and any web-side fixture/mock predating this
  // batch) carry none of these. New writes through reflect_on_teaching are
  // forced to populate them server-side — this is not where that's enforced.
  primary_attribution?: PrimaryAttribution | null;
  secondary_attribution?: PrimaryAttribution | null;
  evidence?: string | null;
  counterfactual?: string | null;
  action_link?: ActionLink | null;
  /** Only set (and only meaningful) when primary_attribution === 'weather'
   *  (⑥). ISO timestamp; past this instant the row is excluded from every
   *  read path (brief §1/§5) and must never feed a hypothesis. */
  weather_expires_at?: string | null;
  written_at: string;
}
