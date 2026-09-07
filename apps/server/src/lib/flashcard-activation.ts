// Lesson activation cache. Read-side eligibility is derived in flashcard-projection.ts.
// Completion may wake cards; submitting an exercise does not complete a lesson.
// The user's durable suspension setting is paused. No helper changes FSRS.
import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '../db/client';
import { concepts, flashcards } from '../db/schema';

/** New cards start out of review unless their lesson is already complete.
 * DB-aware creation paths use activatedForNewFlashcard for that case. */
export function defaultActivatedForConcept(_conceptId: string | null | undefined): boolean {
  return false;
}

/** isFlashcardInReviewQueue 只需要这三样, 不关心卡的其它字段。 */
export interface ReviewQueueCandidate {
  paused?: boolean | null;
  activated?: boolean | null;
  fsrs_state: { due_at: string | Date };
}

/**
 * 这张卡此刻该不该出现在复习队列里 —— 读侧唯一判据。
 *
 * 三道闸: 未激活不进 (课时门)、已暂停不进 (用户手动挂起)、还没到期不进。
 *
 * `activated` / `paused` 用 `!== false` 而不是直接取真值: 列是 NOT NULL
 * (DDL 默认 true/false), 但契约层两个字段都是可选的 (Flashcard.activated?/
 * paused?), 缺字段的调用方 (老 fixture、外部构造的对象) 按 DDL 默认解读,
 * 不因为"没写"就被静默踢出队列。
 */
export function isFlashcardInReviewQueue(card: ReviewQueueCandidate, nowMs: number): boolean {
  if (card.activated === false) return false;
  if (card.paused === true) return false;
  return new Date(card.fsrs_state.due_at).getTime() <= nowMs;
}

/**
 * 把某节课下所有还在休眠的闪卡唤醒。
 *
 * `UPDATE flashcards SET activated = true
 *    WHERE pair_id = ? AND activated = false
 *      AND concept_id IN (SELECT id FROM concepts WHERE lesson_id = ?)`
 *
 * - 只做 false→true, 永不反向 —— 用户手动休眠过的卡会被这条重新唤醒, 这是
 *   刻意的: 手动休眠的通道是 paused (PATCH /flashcards/:id 的既有语义),
 *   activated 表达的是"这节课学没学过"这件客观事实, 不是用户偏好。
 * - 幂等: WHERE activated = false 让重复调用命中 0 行。
 * - 返回真正被唤醒的条数 (0 = 本来就都醒着 / 这节课下没有卡)。
 *
 * @param dbClient db 或 tx —— 允许折进调用方的事务 (同 appendSessionEvent 的姿态)。
 */
export async function activateFlashcardsForLesson(
  dbClient: DbClient,
  pairId: string,
  lessonId: string
): Promise<number> {
  const conceptRows = await dbClient
    .select({ id: concepts.id })
    .from(concepts)
    .where(eq(concepts.lesson_id, lessonId));
  const conceptIds = conceptRows.map((r) => r.id);
  // 这节课下没有 concept ⇒ 没有课程卡可唤醒。提前返回而不是发一条
  // `IN ()` —— 空数组的 inArray 在 drizzle 里是个退化条件, 不值得赌它的行为。
  if (conceptIds.length === 0) return 0;

  const updated = await dbClient
    .update(flashcards)
    .set({ activated: true, updated_at: new Date() })
    .where(
      and(
        eq(flashcards.pair_id, pairId),
        eq(flashcards.activated, false),
        inArray(flashcards.concept_id, conceptIds)
      )
    )
    .returning({ id: flashcards.id });

  return updated.length;
}

/**
 * 课时完成触发点共用的"绝不炸主流程"外壳。
 *
 * 激活失败只留一行 warn —— 学习者按"我学完了"或老师收课的成败不该被
 * "顺手叫醒几张卡"绑架。下一次完成触发 (或人工跑回填脚本 /
 * PATCH activated) 还有机会补上。
 */
export async function tryActivateFlashcardsForLesson(
  dbClient: DbClient,
  pairId: string,
  lessonId: string,
  origin: string
): Promise<number> {
  try {
    return await activateFlashcardsForLesson(dbClient, pairId, lessonId);
  } catch (err) {
    console.warn(
      `[flashcard-activation] ${origin}: failed to activate flashcards for lesson ${lessonId} (pair ${pairId}) — main flow unaffected:`,
      err
    );
    return 0;
  }
}
