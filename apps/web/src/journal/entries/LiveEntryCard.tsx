// Live 条目 — 中量级: 场评正文 + 轮次数.
//
// 数据来源见 useJournalTimeline 顶部注释：没有"按 pair 批量取 live session"
// 的端点，这里按 lesson 反查 getLiveSessionForLesson 重建 —— 一个 lesson
// 只能看到它最近一次的 completed live session（β 期端点愿望清单里有记）。
//
// 换源 (2026-07-25): 正文原本是 live_sessions 的 REFLECT 三段
// (summary / teacher_reflection / next_action)，那是老师收课时写给自己的内账,
// 里面按工具要求锚着 `tr_…` 之类的内部 id, 整段摊给学习者看 = 机器码上屏。
// 三段整体退役 (不做正则剥离——剥掉 id 句子就没了主语, 那是遮掩不是修复),
// 换成这场 Live 真正的学习者通道: live_session_evaluations 的三通道制
// (迁移 0044)，分层规则逐条照抄 LessonEntryCard：
//   learnerNote 有值 → 就是正文 (人话优先);
//   learnerNote 缺席 (旧数据/这场没写) → 兼容回落, agentObservation 当正文,
//     并挂回 "{agent} 的观察" 归属标签;
//   learnerNote 在时 agentObservation 降级进折叠次要区 ("教学观察"),
//     evidenceRefs 非空才现身为安静的引用小行。
//
// 按日归组修订: 可折叠。折叠态 = 标题行 + 一行摘要 (正文首行截断)。
// 默认展开；页面密度由日组的默认折叠兜底.

import { useState } from 'react';
import { useT } from '../../i18n';
import type { LiveJournalEntry } from '../types';
import { CollapsibleText, EvidenceRefsLine, KindTag, SecondaryDisclosure } from './shared';

export default function LiveEntryCard({
  entry,
  agentLabel,
}: {
  entry: LiveJournalEntry;
  agentLabel: string;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(true);

  // 三通道分层 (shared.tsx 头注) — 与 LessonEntryCard 同一份判定。
  const primaryText = entry.learnerNote ?? entry.agentObservation;
  const hasBody = !!primaryText;
  // agent_observation 只有在 learner_note 已经顶替了正文位置时才需要再单独
  // 露出——回落场景里它已经是 primaryText 本身, 不重复一份次要区。
  const secondaryObservation =
    entry.learnerNote && entry.agentObservation ? entry.agentObservation : null;

  return (
    <li
      className="border border-[var(--ls-border)]"
      style={{ borderRadius: 'var(--ls-radius-card)', padding: '12px 16px' }}
    >
      <button
        type="button"
        onClick={() => hasBody && setExpanded((v) => !v)}
        className="flex items-start justify-between w-full text-left"
        style={{ gap: '10px', cursor: hasBody ? 'pointer' : 'default' }}
        aria-expanded={expanded}
      >
        <span className="flex items-baseline flex-wrap min-w-0" style={{ gap: '8px' }}>
          <KindTag label="Live" color="var(--ls-hypothesis)" />
          <span className="font-medium" style={{ fontSize: '14px', lineHeight: '20px' }}>
            {entry.lessonTitle ?? t('journal.adhocTopic')}
          </span>
          {entry.turnCount != null && (
            <span
              className="tabular-nums"
              style={{ fontSize: '12px', lineHeight: '16px', color: 'var(--ls-text-tertiary)' }}
            >
              · {entry.turnCount}{t('journal.turnsUnit')}
            </span>
          )}
        </span>
        {hasBody && (
          <span
            className="flex-none text-[var(--ls-text-tertiary)]"
            style={{ fontSize: '11px', transform: expanded ? 'rotate(180deg)' : undefined }}
            aria-hidden
          >
            ▾
          </span>
        )}
      </button>

      {!expanded && primaryText && (
        <p
          style={{
            marginTop: '6px',
            fontSize: '12px',
            lineHeight: '18px',
            color: 'var(--ls-text-tertiary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {primaryText}
        </p>
      )}

      {expanded && primaryText && (
        <div className="flex flex-col" style={{ gap: '8px', marginTop: '10px' }}>
          {/* 归属标签只在回落场景 (learner_note 缺席) 保留——那时正文其实是
              agent_observation, "老师说"的归属仍然成立; learner_note 本身是
              写给学习者的人话, 不需要再挂一层"谁说的"。同 LessonEntryCard。 */}
          {!entry.learnerNote && (
            <div
              style={{
                fontSize: '11px',
                lineHeight: '16px',
                color: 'var(--ls-text-tertiary)',
                marginBottom: '-2px',
              }}
            >
              {agentLabel}{t('journal.observationSuffix')}
            </div>
          )}
          <CollapsibleText text={primaryText} lines={3} />
          {secondaryObservation && (
            <SecondaryDisclosure
              label={t('evaluation.teachingObservationLabel')}
              text={secondaryObservation}
            />
          )}
          {entry.evidenceRefs && entry.evidenceRefs.length > 0 && (
            <EvidenceRefsLine refs={entry.evidenceRefs} />
          )}
        </div>
      )}
    </li>
  );
}
