// Annotation — 划注：学习者的笔迹.
//
// 关键产品判断: 高亮与注释是同一条记录的两个面——划了不写 = 纯高亮,
// 划了再写 = 笔记, 不设两个实体. 锚点用文本引用 {selected_text, prefix,
// suffix} + page_index.
//
// 金缮条款: 课文修订后锚点重定位失败的划注进孤儿区, 绝不静默丢——
// resolve 失败是状态不是删除理由. 教师侧对划注只读 (笔迹主权归学习者,
// 姿态公理的镜像条款).

import type { PairId } from './pair';
import type { LessonId } from './content';

export type AnnotationId = string & { readonly __brand: 'AnnotationId' };

/** 批A 固定 'amber' 单色走通链路; 批B 接 Mindmap 调色板色键后收紧为 union
 *  (颜色即分类学——跨模块同一套色彙). */
export type AnnotationColorKey = string;

export interface LessonAnnotation {
  id: AnnotationId;
  pair_id: PairId;
  lesson_id: LessonId;
  /** 锚点所在页 (翻页课文的 page index, 0-based)。 */
  page_index: number;
  /** 文本引用锚: 所划原文。 */
  selected_text: string;
  /** 锚点前文 (消歧用, 定长截取)。 */
  prefix: string;
  /** 锚点后文 (消歧用, 定长截取)。 */
  suffix: string;
  color: AnnotationColorKey;
  /** null = 纯高亮; 有值 = 笔记。 */
  note: string | null;
  created_at: string;
  updated_at: string;
}
