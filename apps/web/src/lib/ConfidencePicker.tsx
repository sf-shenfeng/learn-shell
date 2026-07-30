// Confidence picker — 批1 采集面 (考场条款).
//
// Three-tap self-assessment: 按钮只显定性文案("没把握"/"偏有把握"/"很稳"),
// 不显示锚定百分比. 每档写回后端的数值由调用方在提交时从选中的 level 派生
// (乐观展示用, 权威值由服务端用这个 pair *当刻*的锚值配置重算——Confidence
// 主权立法, 学习者裁决版: 映射权归学习者, 见 lib/confidence.ts /
// ../repository/confidenceAnchorExt.ts), 这个组件本身不再持有/校验任何百分
// 比状态. Skippable by design — there is no explicit "skip" control, the
// unset state (no level chosen) IS skip; nothing here blocks submission.
// Shared between Lesson.tsx's ExerciseCard and Quiz.tsx's SimulatedQuizRunner
// — the brief's 考场条款 scopes this to exactly those two evaluation
// surfaces, never Live Teaching / lesson prose.

import { CONFIDENCE_LEVELS, CONFIDENCE_KEY_BY_LEVEL, type ConfidenceLevel } from './confidence';
import { useT } from '../i18n';
import type { DictKey } from '../i18n/dict';
import Kbd from '../shell/Kbd';

const LEVEL_LABEL_KEY: Record<ConfidenceLevel, DictKey> = {
  guess: 'confidence.level.guess',
  likely: 'confidence.level.likely',
  certain: 'confidence.level.certain',
};

export function ConfidencePicker({
  level,
  onLevelChange,
  awaitingConfidence,
}: {
  level: ConfidenceLevel | undefined;
  onLevelChange: (level: ConfidenceLevel | undefined) => void;
  /** 置信度快捷键案: 置信度模式下 Enter 锁定答案后为 true——高亮整行, 视觉上提示
   *  "轮到评分了"。不传 = 不高亮 (Lesson.tsx ExerciseCard 用法沿用旧观感)。 */
  awaitingConfidence?: boolean;
}) {
  const { t } = useT();

  return (
    <div
      className="flex flex-wrap items-center transition-colors duration-[var(--ls-duration-fast)]"
      style={{
        gap: '6px',
        padding: awaitingConfidence ? '5px 8px' : '0',
        borderRadius: '8px',
        border: `1px solid ${awaitingConfidence ? 'var(--ls-hypothesis)' : 'transparent'}`,
        background: awaitingConfidence ? 'var(--ls-panel)' : 'transparent',
      }}
    >
      <span
        className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]"
        style={{ marginRight: '2px' }}
      >
        {t('confidence.prompt')}
      </span>
      {CONFIDENCE_LEVELS.map((lvl) => {
        const on = level === lvl;
        return (
          <button
            key={lvl}
            type="button"
            onClick={() => onLevelChange(on ? undefined : lvl)}
            className="inline-flex items-center font-medium transition-colors duration-[var(--ls-duration-fast)]"
            style={{
              height: '26px',
              padding: '0 10px',
              borderRadius: '999px',
              fontSize: '11px',
              lineHeight: '1',
              gap: '6px',
              border: `1px solid ${on ? 'var(--ls-text)' : 'var(--ls-border)'}`,
              color: on ? 'var(--ls-text)' : 'var(--ls-text-secondary)',
              background: on ? 'var(--ls-panel)' : 'transparent',
            }}
          >
            {t(LEVEL_LABEL_KEY[lvl])}
            <Kbd>{CONFIDENCE_KEY_BY_LEVEL[lvl]}</Kbd>
          </button>
        );
      })}
    </div>
  );
}
