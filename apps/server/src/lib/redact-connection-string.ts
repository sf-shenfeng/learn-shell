// 数据不出户三针 (针②): 日志脱敏。
//
// index.ts 启动日志 / migrate.ts 迁移日志此前直接打印完整 DATABASE_URL ——
// postgres 连接串把密码明文嵌在 URL 里 (postgresql://user:PASSWORD@host:port/db),
// 完整打印等于把密码写进日志文件/终端回放历史。这里只解析出 host/port/database
// 三项, 密码 (以及 user, 同样敏感但非本次针对目标之外——仍一并省略, 只留连
// 得上人但看不出凭证的三项) 绝不落日志。解析失败 (畸形 URL / 非标准格式) 时
// 打一个明确的占位串, 而不是回退到打印原串——那样等于没脱敏。

/**
 * Redact a Postgres connection string down to `host:port/database` for safe
 * logging. Never echoes user/password even on partial-parse fallback paths.
 */
export function redactConnectionString(connectionString: string | undefined): string {
  if (!connectionString) return '(unset)';
  try {
    const parsed = new URL(connectionString);
    const host = parsed.hostname || '(unknown-host)';
    const port = parsed.port || '(default-port)';
    const database = parsed.pathname.replace(/^\//, '') || '(unknown-db)';
    return `${host}:${port}/${database}`;
  } catch {
    return '(unparseable url, redacted)';
  }
}
