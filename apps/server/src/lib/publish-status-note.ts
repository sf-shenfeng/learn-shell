// 断点④ — verify_prep 的结果只报验尺状态(PASS/FAIL/黄灯数), 从不提
// "这节课发没发布"。白板考生备完课、verify_prep 拿到 PASS，就以为学习者已经
// 看得到——validate-prep-core 的纯检查逻辑管的是"教具自洽不自洽", 天然不知道
// 也不该知道 published_at (那是 Publish Gate 的地界)。这两个纯函数
// 只做"给定验尺状态 + published_at, 拼一句/一个字段"的展示层判定, 不碰
// validate-prep-core 一行——供 mcp/server.ts 的 verify_prep handler 在
// validateLesson 之后组装结果时调用。

import type { LessonReport } from './validate-prep-core';

export type PublishStatusLabel = 'draft' | 'published';

/** published_at 非空 → 'published'，否则 'draft'。纯映射，不掺验尺状态。 */
export function publishStatusLabel(publishedAt: Date | null): PublishStatusLabel {
  return publishedAt != null ? 'published' : 'draft';
}

/** verify_prep 结果里附的"发布状态"一行——空字符串表示不附加(草稿 + FAIL:
 *  红灯清单本身已经说明白了, 不需要再补一句噪音)。
 *    - 已发布 → "已发布于 <ISO 时间戳>"
 *    - 草稿 + PASS/PASS_WITH_WARNINGS → 明确提示"验尺通过但尚未发布"
 *    - 草稿 + FAIL → '' (红灯本身就是没法发布的理由，无需重复) */
export function buildPublishStatusNote(
  status: LessonReport['status'],
  publishedAt: Date | null
): string {
  if (publishedAt != null) {
    return ` · published at ${publishedAt.toISOString()}`;
  }
  if (status === 'PASS' || status === 'PASS_WITH_WARNINGS') {
    return " · verification passed but not yet published — the learner can't see this lesson yet, next: publish_lesson";
  }
  return '';
}
