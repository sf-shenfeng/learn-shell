// DATABASE_URL 单点解析: 无缺省, 缺失即拒。
//
// 为什么不给缺省值: 任何缺省都是替调用者做了一个他不知情的决定。而一个指向
// 真实库名的缺省更进一步——它让"我以为连的是测试库"和"我实际连的是生产库"
// 可以同时为真: 忘设环境变量的 db 命令不会报错, 只会安静地打中另一个库。
// 迁移与结构变更这类操作不可逆, 打错了没有撤销键。
//
// 代价是第一次运行会撞一堵墙("DATABASE_URL is required")。这堵墙是故意的:
// 撞在第一次, 比在第一百次才发现一直打错库便宜得多。
//
// 只做"有没有设"这一件事——库名对不对由 require-bench-db 管, 库是否可达由
// 调用方管, 这里不掺和。

/**
 * Resolve DATABASE_URL, or fail closed.
 *
 * @param entrypoint short label for the caller (script or module name) — shows
 *   up in the error so it is obvious which entrypoint refused to start.
 * @returns the non-empty DATABASE_URL
 * @throws if DATABASE_URL is unset or blank. Never falls back to a default:
 *   a default database name here would silently redirect writes at exactly the
 *   moment the operator believes they are pointing somewhere else.
 */
export function requireDatabaseUrl(entrypoint: string): string {
  const url = process.env.DATABASE_URL?.trim();

  if (url) return url;

  throw new Error(
    `[${entrypoint}] refused to run: DATABASE_URL is not set. This entrypoint has no default ` +
      `connection string on purpose — a default would silently point database work at whichever ` +
      `database name happened to be hard-coded, while the operator believes it is pointing ` +
      `somewhere else. Set DATABASE_URL explicitly (shell export, apps/server/.env, or the ` +
      `process environment) and run again.`
  );
}
