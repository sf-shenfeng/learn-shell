#!/usr/bin/env -S npx tsx
/**
 * scripts/remap-deck-lessons.ts — 把课程级大桶闪卡组按 lesson 拆分
 *
 * 现状：cfa-en-econ / cfa-en-corp / cfa-en-deriv / cfa-en-equity 四个 deck
 * 是"整课一个大桶"，全项目其余课程的惯例是"每课一组"，命名
 * `<courseSlug>-NN`（NN = 该课在其 course 下的 lessons.order，两位补零）。
 * 这支脚本把四个大桶拆开，写回 flashcards.deck_id。
 *
 * 映射路径：flashcards.concept_id → concepts.lesson_id → lessons.order。
 * 拿不到这条链的卡（concept_id 为空，或 concept_id/lesson_id 指向的行
 * 找不到）一律进 UNMAPPED 清单，不猜、不动，等人工归类。
 *
 * 用法：
 *   DATABASE_URL=postgresql://user:pass@host:5432/db npx tsx scripts/remap-deck-lessons.ts
 *     —— dry-run（默认）：打印完整映射表 + UNMAPPED 清单 + 汇总，不写库。
 *   DATABASE_URL=... npx tsx scripts/remap-deck-lessons.ts --apply
 *     —— 实际写库（事务）。
 *
 * 幂等：查询同时兜住"已经是 `<base>-NN` 形状"的卡（防御性——正常情况下
 * 基础四个 deck_id 一旦改名就不会再匹配 base 精确匹配这支查询本身），这些
 * 卡直接归为"已迁移，跳过"，dry-run 打印、--apply 不改。重复跑 --apply
 * 结果不变。
 *
 * 连接方式仿照仓库根 scripts/validate-prep.ts 的写法（DATABASE_URL 必须
 * 显式给出，缺失就报错退出，不允许硬编码兜底连接串）。那支脚本挂在仓库根
 * scripts/ 下，要用 createRequire 越过 pnpm 的 shamefully-hoist=false 去
 * apps/server/node_modules 里找 postgres 包；这支脚本本来就住在
 * apps/server/scripts/ 下，是 @learn-shell/server 这个 package 自己的文件，
 * `postgres` 已经是它的直接依赖（见 apps/server/package.json），可以直接
 * import，不需要那层越权解析。
 *
 * 只读安全：不 --apply 就绝不会执行任何 UPDATE。
 */

import postgres from 'postgres';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 只处理这四个大桶 deck —— brief 点名的范围，不外溢到其他 deck。 */
const TARGET_BASE_DECKS = ['cfa-en-econ', 'cfa-en-corp', 'cfa-en-deriv', 'cfa-en-equity'] as const;

/** 已经是 `<base>-NN` 形状的 deck_id —— 视为"已迁移"，幂等跳过。 */
const ALREADY_MIGRATED_RE = /^(cfa-en-(?:econ|corp|deriv|equity))-\d{2,}$/;

/** flashcards.front 在映射表里只打印前 40 字（UNMAPPED 清单打印全文）。 */
const FRONT_PREVIEW_LEN = 40;

/**
 * 跨课程重名豁免：老预备课（crs_mri1tbks_igwzwm）九课全是话题式卡组命名，
 * 其第 9 课 "Equity Deep Dive" 的户口本来就是 `cfa-en-equity`（6 张）——
 * 是新 Equity 十日课的 60 张卡后来按名字撞进了同一个桶。老课的卡已经在家，
 * 一张都不许动；按 lesson 所属 course 识别并跳过。
 */
const HOME_DECK_COURSES = ['crs_mri1tbks_igwzwm'] as const;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: string;
  front: string;
  deck_id: string;
  concept_id: string | null;
  concept_lesson_id: string | null;
  lesson_id: string | null;
  lesson_title: string | null;
  lesson_order: number | null;
  lesson_course_id: string | null;
}

type UnmappedReason = 'no_concept_id' | 'concept_not_found' | 'lesson_not_found';

interface MappedCard {
  id: string;
  front: string;
  oldDeckId: string;
  newDeckId: string;
  lessonTitle: string;
}

interface SkippedCard {
  id: string;
  front: string;
  deckId: string;
}

interface UnmappedCard {
  id: string;
  front: string;
  deckId: string;
  reason: UnmappedReason;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function preview(text: string, len: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > len ? `${t.slice(0, len)}…` : t;
}

function reasonLabel(reason: UnmappedReason): string {
  switch (reason) {
    case 'no_concept_id':
      return 'concept_id 为空';
    case 'concept_not_found':
      return 'concept_id 指向的 concept 不存在';
    case 'lesson_not_found':
      return 'concept.lesson_id 指向的 lesson 不存在';
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('缺少 DATABASE_URL 环境变量。用法示例：');
    console.error('  DATABASE_URL=postgresql://user:pass@host:5432/db npx tsx scripts/remap-deck-lessons.ts [--apply]');
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 2 });

  try {
    // 一条查询把"基础四个大桶"和"疑似已经改名过的 <base>-NN"都捞出来，
    // 后者只是为了防御性识别、幂等打印，不会再被当成待迁移对象处理。
    const rows = (await sql`
      select
        f.id                as id,
        f.front             as front,
        f.deck_id           as deck_id,
        f.concept_id        as concept_id,
        c.lesson_id         as concept_lesson_id,
        l.id                as lesson_id,
        l.title             as lesson_title,
        l."order"           as lesson_order,
        l.course_id         as lesson_course_id
      from flashcards f
      left join concepts c on c.id = f.concept_id
      left join lessons l on l.id = c.lesson_id
      where f.deck_id = ANY(${TARGET_BASE_DECKS})
         or f.deck_id ~ ${'^(cfa-en-(?:econ|corp|deriv|equity))-[0-9]{2,}$'}
      order by f.deck_id, f.id
    `) as unknown as CandidateRow[];

    const mapped: MappedCard[] = [];
    const skipped: SkippedCard[] = [];
    const unmapped: UnmappedCard[] = [];

    for (const row of rows) {
      // 已经是 <base>-NN 形状 —— 幂等跳过，不重新计算、不二次改名。
      if (ALREADY_MIGRATED_RE.test(row.deck_id)) {
        skipped.push({ id: row.id, front: row.front, deckId: row.deck_id });
        continue;
      }

      // 只处理四个基础大桶本身；理论上到这里只会是它们（上面已经把
      // 已改名的分流掉了），但仍显式校验，避免正则/查询以外的意外输入。
      if (!(TARGET_BASE_DECKS as readonly string[]).includes(row.deck_id)) {
        continue;
      }

      if (!row.concept_id) {
        unmapped.push({ id: row.id, front: row.front, deckId: row.deck_id, reason: 'no_concept_id' });
        continue;
      }
      if (!row.concept_lesson_id) {
        // concept_id 存在但左联到 concepts 没找到行（外键理论上不该发生，防御性兜底）。
        unmapped.push({ id: row.id, front: row.front, deckId: row.deck_id, reason: 'concept_not_found' });
        continue;
      }
      if (!row.lesson_id || row.lesson_order === null) {
        unmapped.push({ id: row.id, front: row.front, deckId: row.deck_id, reason: 'lesson_not_found' });
        continue;
      }

      // 老课程话题式卡组的原住民——当前 deck_id 就是它们的户口，跳过不动。
      if (row.lesson_course_id && (HOME_DECK_COURSES as readonly string[]).includes(row.lesson_course_id)) {
        skipped.push({ id: row.id, front: row.front, deckId: row.deck_id });
        continue;
      }

      const newDeckId = `${row.deck_id}-${pad2(row.lesson_order)}`;
      mapped.push({
        id: row.id,
        front: row.front,
        oldDeckId: row.deck_id,
        newDeckId,
        lessonTitle: row.lesson_title ?? '(无标题)',
      });
    }

    // ------------------------------------------------------------------
    // 打印映射表
    // ------------------------------------------------------------------
    console.log(`=== 映射表（${mapped.length} 张卡） ===`);
    console.log(
      ['card_id', 'front', 'old_deck', 'new_deck', 'lesson_title']
        .join(' | ')
    );
    for (const m of mapped) {
      console.log(
        [m.id, preview(m.front, FRONT_PREVIEW_LEN), m.oldDeckId, m.newDeckId, m.lessonTitle].join(' | ')
      );
    }

    if (skipped.length > 0) {
      console.log('');
      console.log(`=== 已迁移，幂等跳过（${skipped.length} 张卡） ===`);
      for (const s of skipped) {
        console.log(`${s.id} | ${preview(s.front, FRONT_PREVIEW_LEN)} | ${s.deckId}`);
      }
    }

    console.log('');
    console.log(`=== UNMAPPED（${unmapped.length} 张卡，不动、不猜，等人工归类） ===`);
    for (const u of unmapped) {
      console.log(`--- ${u.id} | 原 deck: ${u.deckId} | 原因: ${reasonLabel(u.reason)} ---`);
      console.log(u.front);
      console.log('');
    }

    // ------------------------------------------------------------------
    // 汇总
    // ------------------------------------------------------------------
    const byNewDeck = new Map<string, number>();
    for (const m of mapped) {
      byNewDeck.set(m.newDeckId, (byNewDeck.get(m.newDeckId) ?? 0) + 1);
    }
    console.log('=== 汇总：新 deck 张数 ===');
    for (const [deckId, count] of [...byNewDeck.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`${deckId}: ${count}`);
    }
    console.log('');
    console.log(
      `合计：待迁移 ${mapped.length} 张 · 已迁移(跳过) ${skipped.length} 张 · UNMAPPED ${unmapped.length} 张`
    );

    // ------------------------------------------------------------------
    // 写库（仅 --apply）
    // ------------------------------------------------------------------
    if (apply) {
      if (mapped.length === 0) {
        console.log('');
        console.log('没有需要写库的卡（全部已迁移或 UNMAPPED）。');
      } else {
        console.log('');
        console.log(`--apply：开始写库，共 ${mapped.length} 张卡...`);
        await sql.begin(async (tx) => {
          for (const m of mapped) {
            await tx`
              update flashcards
              set deck_id = ${m.newDeckId}, updated_at = now()
              where id = ${m.id}
            `;
          }
        });
        console.log('写库完成。');
      }
    } else {
      console.log('');
      console.log('dry-run（默认）：未写库。加 --apply 才会实际更新 flashcards.deck_id。');
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}

main().catch((err) => {
  console.error('remap-deck-lessons 运行失败:', err);
  process.exit(2);
});
