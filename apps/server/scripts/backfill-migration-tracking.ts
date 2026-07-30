#!/usr/bin/env -S npx tsx
/**
 * scripts/backfill-migration-tracking.ts — 补录 drizzle.__drizzle_migrations
 *
 * drizzle 迁移追踪表与 journal 脱钩时的修复工具。追踪表（drizzle.__drizzle_migrations）
 * 停在 26 行（对应 apps/server/drizzle/meta/_journal.json 里 idx 0~25，
 * 即 0000_unique_ultragirl.sql ~ 0025_contract_cadence.sql），但 journal 本身
 * 已经记到 45 条（idx 0~44，至 0044_evidence_channels.sql），且两库
 * （learn_shell / learn_shell_bench）实际 schema 也都已经手工 psql 到 0044。
 * 近期这些迁移全是手工执行 SQL、没人记进追踪表——于是官方
 * `drizzle-orm/postgres-js/migrator` 的 `migrate()` 一跑，会把 0026~0044
 * 这十九个已经在库里生效过的迁移当成"没跑过"，尝试重放，命中
 * "already exists" 之类的错误。这支脚本把追踪表补齐到与现实一致，
 * 让官方 `db:migrate` 恢复成一次真正的空跑。
 *
 * ── 追踪表结构 & 哈希口径（侦察自 drizzle-orm@0.36.4 源码，非猜测）──
 *
 * 表结构（node_modules/drizzle-orm/pg-core/dialect.js `migrate()`）：
 *   CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
 *     id SERIAL PRIMARY KEY,
 *     hash text NOT NULL,
 *     created_at bigint
 *   )
 * 判定"要不要跑"的逻辑只看一行：
 *   SELECT id, hash, created_at FROM ... ORDER BY created_at DESC LIMIT 1
 *   然后对 journal 里每条 entry，只要 entry.when > 那一行的 created_at 就重放。
 *   —— 注意：它从不会拿旧行的 hash 去跟当前文件重新算的 hash 做比对；
 *   hash 只是记录，不参与"要不要重放"的判断。这也是为什么下面第③点
 *   提到的历史脏数据不影响本次补录的正确性。
 *
 * hash 算法（node_modules/drizzle-orm/migrator.js `readMigrationFiles()`）：
 *   crypto.createHash('sha256').update(fs.readFileSync(`${tag}.sql`).toString()).digest('hex')
 *   —— 对迁移 SQL 文件的完整原始文本（drizzle-kit 生成的
 *   `--> statement-breakpoint` 分隔符也在文本里，一起进哈希，不是分段后
 *   再算）。created_at 存的是 journal 里该条目的 `when` 字段（毫秒时间戳，
 *   已经是 folderMillis 本身，不用再转换）。
 *
 * ── 复算验证（先在旧行上命中，再信这套口径）──
 *   对追踪表现有 26 行逐一用上面的算法复算：
 *     id 1~22（对应 0000~0021）：sha256(当前文件内容) 与库里存的 hash
 *     逐字节完全一致 —— 22/22 命中，确认口径无误。
 *     id 23~26（对应 0022_publish_gate / 0023_close_loop_no_cognitive_reason /
 *     0024_modality_declarations / 0025_contract_cadence）：hash 复算不命中，
 *     但 created_at 与 journal.when 精确对应。查了 git log 才知道原因——
 *     2026-07-23 那次全仓库注释外部化改写批次
 *     改写了这四个文件里各一行注释（纯注释，SQL 语句本身没变），文件字节
 *     变了，历史哈希自然对不上当前文件了。这不影响本次补录：
 *       (a) 这四行是"已存在的行"，任务要求原样不动；
 *       (b) 上面写的判定逻辑里 hash 从不被重新校验，只有 created_at
 *           参与判断，所以这段历史噪音不影响 db:migrate 变成空跑。
 *   新补的 0026~0044 这十九行，hash 就用【当前】文件内容现算——这正是
 *   下次任何人跑 db:migrate 时 readMigrationFiles() 会重新算出来的值，
 *   自洽，不需要还原成"当年"的字节。
 *
 * ── 用法 ──
 *   DATABASE_URL=postgresql://user:pass@host:5432/learn_shell_bench \
 *     npx tsx apps/server/scripts/backfill-migration-tracking.ts
 *
 *   DATABASE_URL 必须显式给出，没有任何硬编码默认值——防止在没传参数时
 *   意外接上生产库。这一点是刻意的，跟 apps/server/src/db/migrate.ts 或
 *   drizzle.config.ts 里"缺省回退到 learn_shell"的写法不一样，那两处的
 *   缺省口子不在这支脚本的修复范围内。
 *
 * ── 幂等性 ──
 *   每条 journal entry 补录前先按 created_at 精确匹配查一遍追踪表：
 *   已经存在同一个 created_at 的行就跳过，不新增、不更新、不删除。
 *   重复执行这支脚本结果不变。
 *
 * ── 验收 ──
 *   1) 跑完这支脚本：追踪表行数 26 → 45（新增 idx 26~44，共 19 行）。
 *   2) 跑官方 `pnpm --filter @learn-shell/server db:migrate`：应该是
 *      "没有任何迁移需要执行"的空跑（因为最新一行 created_at 已经
 *      ≥ journal 里最后一条 entry 的 when）。
 *
 * 本库是 self-host 项目，将来别的自托管用户如果也用手工 psql 应急
 * 打过几次补丁、追踪表跟 journal 脱钩了，这支脚本原样可以复用——
 * 前提一样：先读本文件头，理解哈希口径和"只补不改"的边界，再执行。
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// 0) 安全阀：DATABASE_URL 必须显式给出，绝不允许任何默认值兜底。
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    '[backfill] 缺少 DATABASE_URL —— 本脚本不提供任何默认连接串，必须显式指定目标库。\n' +
      '           用法: DATABASE_URL=postgresql://user:pass@host:5432/dbname npx tsx ' +
      'apps/server/scripts/backfill-migration-tracking.ts'
  );
  process.exit(1);
}

function redact(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    return `${u.protocol}//${u.username ? u.username + '@' : ''}${u.host}${u.pathname}`;
  } catch {
    return '(无法解析连接串——请检查格式)';
  }
}

console.log('[backfill] 目标库:', redact(DATABASE_URL));

// ---------------------------------------------------------------------------
// 1) 定位 drizzle 迁移目录（相对脚本自身位置解析，不依赖运行时 cwd）。
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '..', 'drizzle');
const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');

if (!existsSync(journalPath)) {
  throw new Error(`找不到 journal 文件: ${journalPath}`);
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

const journal: Journal = JSON.parse(readFileSync(journalPath, 'utf8'));

// ---------------------------------------------------------------------------
// 2) 哈希口径：与 drizzle-orm/migrator.js readMigrationFiles() 完全一致——
//    sha256(fs.readFileSync(`${tag}.sql`).toString()) 的十六进制摘要，
//    对整份文件原文（含 statement-breakpoint 分隔符），不是分段后再算。
// ---------------------------------------------------------------------------

function hashMigrationFile(tag: string): string {
  const sqlPath = path.join(migrationsFolder, `${tag}.sql`);
  if (!existsSync(sqlPath)) {
    throw new Error(`找不到迁移文件: ${sqlPath}`);
  }
  const raw = readFileSync(sqlPath).toString();
  return createHash('sha256').update(raw).digest('hex');
}

// ---------------------------------------------------------------------------
// 3) 补录主流程。
// ---------------------------------------------------------------------------

const sql = postgres(DATABASE_URL, { max: 1 });

async function main() {
  await sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`;
  await sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;

  const before = await sql`SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"`;
  console.log(`[backfill] 补录前行数: ${before[0].n}`);

  let inserted = 0;
  let skipped = 0;

  for (const entry of journal.entries) {
    const existing = await sql`
      SELECT id FROM "drizzle"."__drizzle_migrations" WHERE created_at = ${entry.when}
    `;
    if (existing.length > 0) {
      skipped++;
      continue;
    }

    const hash = hashMigrationFile(entry.tag);
    await sql`
      INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
      VALUES (${hash}, ${entry.when})
    `;
    inserted++;
    console.log(`[backfill] 补录 idx=${entry.idx} tag=${entry.tag} created_at=${entry.when} hash=${hash}`);
  }

  const after = await sql`SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"`;
  console.log(`[backfill] 补录后行数: ${after[0].n}（新增 ${inserted}，跳过已存在 ${skipped}）`);
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error('[backfill] 失败:', err);
    await sql.end();
    process.exit(1);
  });
