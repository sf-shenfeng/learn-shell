// lesson-state.ts — State 2.0 四轴单点 (迁移 0030 同批施工)。
//
// 全系统读"这节课教到哪了"的唯一入口 —— 仿 lib/currentContract.ts 先例: 一个
// 模块, 一份选择逻辑, 其余代码 (routes/read.ts 的课程/课清单 payload,
// lib/context-brief.ts 的 recent_lessons/contract_progress, 未来 MCP/web 两条
// 纵队的读点) 一律经这里取轴, 不许各自散装拼装。
//
// 四轴各自独立的事实源 —— 互不代算, 互不推导:
//   content        — 内容态: lessons.published_at 是否非空 (Publish
//                     Gate)。注意不是 lessons.status —— 那一列 (内容生成态,
//                     Stage 6b 遗留) 已被迁移 0030 拆除 (75 行全 null, 从未被
//                     真实写路径写过, 且与 lesson_progress.state 撞名, 是
//                     病根本身; 见 db/schema/content.ts lessons 表头注)。
//   revision       — lessons.revision, update_lesson 每次落笔递增的版本号
//                     (全轨自增, teaching+technical 都计入; 事实层不动)。
//   teaching_revision — 迁移 0033 (双轨修订): 只计 teaching 轨的"版本号" ——
//                     该课 lesson_revisions 里最新一条 kind='teaching' 的行
//                     对应的"替换后版本号" (row.revision + 1); 从无 teaching
//                     修订则为 1。展示层("已修订 vN"/"修订未读"判定)一律读
//                     这个字段, 不读 revision —— 技术修订(格式/门禁/重构/
//                     错别字)不推高它, 对学习者隐身。
//   revision_seen  — 学习者把这节课读到第几版了 (lesson_revision_seen, 迁移
//                     0030) —— 无行=null (从未读过任何一版), 不臆造"已读到
//                     当前版"。null 与 0 语义不同, 调用方比较时注意。仍记录
//                     全轨 revision (写入时机不变); 因 teaching_revision ≤
//                     revision 恒成立, 拿它与 teaching_revision 比较依旧
//                     成立, 不需要另开一条 "teaching_revision_seen"。
//   learning       — 教学闭环态: lesson_progress.state (not_started/
//                     in_progress/completed_declared/closed)。无行=
//                     'not_started' (合成态, 不预写行 —— 沿用 routes/read.ts
//                     synthesizedProgress 的既有惯例: 没人碰过的课不必为每个
//                     (pair, lesson) 组合预插一行)。
//   evaluated      — post_lesson_evaluations 是否已有该 (pair, lesson) 的行
//                     (迁移 0030 起一课一总评, 唯一索引 (pair_id, lesson_id))。
//   loop_closed    — learning === 'closed' 的布尔投影。单独暴露给不想比字符
//                     串常量的调用方 (例如书架/看板只关心"关没关课"的徽章),
//                     不是第五个独立事实源 —— 与 learning 轴同源, 变了一起变。
//
// 批量函数 (getLessonAxesForLessons) 是主入口: 一次渲染课程/课清单要给每课
// 带轴, 逐课查询是 N+1 (routes/read.ts fetchLessonProgressStates 已经踩过这
// 个坑, 这里不重蹈) —— 无论调用方传几个 lessonId, 固定 5 次查询 (lessons /
// lesson_progress / post_lesson_evaluations / lesson_revision_seen / 迁移
// 0033 新增的 lesson_revisions teaching 轨 max(revision) 分组聚合), 每次都用
// inArray 批量取。getLessonAxes(单课) 是它的薄包装, 内部就是批量函数传
// [lessonId] 再摘一条出来 —— 不是两套逻辑。
//
// dbClient 是第一个参数、无默认值 (呼应 lib/session-events.ts 的 DbClient 惯
// 例, 但那边把它放最后一位且给了默认值 `= db`; 这里刻意做成必填首位 —— 命名
// 契约由总设计师钦定, 逐字对齐, 好让 MCP 纵队 / 网页纵队按同一签名并行施工,
// 不必记"哪个模块默认哪个"这种细节)。调用方永远显式传 `db` 或某个
// `db.transaction(tx => ...)` 里的 `tx`。

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '../db/client';
import {
  lessons,
  lesson_progress,
  post_lesson_evaluations,
  lesson_revision_seen,
  lesson_revisions,
} from '../db/schema';
import type { LessonProgressState, LessonAxes } from '@learn-shell/contracts';

// LessonAxes 本体定义在 packages/contracts/src/progress.ts (apps/web 也要按
// 这份形状渲染, contracts 是两边都能导入的公共层) —— 这里 re-export, 好让
// "import type { LessonAxes } from '../lib/lesson-state'" 依旧成立, 单点读取
// 逻辑(这个模块)和单点类型定义(contracts)不必是同一个文件。
export type { LessonAxes };

/**
 * 批量取轴 — 全系统的 N+1 禁令落点。无论 lessonIds 有多少个, 固定 4 次查询。
 *
 * 返回的 Map 只含 `lessons` 表里真实存在的 lessonId (不存在的 id 静默不出现
 * 在结果里, 呼应 routes/read.ts fetchLessonProgressStates 对"查无此课"的处理
 * 方式 —— 由调用方决定"缺席"该怎么办, 这里不代为报错)。lessonIds 为空数组时
 * 直接返回空 Map, 不发起查询 (drizzle 的 inArray([]) 会是一次注定空转的查询)。
 */
export async function getLessonAxesForLessons(
  dbClient: DbClient,
  pairId: string,
  lessonIds: string[]
): Promise<Map<string, LessonAxes>> {
  if (lessonIds.length === 0) return new Map();

  const [lessonRows, progressRows, evalRows, seenRows, teachingRevMaxRows] = await Promise.all([
    dbClient
      .select({ id: lessons.id, revision: lessons.revision, published_at: lessons.published_at })
      .from(lessons)
      .where(inArray(lessons.id, lessonIds)),
    dbClient
      .select({ lesson_id: lesson_progress.lesson_id, state: lesson_progress.state })
      .from(lesson_progress)
      .where(and(eq(lesson_progress.pair_id, pairId), inArray(lesson_progress.lesson_id, lessonIds))),
    dbClient
      .select({ lesson_id: post_lesson_evaluations.lesson_id })
      .from(post_lesson_evaluations)
      .where(
        and(
          eq(post_lesson_evaluations.pair_id, pairId),
          inArray(post_lesson_evaluations.lesson_id, lessonIds)
        )
      ),
    dbClient
      .select({ lesson_id: lesson_revision_seen.lesson_id, revision: lesson_revision_seen.revision })
      .from(lesson_revision_seen)
      .where(
        and(eq(lesson_revision_seen.pair_id, pairId), inArray(lesson_revision_seen.lesson_id, lessonIds))
      ),
    // 迁移 0033 — teaching_revision 轴: 每课 teaching 轨最高的"被替换版本号"
    // (revision), 后面 +1 换算成"替换后版本号"。technical 轨的行完全不参与
    // 这次聚合, 是它对学习者隐身的落点。
    dbClient
      .select({
        lesson_id: lesson_revisions.lesson_id,
        max_revision: sql<number>`max(${lesson_revisions.revision})::int`,
      })
      .from(lesson_revisions)
      .where(and(eq(lesson_revisions.kind, 'teaching'), inArray(lesson_revisions.lesson_id, lessonIds)))
      .groupBy(lesson_revisions.lesson_id),
  ]);

  const learningByLesson = new Map<string, LessonProgressState>(
    progressRows.map((r) => [r.lesson_id, r.state])
  );
  const evaluatedLessons = new Set(evalRows.map((r) => r.lesson_id));
  const seenRevisionByLesson = new Map(seenRows.map((r) => [r.lesson_id, r.revision]));
  const teachingRevisionByLesson = new Map(
    teachingRevMaxRows.map((r) => [r.lesson_id, r.max_revision + 1])
  );

  const result = new Map<string, LessonAxes>();
  for (const row of lessonRows) {
    const learning: LessonProgressState = learningByLesson.get(row.id) ?? 'not_started';
    result.set(row.id, {
      content: row.published_at != null ? 'published' : 'draft',
      revision: row.revision,
      teaching_revision: teachingRevisionByLesson.get(row.id) ?? 1,
      revision_seen: seenRevisionByLesson.get(row.id) ?? null,
      learning,
      evaluated: evaluatedLessons.has(row.id),
      loop_closed: learning === 'closed',
    });
  }
  return result;
}

/**
 * 单课取轴 — getLessonAxesForLessons 的薄包装, 不是第二套逻辑。要求
 * lessonId 在 `lessons` 表里真实存在 (调用方已做过存在性 404 校验的场景, 例
 * 如 routes/write.ts 的既有风格) —— 查无此课时抛错, 不静默造一份假轴, 让"课
 * 不存在"这件事在调用点就近可见, 而不是伪装成某种合法的四轴组合。
 */
export async function getLessonAxes(
  dbClient: DbClient,
  pairId: string,
  lessonId: string
): Promise<LessonAxes> {
  const axesByLesson = await getLessonAxesForLessons(dbClient, pairId, [lessonId]);
  const axes = axesByLesson.get(lessonId);
  if (!axes) {
    throw new Error(`getLessonAxes: lesson not found — ${lessonId}`);
  }
  return axes;
}
