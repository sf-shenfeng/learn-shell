// Metacognition confidence — 三档把握度采集 (LEARNER-MODEL-BRIEF §3/§9 批1).
//
// 'guess' (没把握) / 'likely' (偏有把握) / 'certain' (很稳) — 三档按钮只显
// 定性文案, 从不向学习者或老师呈现百分比. 每档仍写回一个数值(confidence_pct,
// 既有的 0-100 整数字段), 但这不是"系统替学习者打折"——曾把
// certain 锚定值定成 90 (把"很稳"读成 90% 而不是 100%), 这本身就是一次不
// 诚实的映射, 已被学习者裁决推翻(见 docs/ 立法记录). 新规格 (裁决版):
//   1. 词义诚实映射作默认锚值——guess/没把握=40, likely/偏有把握=70,
//      certain/很稳=100. 这里的 CONFIDENCE_ANCHOR_PCT 只是*默认*, 不是唯一
//      合法值.
//   2. 映射权归学习者——每对 pair 可在 Settings 里调整这三个锚值(存
//      learner_agent_pairs.confidence_anchor_pct, 见 lib/confidence-anchors.ts),
//      教师侧工具/brief 不暴露这份配置.
//   3. 存储双轨——按下按钮时写两份: confidence(序数, 事实层, 不可变) +
//      confidence_pct(按*当刻*该 pair 锚值折算的数值, 建模层). 锚值以后调整
//      不重写历史行——历史是历史.
// Local type: packages/contracts stays read-only this pass (same reasoning
// as every other repository/schema extension in this round — see
// apps/web/src/repository/simulatedQuiz.ts's header comment for the pattern
// this mirrors). Mirrored 1:1 on the web side in apps/web/src/lib/confidence.ts.

export type ConfidenceLevel = 'guess' | 'likely' | 'certain';

export const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = ['guess', 'likely', 'certain'];

export type ConfidenceAnchorConfig = Record<ConfidenceLevel, number>;

/** Default anchor per level — 词义诚实映射(裁决版): 没把握=40 / 偏有把握=70 /
 *  很稳=100. Learner-owned and per-pair adjustable (lib/confidence-anchors.ts);
 *  this constant is only the value a pair starts with / falls back to. */
export const CONFIDENCE_ANCHOR_PCT: ConfidenceAnchorConfig = {
  guess: 40,
  likely: 70,
  certain: 100,
};

export function isConfidenceLevel(v: unknown): v is ConfidenceLevel {
  return v === 'guess' || v === 'likely' || v === 'certain';
}

/** Clamp an optional precise percent (行家精确档) to an int in [0, 100], or
 *  null when absent/invalid — never throws, this is a soft optional input. */
export function normalizeConfidencePct(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const rounded = Math.round(v);
  if (rounded < 0 || rounded > 100) return null;
  return rounded;
}

/** Legal domain for a pair's anchor config: each value an integer in
 *  [0, 100], strictly increasing guess < likely < certain — 单调递增校验.
 *  Strict (not ≤) so the three buttons never collapse onto the same number,
 *  which would make the picker meaningless. Returns an error string, or
 *  null when valid. */
export function validateConfidenceAnchors(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return 'anchors must be an object';
  const obj = v as Record<string, unknown>;
  for (const level of CONFIDENCE_LEVELS) {
    const n = obj[level];
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
      return `${level} must be an integer`;
    }
    if (n < 0 || n > 100) return `${level} must be in [0, 100]`;
  }
  const { guess, likely, certain } = obj as ConfidenceAnchorConfig;
  if (!(guess < likely && likely < certain)) {
    return 'anchors must be strictly increasing: guess < likely < certain';
  }
  return null;
}
