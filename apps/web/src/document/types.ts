// Document — local wire-shape type (批G).
//
// packages/contracts 只读 this batch (发包军规) — no shared `Document` type
// exists there yet, so this is the web-local stand-in, same move
// apps/web/src/annotation/orphan.ts's LessonAnnotationWithOrphan makes for
// orphaned_at/lesson_id-nullable. Server's row shape
// (apps/server/src/db/schema/document.ts DocumentRow) is the source of
// truth on the wire; this interface just names it for the web side.
// 正典化 (folding into packages/contracts as a real shared type) is left to
// 验收人 per the brief's file-domain rule.

import type { PairId } from '@learn-shell/contracts';

export type DocumentId = string & { readonly __brand: 'DocumentId' };

export type DocumentSource = 'paste' | 'upload' | 'mcp';

export interface Document {
  id: DocumentId;
  pair_id: PairId;
  title: string;
  content_md: string;
  source: DocumentSource;
  created_at: string;
  updated_at: string;
}

/** Lightweight projection — RecentRail's "最近文档" row and the Reading list
 *  page's row cards never need the full content_md just to render a title +
 *  timestamp (same "count endpoint" thrift the annotations/count route
 *  already established — brief §4 门牌 item). */
export interface DocumentSummary {
  id: DocumentId;
  title: string;
  updated_at: string;
}
