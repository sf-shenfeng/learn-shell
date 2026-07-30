// Recents 最近接触 —— 从事件流里挑"她最近碰的是哪一个"的纯函数。
//
// 这几个原本内联在 shell/RecentRail.tsx 顶部。二期 (2026-07-30) 拆出来的唯一
// 理由是**可测**: web 的测试跑的是 `tsx --test "src/**/*.test.ts"`, 只吃 .ts,
// 进不了 .tsx; 而"存量事件没有 course_id 就跳过"这条向后兼容规则正是最该被机
// 器盯住的一条 —— 它一旦失效, 表现是左栏悄悄指错课, 不报错、不崩、没人发现。
// 逻辑一行未改, 只是换了个住处 (见 recentSignals.test.ts)。
//
// 三个函数同一个形状: 扫一遍事件, 按 occurred_at 取最大的那条, 没有就返回
// undefined —— 调用方据此回落到各自的存量兜底。都不假设入参有序 (RecentRail
// 把好几场 session 的事件拍平成一条流喂进来)。

import type { CourseId, LessonProgress, SessionEvent } from '@learn-shell/contracts';

/** Most recent `lesson.viewed` event's lesson_id across the given events, by
 *  `occurred_at`. Undefined if there's no such event yet (e.g. the learner
 *  hasn't finished 3s dwell on any page — PagedLesson drops sub-3s views).
 *  Returns the timestamp too — 最近接触 takes the newer of this and the
 *  lesson_progress footprint below, so the caller needs both halves. */
export function latestViewedLesson(
  events: SessionEvent[] | undefined
): { lessonId: string; at: string } | undefined {
  let best: { lessonId: string; at: string } | undefined;
  for (const e of events ?? []) {
    if (e.event_type !== 'lesson.viewed') continue;
    if (!best || e.occurred_at > best.at) {
      best = { lessonId: e.payload.lesson_id, at: e.occurred_at };
    }
  }
  return best;
}

/** 最近接触二期 (2026-07-30): 最新一条**带 course_id** 的 `lesson.viewed` 指
 *  向的课程。Lesson 行原本认活跃契约的 course_id —— 契约不换课, 这行就永远
 *  指着同一门, 读了别的课回来左栏纹丝不动 (学习者实测裁决)。
 *
 *  `course_id` 是 2026-07-30 才加进 payload 的可选字段, 在此之前写下的事件没
 *  有它 (不迁移不回填, session_events.payload 是 text 列)。所以这里显式跳过
 *  缺字段的旧事件 —— 一条都没有时调用方回落到既有的"契约课程 → 最新创建课
 *  程"兜底, 与改前逐位相同。 */
export function latestViewedCourse(
  events: SessionEvent[] | undefined
): { courseId: CourseId; at: string } | undefined {
  let best: { courseId: CourseId; at: string } | undefined;
  for (const e of events ?? []) {
    if (e.event_type !== 'lesson.viewed') continue;
    const courseId = e.payload.course_id;
    if (!courseId) continue; // 存量事件: 没有这个字段, 跳过
    if (!best || e.occurred_at > best.at) {
      best = { courseId, at: e.occurred_at };
    }
  }
  return best;
}

/** 最近接触二期: 最新一条 `review.viewed` —— 她最近复习的是哪一组卡。
 *  和上面两个同构; 同样容忍"一条都没有"(新账号 / 从没打开过 Review 页), 那时
 *  Review 行退回纯到期计数文案, 与改前逐位相同。
 *
 *  `deck_id` 为 null 表示她当时停在"全部到期"而不是某一组具体的卡 —— 那没有
 *  可显示的名字也没有可深链的对象, 调用方同样退回原文案。 */
export function latestViewedDeck(
  events: SessionEvent[] | undefined
): { deckId: string; at: string } | undefined {
  let best: { deckId: string; at: string } | undefined;
  for (const e of events ?? []) {
    if (e.event_type !== 'review.viewed') continue;
    const deckId = e.payload.deck_id;
    if (!deckId) continue; // 'all due' 那一档: 没有具体对象可显示
    if (!best || e.occurred_at > best.at) {
      best = { deckId, at: e.occurred_at };
    }
  }
  return best;
}

/** 第二根信号 (最近接触): `lesson_progress.updated_at` — 每次翻页/首次打开都
 *  ping 一次 (POST /lessons/:id/progress/touch), 跨 session 存活, 补上
 *  `lesson.viewed` 只在 sessions 事件里找得到的那半。`not_started` 的行
 *  (以及服务端合成出来的空行, updated_at 为 null) 不算接触过。 */
export function latestTouchedLesson(
  progress: LessonProgress[] | undefined
): { lessonId: string; at: string } | undefined {
  let best: { lessonId: string; at: string } | undefined;
  for (const p of progress ?? []) {
    if (p.state === 'not_started' || !p.updated_at) continue;
    if (!best || p.updated_at > best.at) {
      best = { lessonId: p.lesson_id, at: p.updated_at };
    }
  }
  return best;
}
