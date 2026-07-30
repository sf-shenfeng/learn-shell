// Metacognition confidence — 三档把握度采集 (LEARNER-MODEL-BRIEF §3/§9 批1).
//
// 'guess' (没把握) / 'likely' (偏有把握) / 'certain' (很稳) — 按钮只显定性
// 文案, 从不向学习者或老师呈现百分比. 每档写回后端时仍带一个数值
// (confidence_pct), 但这不是"系统替学习者打折" —— Confidence 主权立法
// (学习者裁决版) 三条:
//   1. 默认锚值词义诚实映射(见下方 CONFIDENCE_ANCHOR_PCT 注释)。
//   2. 映射权归学习者(可调, 见 ../repository/confidenceAnchorExt.ts)。
//   3. 存储双轨: confidence(序数, 事实层, 不可变) + confidence_pct(按当刻
//      锚值折算, 建模层) —— 采集 UI (ConfidencePicker.tsx) 只渲染前者。
// Local type: packages/contracts stays read-only this pass (same reasoning
// as every repository extension in this round — see
// apps/web/src/repository/simulatedQuiz.ts's header comment). Mirrors
// apps/server/src/lib/confidence.ts 1:1.

export type ConfidenceLevel = 'guess' | 'likely' | 'certain';

export const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = ['guess', 'likely', 'certain'];

export type ConfidenceAnchorConfig = Record<ConfidenceLevel, number>;

/** Default anchor per level (词义诚实映射, 学习者裁决版) — guess=40/
 *  likely=70/certain=100, replacing 置信度去数字化 的旧默认 35/65/90 (那组值把
 *  "很稳" 打折读成 90%, 是系统替学习者改口). 学习者可在 Settings 覆盖这三个
 *  数(0-100, 严格递增) — 见 ../repository/confidenceAnchorExt.ts. 真正写回
 *  后端的 confidence_pct 由服务端用这个 pair 当刻的锚值权威计算(见
 *  apps/server/src/routes/write.ts) — 这里的常量只是起步默认值。 */
export const CONFIDENCE_ANCHOR_PCT: ConfidenceAnchorConfig = {
  guess: 40,
  likely: 70,
  certain: 100,
};

/** Mirrors apps/server/src/lib/confidence.ts's validateConfidenceAnchors 1:1
 *  — a fast client-side pre-check before PATCHing Settings' anchor editor
 *  (server re-validates authoritatively; this only avoids a round trip to
 *  find out the input was bad). */
export function validateConfidenceAnchors(anchors: ConfidenceAnchorConfig): string | null {
  for (const level of CONFIDENCE_LEVELS) {
    const n = anchors[level];
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
      return `${level} must be an integer`;
    }
    if (n < 0 || n > 100) return `${level} must be in [0, 100]`;
  }
  if (!(anchors.guess < anchors.likely && anchors.likely < anchors.certain)) {
    return 'anchors must be strictly increasing: guess < likely < certain';
  }
  return null;
}

/** Minimum samples before a calibration bucket is shown instead of the
 *  "显影中·样本不足" placeholder (brief §9's 诚实空态 / 长曝光军规). */
export const CALIBRATION_MIN_SAMPLES = 5;

/** Same constant as apps/server/src/lib/observation-gate.ts — the category
 *  string batch 1's confidence writes are gated on, alongside the mode
 *  toggle. Mock mode uses it to mirror the server's gating locally. */
export const CONFIDENCE_OBSERVATION_CATEGORY = 'metacognition_confidence';

/** 置信度快捷键案: quiz 键盘评分——数字键 1/2/3 直接对应三档, 评分即翻页 (一键双职)。
 *  ConfidencePicker 按钮上的 <Kbd> 提示与 Quiz.tsx 的键盘监听共用同一份映射, 顺序
 *  与 CONFIDENCE_LEVELS 一致 (index 0 → '1' ...), 单一数据源两处消费。 */
export const CONFIDENCE_KEY_BY_LEVEL: Record<ConfidenceLevel, '1' | '2' | '3'> = {
  guess: '1',
  likely: '2',
  certain: '3',
};

export const CONFIDENCE_LEVEL_BY_KEY: Record<'1' | '2' | '3', ConfidenceLevel> = {
  '1': 'guess',
  '2': 'likely',
  '3': 'certain',
};
