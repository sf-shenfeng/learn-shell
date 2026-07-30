// 课条目 — 最重的一种.
//
// 标题行 (课名 + 课程 chip；日期归日组组头, 按日归组修订) → 成果行 (一行说完,
// 缺项不占位) → 评估正文, 三通道呈现分层 (迁移 0044):
//   learner_note 存在 → 就是正文 (人话优先, 不带"{agent}的观察"归属标签);
//   learner_note 缺席 (旧数据) → 兼容回落, agent_observation 原样当正文,
//     沿用旧有"{agent.display_name}的观察"归属标签 (称谓来自 identity,
//     见 lib/identity.ts);
//   learner_note 存在时 agent_observation 改收进折叠次要区 ("教学观察"),
//     evidence_refs (若非空) 展示为安静的引用小行——都不进正文, 详见 shared.tsx。
// "我的笔记" 区 (Annotation 按色分组) 是 β 期, 这里有意不出现.
//
// 条目自身默认展开、可折叠；折叠态 = 标题行 + 成果行. 页面密度由日组
// 的默认折叠兜底 (按日归组修订 推翻页面级"默认全展开").

import { useState } from 'react';
import { useT } from '../../i18n';
import type { LessonJournalEntry } from '../types';
import { CollapsibleText, CourseChipBadge, EvidenceRefsLine, KindTag, SecondaryDisclosure } from './shared';

export default function LessonEntryCard({
  entry,
  agentLabel,
}: {
  entry: LessonJournalEntry;
  agentLabel: string;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(true);

  const outcomeChunks: string[] = [];
  if (entry.exerciseCount != null)
    outcomeChunks.push(`${entry.exerciseCount}${t('journal.exercisesUnit')}`);
  if (entry.exerciseScores.length > 0) {
    outcomeChunks.push(entry.exerciseScores.map((s) => s.toFixed(2)).join('/'));
  }
  if (entry.newCardsCount != null)
    outcomeChunks.push(`${t('journal.newCardsPrefix')}${entry.newCardsCount}`);
  if (entry.durationMinutes != null) outcomeChunks.push(`${entry.durationMinutes}min`);

  // 三通道分层 (shared.tsx 头注): learner_note 在时是正文, 不在时兼容回落
  // 到 agent_observation 当正文——两种情形只会有一个非空, 用它做 hasBody。
  const primaryText = entry.learnerNote ?? entry.agentObservation;
  const hasBody = !!primaryText;
  // agent_observation 只有在 learner_note 已经顶替了正文位置时才需要再单独
  // 露出——回落场景里它已经是 primaryText 本身, 不需要重复一份次要区。
  const secondaryObservation =
    entry.learnerNote && entry.agentObservation ? entry.agentObservation : null;

  return (
    <li
      className="border border-[var(--ls-border)]"
      style={{ borderRadius: 'var(--ls-radius-card)', padding: '14px 16px' }}
    >
      <button
        type="button"
        onClick={() => hasBody && setExpanded((v) => !v)}
        className="flex items-start justify-between w-full text-left"
        style={{ gap: '10px', cursor: hasBody ? 'pointer' : 'default' }}
        aria-expanded={expanded}
      >
        <span className="flex items-baseline flex-wrap min-w-0" style={{ gap: '8px' }}>
          <KindTag label={t('journal.lessonTag')} color="var(--ls-structure)" />
          <span className="font-medium" style={{ fontSize: '14px', lineHeight: '20px' }}>
            {entry.lessonTitle}
          </span>
        </span>
        <span className="flex items-center flex-none" style={{ gap: '8px' }}>
          <CourseChipBadge topic={entry.courseTopic} />
          {hasBody && (
            <span
              className="text-[var(--ls-text-tertiary)]"
              style={{ fontSize: '11px', transform: expanded ? 'rotate(180deg)' : undefined }}
              aria-hidden
            >
              ▾
            </span>
          )}
        </span>
      </button>

      {outcomeChunks.length > 0 && (
        <div
          className="flex items-baseline"
          style={{ gap: '6px', marginTop: '8px', fontSize: '13px', lineHeight: '18px' }}
        >
          <span style={{ color: 'var(--ls-text-tertiary)' }}>{t('journal.outcome')}</span>
          <span style={{ color: 'var(--ls-text-secondary)' }} className="tabular-nums">
            {outcomeChunks.join(' · ')}
          </span>
        </div>
      )}

      {expanded && primaryText && (
        <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--ls-border)' }}>
          {/* 归属标签只在回落场景 (learner_note 缺席) 保留——那时正文其实是
              agent_observation, "老师说"的归属仍然成立; learner_note 本身是
              写给学习者的人话, 不需要再挂一层"谁说的". */}
          {!entry.learnerNote && (
            <div
              style={{ fontSize: '11px', lineHeight: '16px', color: 'var(--ls-text-tertiary)', marginBottom: '4px' }}
            >
              {agentLabel}{t('journal.observationSuffix')}
            </div>
          )}
          <CollapsibleText text={primaryText} lines={2} />
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
