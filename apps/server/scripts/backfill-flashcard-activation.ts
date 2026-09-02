#!/usr/bin/env -S npx tsx
/**
 * scripts/backfill-flashcard-activation.ts — 存量闪卡的激活门回填
 *
 * 迁移 0045 给 flashcards 加了 activated 列, DDL 默认 true —— 加列这一刻
 * 库里所有卡都是"醒着的", 结构变了但行为一点没变(刻意的: 默认 false 会把
 * 存量卡一夜之间全部踢出复习队列)。这支脚本负责那件迁移故意没做的事:
 * 按业务规则判断哪些存量卡其实该休眠, 然后 --apply 才落笔。
 *
 * 休眠规则(五条全中才休眠, 缺一条就保持激活 —— 宁可多醒一张, 不许错埋一张):
 *   1. 有 concept → lesson 链 (flashcards.concept_id → concepts.lesson_id,
 *      两跳都能落到真实行)。挂不上课的卡永远醒着 —— 它们等不到激活那道门。
 *   2. 该课在本 pair 下**没有** lesson_progress.state ∈
 *      ('completed_declared', 'closed')  —— 没人宣布学完过。
 *   3. 该课下**没有任何** exercise_submissions  —— 没人交过这节课的作业。
 *   4. 该课在本 pair 下**没有** status='completed' 且 context_type='lesson'
 *      的 live_sessions  —— 没上过这节课的 Live。
 *   5. 这张卡自己 (fsrs_state->>'review_count')::int = 0  —— 从没被复习过。
 *      复习过的卡等于学习者已经在用它了, 不管课时状态怎么写, 都不许休眠。
 *
 * 幂等: 只翻"当前值 ≠ 目标值"的行 (dormant 目标 false 的行里只 UPDATE
 * activated = true 的那些; 其余一律不碰)。重复跑 --apply 第二次命中 0 行。
 * 注意这支脚本**只做 true→false**: 已经被休眠的卡不会被它翻回 true ——
 * 唤醒是 lib/flashcard-activation.ts 三个触发点的职责, 回填不抢那份工作,
 * 也就不会把人工/自动激活过的卡再按回去。
 *
 * 用法:
 *   DATABASE_URL=postgresql://user:pass@host:5432/db npx tsx scripts/backfill-flashcard-activation.ts
 *     —— dry-run(默认): 按课列出将休眠/保持激活的卡数 + 保持激活的原因分布,
 *        不写库。
 *   DATABASE_URL=... npx tsx scripts/backfill-flashcard-activation.ts --apply
 *     —— 实际写库(单事务)。
 *
 * 安全: DATABASE_URL 必须显式给出, 无缺省(同 scripts/remap-deck-lessons.ts
 * 与 db/client.ts 的"缺失即拒"); flashcards 表或 activated 列不存在即 abort
 * (迁移没跑就别谈回填); 不 --apply 就绝不执行任何 UPDATE。
 */

import postgres from 'postgres';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 保持激活的原因 —— dry-run 里按原因分布打印, 让人一眼看出"这 300 张为什么不动"。 */
type KeepReason =
  | 'no_concept_link' // 规则1 不满足: concept_id 空 / concept 或 lesson 找不到
  | 'lesson_declared_or_closed' // 规则2
  | 'lesson_has_submissions' // 规则3
  | 'lesson_has_completed_live' // 规则4
  | 'card_reviewed'; // 规则5

interface CardRow {
  id: string;
  pair_id: string;
  deck_id: string;
  concept_id: string | null;
  lesson_id: string | null;
  lesson_title: string | null;
  course_id: string | null;
  activated: boolean;
  review_count: number;
  lesson_declared_or_closed: boolean;
  lesson_has_submissions: boolean;
  lesson_has_completed_live: boolean;
}

interface LessonBucket {
  lessonId: string;
  lessonTitle: string;
  courseId: string;
  toDormant: number; // 将被休眠(当前 true → 目标 false)
  alreadyDormant: number; // 目标 false 且当前已是 false —— 幂等跳过
  keep: number; // 保持激活
  keepReasons: Map<KeepReason, number>;
}

const KEEP_REASON_LABEL: Record<KeepReason, string> = {
  no_concept_link: '挂不上课(concept/lesson 链断) —— 永远激活',
  lesson_declared_or_closed: '该课已宣布学完/已回课',
  lesson_has_submissions: '该课下有作业提交',
  lesson_has_completed_live: '该课有已完成的 Live 场',
  card_reviewed: '这张卡复习过(review_count > 0)',
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('缺少 DATABASE_URL 环境变量。用法示例:');
    console.error(
      '  DATABASE_URL=postgresql://user:pass@host:5432/db npx tsx scripts/backfill-flashcard-activation.ts [--apply]'
    );
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 2 });

  try {
    // --- 前置: 表与列必须在 (迁移 0045 跑过) ---
    const [colCheck] = (await sql`
      select count(*)::int as n
      from information_schema.columns
      where table_name = 'flashcards' and column_name = 'activated'
    `) as unknown as [{ n: number }];
    if (!colCheck || colCheck.n === 0) {
      console.error(
        'abort: flashcards.activated 列不存在 —— 迁移 0045 还没在这个库上跑过。先 db:migrate, 再回填。'
      );
      process.exit(1);
    }

    // --- 一条查询把五条规则需要的事实全捞出来 ---
    //
    // 规则 2/3/4 是"课级"事实, 用 EXISTS 子查询逐卡求值(卡数在千级, 一次
    // 全表扫 + 三个半连接远比逐课 round-trip 划算, 也不必先查一遍课再查卡)。
    // 归属口径:
    //   lesson_progress  — 自带 pair_id, 按 (pair_id, lesson_id) 匹配
    //   exercise_submissions — 经 exercises.lesson_id 反查(与 routes/write.ts
    //     的触发点③同一条链); 不再按 pair 二次过滤 —— submissions 挂
    //     learner 不挂 pair, 而"这节课有人交过作业"本身就是学过的证据
    //   live_sessions    — 自带 pair_id, context_type='lesson' 时 context_id
    //     即 lesson_id(与 mcp/server.ts 触发点②同一口径)
    const rows = (await sql`
      select
        f.id                                            as id,
        f.pair_id                                       as pair_id,
        f.deck_id                                       as deck_id,
        f.concept_id                                    as concept_id,
        f.activated                                     as activated,
        coalesce((f.fsrs_state->>'review_count')::int, 0) as review_count,
        l.id                                            as lesson_id,
        l.title                                         as lesson_title,
        l.course_id                                     as course_id,
        exists (
          select 1 from lesson_progress lp
          where lp.pair_id = f.pair_id
            and lp.lesson_id = l.id
            and lp.state in ('completed_declared', 'closed')
        )                                               as lesson_declared_or_closed,
        exists (
          select 1
          from exercise_submissions es
          join exercises e on e.id = es.exercise_id
          where e.lesson_id = l.id
        )                                               as lesson_has_submissions,
        exists (
          select 1 from live_sessions ls
          where ls.pair_id = f.pair_id
            and ls.context_type = 'lesson'
            and ls.context_id = l.id
            and ls.status = 'completed'
        )                                               as lesson_has_completed_live
      from flashcards f
      left join concepts c on c.id = f.concept_id
      left join lessons  l on l.id = c.lesson_id
      order by l.course_id nulls last, l.id nulls last, f.id
    `) as unknown as CardRow[];

    // --- 分类 ---
    const buckets = new Map<string, LessonBucket>();
    const globalKeepReasons = new Map<KeepReason, number>();
    const toDormantIds: string[] = [];
    let noLinkKeep = 0;
    let alreadyDormantTotal = 0;

    function bucketFor(row: CardRow): LessonBucket {
      const lessonId = row.lesson_id ?? '(无课时)';
      let b = buckets.get(lessonId);
      if (!b) {
        b = {
          lessonId,
          lessonTitle: row.lesson_title ?? '(挂不上课的卡)',
          courseId: row.course_id ?? '(无课程)',
          toDormant: 0,
          alreadyDormant: 0,
          keep: 0,
          keepReasons: new Map(),
        };
        buckets.set(lessonId, b);
      }
      return b;
    }

    function noteKeep(b: LessonBucket, reason: KeepReason) {
      b.keep++;
      b.keepReasons.set(reason, (b.keepReasons.get(reason) ?? 0) + 1);
      globalKeepReasons.set(reason, (globalKeepReasons.get(reason) ?? 0) + 1);
    }

    for (const row of rows) {
      const b = bucketFor(row);

      // 规则1 —— 链断即保持激活, 不猜归属(同 remap-deck-lessons 的 UNMAPPED 姿态)。
      if (!row.concept_id || !row.lesson_id) {
        noteKeep(b, 'no_concept_link');
        noLinkKeep++;
        continue;
      }
      // 规则5 优先于 2/3/4 报告 —— 复习过是最强的"她已经在用这张卡"信号。
      if (row.review_count > 0) {
        noteKeep(b, 'card_reviewed');
        continue;
      }
      if (row.lesson_declared_or_closed) {
        noteKeep(b, 'lesson_declared_or_closed');
        continue;
      }
      if (row.lesson_has_submissions) {
        noteKeep(b, 'lesson_has_submissions');
        continue;
      }
      if (row.lesson_has_completed_live) {
        noteKeep(b, 'lesson_has_completed_live');
        continue;
      }

      // 五条全中 ⇒ 目标 false。当前已经是 false 的幂等跳过, 不进 UPDATE 名单。
      if (row.activated === false) {
        b.alreadyDormant++;
        alreadyDormantTotal++;
        continue;
      }
      b.toDormant++;
      toDormantIds.push(row.id);
    }

    // --- 打印: 按课列出 ---
    console.log(`=== 按课时统计 (共 ${rows.length} 张卡 / ${buckets.size} 个课时桶) ===`);
    console.log(['course_id', 'lesson_id', 'lesson_title', '将休眠', '已休眠(跳过)', '保持激活'].join(' | '));
    const ordered = [...buckets.values()].sort((a, b) =>
      a.courseId === b.courseId ? a.lessonId.localeCompare(b.lessonId) : a.courseId.localeCompare(b.courseId)
    );
    for (const b of ordered) {
      console.log(
        [b.courseId, b.lessonId, b.lessonTitle, b.toDormant, b.alreadyDormant, b.keep].join(' | ')
      );
      if (b.keep > 0) {
        for (const [reason, n] of [...b.keepReasons.entries()].sort(([a], [c]) => a.localeCompare(c))) {
          console.log(`    ↳ 保持激活 ${n} 张 · ${KEEP_REASON_LABEL[reason]}`);
        }
      }
    }

    // --- 汇总 ---
    const keepTotal = rows.length - toDormantIds.length - alreadyDormantTotal;
    console.log('');
    console.log('=== 保持激活的原因分布 (全库) ===');
    for (const [reason, n] of [...globalKeepReasons.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`${KEEP_REASON_LABEL[reason]}: ${n}`);
    }
    console.log('');
    console.log(
      `合计: 将休眠 ${toDormantIds.length} 张 · 已休眠(幂等跳过) ${alreadyDormantTotal} 张 · ` +
        `保持激活 ${keepTotal} 张 (其中挂不上课的 ${noLinkKeep} 张)`
    );

    // --- 写库(仅 --apply) ---
    if (apply) {
      if (toDormantIds.length === 0) {
        console.log('');
        console.log('没有需要写库的卡(全部已休眠或应保持激活)。');
      } else {
        console.log('');
        console.log(`--apply: 开始写库, 共 ${toDormantIds.length} 张卡休眠...`);
        await sql.begin(async (tx) => {
          // WHERE activated = true 是第二道幂等闸(名单是上面算的, 这里再挡
          // 一次并发写入把卡翻成 false 的情况 —— 只翻真的还醒着的行)。
          await tx`
            update flashcards
            set activated = false, updated_at = now()
            where id = any(${toDormantIds}) and activated = true
          `;
        });
        console.log('写库完成。');
      }
    } else {
      console.log('');
      console.log('dry-run(默认): 未写库。加 --apply 才会实际更新 flashcards.activated。');
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}

main().catch((err) => {
  console.error('backfill-flashcard-activation 运行失败:', err);
  process.exit(2);
});
