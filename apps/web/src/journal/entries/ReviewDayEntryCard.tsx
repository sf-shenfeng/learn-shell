// 复习日条目 — 最轻的一种, 一行.
//
// 卡数来自 getRecentSessions 的 cards_reviewed 按天聚合；命中数需要逐 session
// 拉 getSessionEvents 找 review.rated 的 rating —— 拿不到就只显示卡数,
// 不许硬凑命中率 (brief §数据拼装约束). 日期归日组组头 (按日归组修订)；
// 组头摘要已含"复习 K 张"，这一行的增量信息是命中数.

import { useT } from '../../i18n';
import type { ReviewDayJournalEntry } from '../types';
import { KindTag } from './shared';

export default function ReviewDayEntryCard({ entry }: { entry: ReviewDayJournalEntry }) {
  const { t } = useT();
  return (
    <li className="flex items-baseline" style={{ gap: '8px', padding: '4px 2px' }}>
      <KindTag label={t('nav.review')} color="var(--ls-corroborated)" />
      <span style={{ fontSize: '13px', lineHeight: '18px', color: 'var(--ls-text-secondary)' }}>
        <span className="tabular-nums">
          {entry.cardCount}
          {t('journal.day.cardsUnit')}
          {entry.hitCount != null ? `${t('journal.hitCountPrefix')}${entry.hitCount}` : ''}
        </span>
      </span>
    </li>
  );
}
