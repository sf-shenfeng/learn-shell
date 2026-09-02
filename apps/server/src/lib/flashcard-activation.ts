// apps/server/src/lib/flashcard-activation.ts — 闪卡激活门 (2026-09-02)。
//
// 病: 复习队列"全量涌入"。lib/fsrs.ts 的 newCardState() 让每张新卡
// due_at = now, 而三处 due 查询 (routes/read.ts 的 REST、mcp/server.ts 的
// pair://flashcards/due resource、apps/web 的 MockRepository) 只过滤
// pair_id + !paused + due_at<=now —— 零课时维度。给一门二十课的课程一次
// 备完卡, 第一天就有几百张"还没上过的课"的卡堵在复习队列门口。
//
// 药: flashcards.activated 这道课时闸 (迁移 0045)。三件事, 三个函数:
//
//   defaultActivatedForConcept —— 出生默认值。挂了 concept 的课程卡默认
//     休眠 (false, 等那一课被学完); concept_id 为空的卡默认激活 (true)。
//     后者不是宽容, 是必须: 导入卡/手写卡挂不上 concept, 也就永远等不到
//     激活那一刻, 默认 false 等于把它们永久埋掉。四条创建路径 (MCP
//     add_flashcard / REST POST /flashcards / 批量导入 / seed) 统一问它。
//
//   activateFlashcardsForLesson —— 唯一的唤醒入口。只做 false→true,
//     从不反向; 幂等 (WHERE activated = false 天然把重复调用变成 0 行)。
//     三个触发点调它: declare-completed (主锚)、live_session_complete
//     (context_type='lesson')、POST /submissions (经 exercise 反查 lesson)。
//     三处一律包 try/catch —— 激活是"顺手把该醒的卡叫醒", 不是主流程的
//     一部分; 它失败绝不能让学习者的"我学完了"或老师的收课失败。
//
//   isFlashcardInReviewQueue —— 读侧的唯一判据 (纯函数, DB-free)。
//     read.ts 与 mcp/server.ts 共用同一份, 免得两处 due 查询再次跑偏
//     (paused 那次就是: Mock 过滤了、REST 过滤了、MCP resource 漏了)。
//     apps/web 的 MockRepository 跨 package 引不到这里, 按 LS 既有纪律
//     镜像同一条判据 (Mock 与 Http 必须对齐)。
//
// 归属链: flashcards 表上没有 course_id/lesson_id, 课时归属只能走
// flashcards.concept_id → concepts.lesson_id (concept_id 可空、无外键,
// 同 scripts/remap-deck-lessons.ts 的映射路径)。

import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '../db/client';
import { concepts, flashcards } from '../db/schema';

/**
 * 新卡的 activated 默认值。
 *
 * 有 concept_id ⇒ 这是一张挂在某节课下的课程卡, 出生休眠, 等那节课被学完。
 * 无 concept_id ⇒ 挂不上课, 也就永远等不到激活; 出生即激活。
 */
export function defaultActivatedForConcept(conceptId: string | null | undefined): boolean {
  return conceptId == null || conceptId.trim() === '';
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
 * 三个触发点共用的"绝不炸主流程"外壳。
 *
 * 激活失败只留一行 warn —— 学习者按"我学完了"、老师收课、作业提交, 这三件
 * 事的成败不该被"顺手叫醒几张卡"绑架。下一次触发 (或人工跑回填脚本 /
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
