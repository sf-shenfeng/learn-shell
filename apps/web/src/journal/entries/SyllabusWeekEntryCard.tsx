// 考纲周条目 — 第四类, 一行.
//
// 语言规范 (brief §4): 只报点亮, 不数黑洞——文案里没有"落后/欠账/薄弱"这类
// 词汇, 也没有"还剩 M 个没碰"这种反向计数, 只报"本周点亮 N 个"+"累计覆盖 X%"
// 两个正向数字。KindTag 复用 --ls-corroborated (绿, "多轮验证/已掌握"的语义)
// ——四类条目目前只有 4 种可用的语义色 token (structure/hypothesis/
// corroborated/risk), 前三种已被 lesson/live/review-day 占用, risk 是红色、
// 负面联想跟这里"点亮"的正向框架冲突, 所以复用 corroborated 而不是新开一个
// token (新增 --ls-* token 超出本次交付的文件域, 是设计系统层面的决定).
//
// code 列表截断 (brief §4 "codes 截断"): 超过 CODES_VISIBLE 个只显示前几个 +
// "还有 N 个"式的计数后缀——这个后缀本身是"还有更多点亮"的正向延伸, 不是
// "还差 N 个"的黑洞计数, 语言规范上是安全的。

import { useT } from '../../i18n';
import type { SyllabusWeekJournalEntry } from '../types';
import { KindTag } from './shared';

const CODES_VISIBLE = 6;

export default function SyllabusWeekEntryCard({ entry }: { entry: SyllabusWeekJournalEntry }) {
  const { t } = useT();
  const visible = entry.litNodeCodes.slice(0, CODES_VISIBLE);
  const overflow = entry.litNodeCodes.length - visible.length;

  return (
    <li className="flex items-baseline" style={{ gap: '8px', padding: '4px 2px' }}>
      <KindTag label={t('journal.syllabusTag')} color="var(--ls-corroborated)" />
      <span style={{ fontSize: '13px', lineHeight: '18px', color: 'var(--ls-text-secondary)' }}>
        {t('journal.syllabusWeek.prefix')}
        <span className="tabular-nums">{entry.litNodeCodes.length}</span>
        {t('journal.syllabusWeek.codesUnit')}
        <span>{visible.join(', ')}</span>
        {overflow > 0 && (
          <span style={{ color: 'var(--ls-text-tertiary)' }}>
            {t('journal.syllabusWeek.overflowPrefix')}
            {overflow}
            {t('journal.syllabusWeek.overflowSuffix')}
          </span>
        )}
        {entry.cumulativeCoveragePct != null && (
          <span>
            {t('journal.syllabusWeek.cumulativePrefix')}
            <span className="tabular-nums">{entry.cumulativeCoveragePct}</span>%
          </span>
        )}
      </span>
    </li>
  );
}
