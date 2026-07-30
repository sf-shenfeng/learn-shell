// Mindmap — Hub 哲学修正版 (TEACHING-SPEC §3.4 + §3.5).
//
// 关键产品判断: 思维导图是【地图】, 不是反刍工具. Agent 备课时出"含重点内容的
// 基础概念框架" (root + branch + detail), 学生看一眼就知道学到哪了; 'note' 层
// 留给学生扩展. 父子树 (XMind 层级) + 自由 link (Heptabase 横向) 并存.
//
// 一键清除: agent_seed_snapshot 永远保留, content 是当前显示版本.
// 多课关联: 自建图可通过 MindmapAssociation 表挂到多个 lesson/course.
// PendingCard 池: 难卡 / 学生高亮 / agent seed 入池, 不强行落图, 学生拖才入图.

import type { PairId } from './pair';
import type { LessonId, CourseId } from './content';

export type MindmapId = string & { readonly __brand: 'MindmapId' };
export type PendingCardId = string & { readonly __brand: 'PendingCardId' };

// =========================================================================
// Mindmap + Content (single-doc storage)
// =========================================================================

export type MindmapScope = 'lesson' | 'course' | 'custom';
// 'custom' = 自建图开局无关联; 后续可通过 MindmapAssociation 多关联.

export type NodeLevel = 'root' | 'branch' | 'detail' | 'note';
// root + branch + detail = agent 出的基础框架
// note = 学生自加 / 从 PendingCard 池拖来

export type NodeSourceType = 'lesson' | 'flashcard' | 'exercise' | 'concept' | 'custom';

export interface MindmapNode {
  id: string;
  parent_id?: string; // 父子树 (XMind 层级感)
  title: string;
  /** @deprecated 2026-07-01. Sub-thoughts belong as child nodes, not hidden content. Kept for backward-compat only. */
  content?: string;
  level: NodeLevel;
  source_type?: NodeSourceType;
  source_id?: string;
  source_title?: string;
  /**
   * When is_pinned is truthy, pos_x/pos_y are absolute canvas-pixel
   * coordinates and override the automatic tree layout. Otherwise the
   * editor computes position from parent_id + sort_order + is_expanded
   * and pos_x/pos_y are unused (agents can leave them at 0).
   */
  pos_x: number;
  pos_y: number;
  is_pinned?: boolean;
  color?: string;
  is_expanded: boolean;
  sort_order: number;
}

export interface MindmapLink {
  id: string;
  from_node_id: string;
  to_node_id: string;
  label?: string;
  // ↑ 跟父子线并存的自由连线 (Heptabase 横向连接感)
}

export interface MindmapContent {
  nodes: MindmapNode[];
  links: MindmapLink[];
}

export interface Mindmap {
  id: MindmapId;
  owner_pair_id: PairId;
  scope: MindmapScope;
  title: string;
  folder?: string; // 自由分组字符串
  source: 'agent' | 'user';
  agent_skill_used?: string;
  agent_seed_snapshot: MindmapContent; // agent 出的初版, 永远保留 (用于一键恢复)
  content: MindmapContent; // 当前显示, 学生可改
  has_been_reset: boolean;
  created_at: string;
  updated_at: string;
}

// =========================================================================
// MindmapAssociation — 多对多关联表 (自建图可挂多个 lesson/course)
// =========================================================================

export type MindmapAssociationTargetType = 'lesson' | 'course';

export interface MindmapAssociation {
  id: string;
  mindmap_id: MindmapId;
  target_type: MindmapAssociationTargetType;
  target_id: LessonId | CourseId | string;
  created_at: string;
}

// =========================================================================
// PendingMindmapCard — 待整理卡池子 (辅助层, 不强制落图)
// =========================================================================

export type PendingCardSourceType = 'flashcard' | 'lesson_highlight' | 'exercise' | 'manual' | 'agent_seed' | 'annotation';
// 'annotation' — 划注一键入池 (批C)

export interface PendingMindmapCard {
  id: PendingCardId;
  owner_pair_id: PairId;
  title: string;
  content: string;
  source_type: PendingCardSourceType;
  source_id?: string;
  source_title?: string;
  placed_in_mindmap_id?: MindmapId; // null = 在池里, 有值 = 已落图
  reason?: string; // "fsrs_difficulty>7" / "learner_highlight" / "exercise_repeated_miss"
  created_at: string;
}
