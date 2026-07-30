import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';
import { requireDatabaseUrl } from './src/db/require-database-url';

// drizzle-kit 不经过 src/load-env(那是运行时入口的挂载点), 所以在这里自己
// 加载一次 .env: 否则把 DATABASE_URL 写进 apps/server/.env 的用户会被下面的
// 必填检查拒之门外, 而他明明已经设过了——规矩要能被遵守, 才立得住。
//
// 相对 cwd 解析: drizzle-kit 由本包的 package script 启动, cwd 即本包根目录。
// 下面的 schema / out 两个路径本来就建立在同一前提上, 这里沿用, 不引入新假设。
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // 无缺省: 见 src/db/require-database-url.ts。generate 本身不连库, 但 studio /
    // push / pull 会——同一份 credentials 供全部子命令使用, 为其中一个留缺省
    // 等于把缺省还给全部。要求一次, 干净。
    url: requireDatabaseUrl('drizzle.config'),
  },
  verbose: true,
  strict: true,
});
