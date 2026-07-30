// LessonAxesBar — State 2.0 (迁移 0030) 课程状态条。Lesson 页头部, 低调地把
// 四轴摊开: 内容(草稿/已发布/已修订 vN) · 学习(未开始/进行中/已学完/已闭环)
// · 评估(未评/已评) · 闭环(待收口/已收口)。闭环格只在"已学完但未闭环"这一态
// 渲染 —— 其余状态下它与学习轴 100% 同源重复 (loop_closed 是 learning 的布
// 尔投影), 省略不显是防双重播报, 见下方 showLoopSegment 注释。
//
// 视觉语言直接照抄页面已有的 meta 行 (h1 上方 "第X课 · ≈N分钟" 那一行):
// 小号字、宽字距、tertiary 灰、用 " · " 分隔——不做 pill、不加色块，"不抢课文
// 的戏"。axes 缺失 (null/undefined —— 契约未落地、这批端点还没接、或数据行
// 异常退化) 时安静不渲染，同 LessonStatusBadge/CourseCompletionBadge 的
// "state 缺省不渲染" 沉默哲学一致，不用占位符冒充事实。

import type { LessonAxes } from '@learn-shell/contracts';
import { useT } from '../i18n';
import type { DictKey } from '../i18n/dict';

const LEARNING_LABEL_KEY: Record<LessonAxes['learning'], DictKey> = {
  not_started: 'lesson.axes.learning.notStarted',
  in_progress: 'lesson.axes.learning.inProgress',
  completed_declared: 'lesson.axes.learning.completedDeclared',
  closed: 'lesson.axes.learning.closed',
};

export function LessonAxesBar({ axes }: { axes: LessonAxes | null | undefined }) {
  const { t } = useT();
  if (!axes) return null;

  // 迁移 0033 (双轨修订): "已修订 vN" 读 teaching_revision, 不读全轨的
  // revision —— 技术修订(格式/门禁/重构/错别字)不该在这里冒头。
  const contentLabel =
    axes.content === 'published'
      ? axes.teaching_revision > 1
        ? `${t('lesson.axes.content.revisedPrefix')}${axes.teaching_revision}`
        : t('lesson.axes.content.published')
      : t('lesson.axes.content.draft');

  // 设计依据 (钦定, 六针修复 item 3): loop_closed 是 learning === 'closed' 的
  // 布尔投影 (同源, 见 packages/contracts/src/progress.ts LessonAxes 头注)
  // —— 不是独立事实源, 全程与 learning 100% 相关。闭环格在任何状态下都不带
  // 独立信息: learning='closed' 时它必是"已收口", 跟学习轴刚说的"已闭环"重复
  // 播报；not_started/in_progress 时它必是"待收口", 属于平凡真值, 没有提示
  // 价值。唯一有信息量的时刻是 completed_declared (已学完但还没收口) —— 这时
  // "待收口"是一句有效提醒(该去收口了)。所以闭环格只在这一态渲染, 且该态下
  // loop_closed 恒为 false ("已收口"分支永不可达), 故不做三元判断, 直接给
  // "待收口"定值; closed 态的播报交给学习轴的 "已闭环/Closed" 一句话说完。
  const showLoopSegment = axes.learning === 'completed_declared';

  const parts = [
    contentLabel,
    t(LEARNING_LABEL_KEY[axes.learning]),
    axes.evaluated ? t('lesson.axes.evaluated.yes') : t('lesson.axes.evaluated.no'),
    ...(showLoopSegment ? [t('lesson.axes.loop.open')] : []),
  ];

  return (
    <div
      className="text-[11px] tracking-[0.04em] text-[var(--ls-text-tertiary)]"
      style={{ marginTop: '4px' }}
    >
      {parts.join(' · ')}
    </div>
  );
}
