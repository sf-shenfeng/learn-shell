// 7/19 t144test 入侵案。一个测试脚本的 DATABASE_URL 指向了
// `learn_shell`(生产库)而不是 `learn_shell_bench`(bench 库) —— 18 对
// 'Test Learner' / 'Test Agent' 测试数据(id 前缀 `pair_t144test_`)就这么
// 睡进了生产库。考场的考生睡进了咱家的床。
//
// 这个函数是那次事故之后补的硬闸门: 任何会在数据库里创建测试/specimen 数据
// 的入口(测试文件的 seed 步骤、bench 脚本等)在真正写库之前先调用它一次——
// 只要 DATABASE_URL 解析出来的库名不匹配 /_bench$/, 直接拒绝运行, 不静默
// 跳过、不猜、不放行。例外通道: 显式设 ALLOW_NON_BENCH_DB=1(仅用于确有意为
// 之的例外场景), 但会打一行刺眼的警告, 不会悄悄放过去。
//
// 只做"库名对不对"这一件事——DB 是否可达、是否要整体跳过测试,是调用方
// (before hook / RUN_DB_TESTS 门控)自己的事,这里不掺和。

const BENCH_DB_NAME_PATTERN = /_bench$/;

/** Best-effort extraction of the database name from a Postgres connection
 *  string. Falls back to the last path segment if `URL` parsing fails (e.g.
 *  a malformed or non-standard string) rather than throwing here — a garbled
 *  name still correctly fails the /_bench$/ check below. */
function extractDatabaseName(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    return parsed.pathname.replace(/^\//, '');
  } catch {
    const match = connectionString.match(/\/([^/?]+)(?:\?.*)?$/);
    return match?.[1] ?? '';
  }
}

/**
 * Refuse to proceed unless the effective DATABASE_URL points at a database
 * whose name ends in `_bench` — or ALLOW_NON_BENCH_DB=1 is explicitly set.
 *
 * @param connectionString effective DATABASE_URL for the entrypoint about to
 *   write test/specimen data (pass `process.env.DATABASE_URL` — do not fall
 *   back to any default here; an unset var must fail closed, since
 *   db/client.ts's own fallback happens to be the *production*-named db).
 * @param entrypoint short label for the caller (test file name, script name)
 *   — shows up in both the warning and the thrown error so it's obvious
 *   which entrypoint almost did it again.
 */
export function requireBenchDatabase(connectionString: string | undefined, entrypoint: string): void {
  const dbName = extractDatabaseName(connectionString ?? '');

  if (BENCH_DB_NAME_PATTERN.test(dbName)) return;

  const shownName = dbName || '(empty — DATABASE_URL unset or unparsable)';

  if (process.env.ALLOW_NON_BENCH_DB === '1') {
    console.warn(
      `⚠️  [${entrypoint}] ALLOW_NON_BENCH_DB=1 escape hatch in use — about to write test/specimen ` +
        `data into database "${shownName}", which does NOT match /_bench$/. This is exactly the shape ` +
        `of the 7/19 t144test incident (the exam hall's test-takers climbed straight into our family bed — a test script's ` +
        `DATABASE_URL pointed at "learn_shell" instead of "learn_shell_bench", and 18 'Test Learner/Test ` +
        `Agent' pairs, id prefix pair_t144test_, got written straight into production). Proceed only if ` +
        `this is a deliberate, exceptional use — not because the escape hatch was easier than fixing DATABASE_URL.`
    );
    return;
  }

  throw new Error(
    `[${entrypoint}] refused to run: DATABASE_URL resolves to database "${shownName}", which does not ` +
      `match /_bench$/. This guard exists because on 7/19 a test script's DATABASE_URL pointed at ` +
      `"learn_shell" (production) instead of "learn_shell_bench", and 18 'Test Learner/Test Agent' pairs ` +
      `(id prefix pair_t144test_) got written straight into the production database — the exam hall's ` +
      `test-takers climbed straight into our family bed. Point DATABASE_URL at a database whose name ends in "_bench", or set ` +
      `ALLOW_NON_BENCH_DB=1 to proceed anyway (exceptional use only — will still warn loudly).`
  );
}
