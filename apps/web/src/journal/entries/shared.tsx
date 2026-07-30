// Shared bits across the three entry-card renderers.

import { useState } from 'react';
import { useT } from '../../i18n';
import HoverScrollText from '../../components/HoverScrollText';

/** 折叠到 N 行 + "展开/收起"。启发式判断要不要露出按钮——没有
 * ResizeObserver 那套，够用就好 (隐身术：不为一个文本块引入测量机制). */
export function CollapsibleText({ text, lines = 2 }: { text: string; lines?: number }) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const roughlyClamped = text.length > lines * 34;

  return (
    <div>
      <p
        className="text-[13px] leading-[20px] text-[var(--ls-text-secondary)] whitespace-pre-wrap"
        style={
          expanded || !roughlyClamped
            ? undefined
            : {
                display: '-webkit-box',
                WebkitLineClamp: lines,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
        }
      >
        {text}
      </p>
      {roughlyClamped && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text-secondary)]"
          style={{ marginTop: '4px' }}
        >
          {expanded ? t('journal.collapse') : t('journal.expand')}
        </button>
      )}
    </div>
  );
}

// 悬停滚动读全案: 140px 上限装不下的课名，hover 400ms 后在 pill 内部往返滚
// 一趟（滚动只发生在容器里，pill 尺寸不变，不推动同排的 KindTag/时间）。装得
// 下的课名完全静止 —— 判据是 scrollWidth > clientWidth，见 HoverScrollText。
//
// 结构从"一个 span 同时当 pill 和裁切框"拆成了外 pill + 内裁切框两层：
// overflow:hidden 裁在 padding 边, 一层写法会让滚动的文字爬进右边那 8px
// padding 才消失。视觉尺寸/字号/边框一个像素没动。
export function CourseChipBadge({ topic }: { topic: string | null }) {
  if (!topic) return null;
  return (
    <span
      title={topic}
      className="flex-none inline-flex items-center"
      style={{
        maxWidth: '140px',
        fontSize: '11px',
        lineHeight: '16px',
        color: 'var(--ls-text-tertiary)',
        border: '1px solid var(--ls-border)',
        borderRadius: 'var(--ls-radius-pill)',
        padding: '1px 8px',
      }}
    >
      <HoverScrollText
        text={topic}
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      />
    </span>
  );
}

export function KindTag({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="flex-none uppercase tracking-wider font-semibold"
      style={{ fontSize: '10px', lineHeight: '14px', color }}
    >
      {label}
    </span>
  );
}

// 三通道呈现分层 (迁移 0044) 的共享次要区件——learner_note 拿到主
// 文案位置后, agent_observation (教师内账) 与 evidence_refs (机器引用) 都
// 降级为这里两个安静的次要件, 供 Journal 与 Lesson.tsx 的评估两区共用。

/** 低调的折叠次要区——默认收起, 点开才见内容。用于把 agent_observation
 *  从正文降级为次要信息, 而不是彻底藏起来 (v1 单机信任模型: 学习者想看
 *  点开就看, 标签中性不神秘). 视觉语言借用卡片自身展开箭头的先例
 *  (▾ 旋转 180deg). */
export function SecondaryDisclosure({ label, text }: { label: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ marginTop: '10px' }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center text-[11px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text-secondary)]"
        style={{ gap: '4px' }}
        aria-expanded={expanded}
      >
        <span
          aria-hidden
          style={{ fontSize: '9px', transform: expanded ? 'rotate(180deg)' : undefined }}
        >
          ▾
        </span>
        {label}
      </button>
      {expanded && (
        <p
          className="whitespace-pre-wrap"
          style={{
            fontSize: '13px',
            lineHeight: '20px',
            color: 'var(--ls-text-secondary)',
            marginTop: '6px',
          }}
        >
          {text}
        </p>
      )}
    </div>
  );
}

/** 机器引用的安静小行——evidence_refs 缩写展示, 非空才占位, 不当正文渲染。 */
export function EvidenceRefsLine({ refs }: { refs: string[] }) {
  const { t } = useT();
  const abbreviated = refs.map((id) => (id.length > 8 ? `${id.slice(0, 6)}…` : id));
  return (
    <div
      className="text-[11px] text-[var(--ls-text-tertiary)]"
      style={{ marginTop: '6px' }}
    >
      {t('evaluation.evidenceRefsLabel')} · {abbreviated.join(', ')}
    </div>
  );
}
