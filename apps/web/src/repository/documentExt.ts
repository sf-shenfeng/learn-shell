// Document repository extension — 批G.
//
// Deliberately NOT folded into packages/contracts/src/repository.ts (发包
// 军规: contracts read-only this batch) — same local-additive-interface move
// apps/web/src/repository/journalExt.ts's JournalRepo already makes.
// Concrete repos (Mock/Http) implement `Repository & DocumentRepo` (plus
// every other extension interface); callers narrow via
// apps/web/src/document/useDocumentRepo.ts, mirroring journal/useJournalNotes.ts's
// useJournalRepo().

import type { AnnotationColorKey, PairId } from '@learn-shell/contracts';
import type { LessonAnnotationWithOrphan } from '../annotation/orphan';
import type { Document, DocumentId, DocumentSource, DocumentSummary } from '../document/types';

export interface DocumentRepo {
  /** Full list for a pair, most-recently-updated first — Reading 列表页. */
  getDocuments(pair_id: PairId): Promise<Document[]>;
  getDocument(id: DocumentId): Promise<Document | null>;
  /** Web 粘贴/上传两通道共用 (brief §3 item 1) — `source` distinguishes them;
   *  `filename` (upload only) only feeds server-side title derivation, never
   *  persisted. `title` omitted/blank → derived from content_md (brief §2). */
  createDocument(input: {
    pair_id: PairId;
    title?: string;
    content_md: string;
    source: DocumentSource;
    filename?: string;
  }): Promise<Document>;
  /** A content_md change re-sweeps this document's annotations server-side
   *  (brief §3 item 3) — same resweep-on-write shape update_lesson's REST/MCP
   *  paths already established for lessons. */
  updateDocument(id: DocumentId, patch: { title?: string; content_md?: string }): Promise<Document>;
  deleteDocument(id: DocumentId): Promise<void>;
  /** 轻量计数端点手法 (参照 annotations/count 端点) — RecentRail's "最近文档" row only
   *  ever needs id/title/updated_at for the single most-recent document, not
   *  the full list.getDocuments()'s full rows. */
  getRecentDocuments(pair_id: PairId, limit?: number): Promise<DocumentSummary[]>;

  // -------- Document-hosted annotations (学习机器换宿主, brief §5) --------
  getAnnotationsForDocument(document_id: DocumentId): Promise<LessonAnnotationWithOrphan[]>;
  /** Documents don't page (brief §4, continuous scroll) — no page_index in
   *  the input, unlike createAnnotation's lesson counterpart; the server
   *  always writes page_index 0 for document-hosted rows. */
  createDocumentAnnotation(input: {
    pair_id: PairId;
    document_id: DocumentId;
    selected_text: string;
    prefix: string;
    suffix: string;
    color?: AnnotationColorKey;
    note?: string | null;
  }): Promise<LessonAnnotationWithOrphan>;
}
