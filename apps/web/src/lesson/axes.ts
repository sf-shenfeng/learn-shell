// LessonAxes — State 2.0 (迁移 0030) 四轴课程状态。类型定义已由服务端纵队
// 落地在 packages/contracts/src/progress.ts (与 LessonRevisionSeen 同批),
// index.ts 的 `export * from './progress'` 已经把它带到 '@learn-shell/
// contracts' 顶层, 这里直接 import 即可:
//
//   LessonAxes = {
//     content: 'draft' | 'published';
//     revision: number;              // 全轨自增, 事实层不动 —— 展示层别直接读它
//     teaching_revision: number;     // 迁移 0033: 只计 teaching 轨的"版本号", 展示层读这个
//     revision_seen: number | null;
//     learning: LessonProgressState;   // 'not_started'|'in_progress'|'completed_declared'|'closed'
//     evaluated: boolean;
//     loop_closed: boolean;
//   }
//
// apps/server/src/routes/read.ts 的课清单端点 (GET /courses/:id/lessons)
// 把它拼进每课的 payload —— `{ ...lesson, axes: axesByLesson.get(id) ?? null }`
// (见该文件 State 2.0 注释块) —— 缺行/异常情况退化为 null, 不是 undefined。
//
// Lesson 本体 (content.ts) 并不携带 axes 字段: axes 是 read.ts 现算现拼的
// 视图层附加值, 不是持久化在 lessons 表上的列, 所以这不是一个等契约落地就
// 能删掉的过渡类型 —— LessonWithAxes 交叉类型是这份数据形状的正确长期建模。
import type { Lesson, LessonAxes } from '@learn-shell/contracts';

export type LessonWithAxes = Lesson & { axes?: LessonAxes | null };

const REVISION_FLAG_LEARNING_STATES: ReadonlySet<LessonAxes['learning']> = new Set([
  'completed_declared',
  'closed',
]);

/** 修订回执制 (学习者裁决 A) 的服务端真相判定 — "这课改过了，回来看看"：
 *  axes.teaching_revision > (axes.revision_seen ?? 0) 且 learning 已经完成过
 *  一轮 (completed_declared / closed)。迁移 0033 (双轨修订) 起改用
 *  teaching_revision 而非全轨 revision —— 技术修订(格式/门禁/重构/错别字)
 *  不该推高"未读修订"标, 对学习者隐身。缺 axes (null/undefined, 尚未加载或
 *  该行异常退化) 一律判 false — 沉默优先于误报。 */
export function isRevisedUnread(axes: LessonAxes | null | undefined): boolean {
  if (!axes) return false;
  if (!REVISION_FLAG_LEARNING_STATES.has(axes.learning)) return false;
  return axes.teaching_revision > (axes.revision_seen ?? 0);
}
