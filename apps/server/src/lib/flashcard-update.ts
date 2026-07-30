// update_flashcard core — 改卡面的合法通道。
//
// 外测实况: 验尺抓到卡面问题后, MCP 无 update_flashcard、REST PATCH 只放
// paused/deck_id — 改 front 无任何合法通道, 外测用户被迫直接裸写 DB
// (制度性红灯)。这里补的就是那扇门。
//
// 设计口径 (与 update_concept 同判例, 先例):
//   · 纯 patch 语义 — 只改给出的字段, 不建 revision 快照表 (concept 修订
//     同样无快照; 闪卡是复习原子不是教材正文, 不走 lesson_revisions 那套
//     "证据可见"仪式)。
//   · FSRS 调度状态不因编辑重置 — flashcards 表的调度事实全部住在
//     `fsrs_state` jsonb (due_at / stability / difficulty / last_review_at /
//     review_count / retrievability / state / lapses / scheduled_days, 见
//     lib/fsrs.ts + contracts/content.ts FSRSState) 与 `paused` 列。本模块的
//     UPDATE .set() 只碰 front/back/deck_id/updated_at 四列, 调度列一个不
//     进 patch — 编辑卡面不影响复习计划, 是结构保证不是运行时判断。
//   · 归属校验 — flashcards 自带 pair_id (闸同源), WHERE 直接
//     (id, pair_id) 双键命中: 不存在与不属于当前 pair 走同一个 NOT_FOUND,
//     不泄露他 pair 卡片的存在性。
//
// 拆成 lib 模块而不是全写在 mcp/server.ts case 里, 是既定判例 (live-wait /
// lesson-closure-facts 同族): mcp/server.ts import 时会开 stdio transport,
// 测试没法直接吃它 — 核心逻辑住这里, bench DB 测试直连。

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { flashcards, type FlashcardRow } from '../db/schema';
import { notFoundError, validationError } from './mcp-errors';

/** The only columns update_flashcard may touch. Scheduling state
 *  (fsrs_state, paused) is deliberately unreachable through this type. */
export interface FlashcardContentPatch {
  front?: string;
  back?: string;
  deck_id?: string;
}

const PATCHABLE_FIELDS = ['front', 'back', 'deck_id'] as const;

/** Pure — assembles the content patch from raw tool args, throwing
 *  VALIDATION for empty patches and non-string/blank values (front/back/
 *  deck_id are all NOT NULL columns; a blank would be a worse card, not a
 *  legal edit). Unit-testable without a DB. */
export function buildFlashcardContentPatch(args: Record<string, unknown>): FlashcardContentPatch {
  const patch: FlashcardContentPatch = {};
  for (const key of PATCHABLE_FIELDS) {
    const raw = args[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw validationError(
        `${key} must be a non-empty string when present — got ${JSON.stringify(raw)}. ` +
          "Clearing content out is not a valid card edit; if you don't want to change this field, don't pass it.",
        { field: key }
      );
    }
    patch[key] = raw;
  }
  if (Object.keys(patch).length === 0) {
    throw validationError(
      'At least one of front / back / deck_id is required — update_flashcard is a pure patch, ' +
        'you must include at least one content field to change.'
    );
  }
  return patch;
}

/** Applies a content patch to one flashcard, scoped to the calling pair.
 *  Returns the updated row + the field list that changed (for the receipt's
 *  修改字段清单). NOT_FOUND covers both "no such card" and "someone else's
 *  card" — one WHERE, one error, no existence leak. */
export async function updateFlashcardContent(
  pairId: string,
  flashcardId: string,
  patch: FlashcardContentPatch
): Promise<{ updated_fields: string[]; row: FlashcardRow }> {
  const updatedFields = PATCHABLE_FIELDS.filter((k) => patch[k] !== undefined);
  const [row] = await db
    .update(flashcards)
    // fsrs_state / paused are structurally absent from FlashcardContentPatch —
    // editing card content never reschedules or resets review progress.
    .set({ ...patch, updated_at: new Date() })
    .where(and(eq(flashcards.id, flashcardId), eq(flashcards.pair_id, pairId)))
    .returning();
  if (!row) {
    throw notFoundError(
      `Flashcard ${flashcardId} not found — the id may not exist, may have been deleted, or may not belong to the current pair. ` +
        'Use pair://flashcards/due or a lesson read-back to check existing card ids.',
      { flashcard_id: flashcardId }
    );
  }
  return { updated_fields: updatedFields, row };
}
