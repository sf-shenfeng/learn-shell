// P1-02 红队: apps/server/.env 真加载。
//
// 现状修复前: SETUP.md 说"可编辑 apps/server/.env", 但全库没有一处
// dotenv/`node --env-file` —— 改了这个文件根本不生效, 全靠 shell 里手写
// export 或 docker-compose 环境块。这个模块补上真加载, 零新依赖: Node
// ≥20.12 内建 `process.loadEnvFile(path)`。
//
// 挂载点: index.ts / db/migrate.ts / db/seed.ts 三个入口的**最顶部**——
// 必须排在其它 import 之前, 因为 db/client.ts 在模块加载(顶层)时就读
// `process.env.DATABASE_URL` 建连接池, 晚一步 import 这个文件就晚了。
//
// 路径解析: 用 import.meta.url 拿*本文件自己*所在目录, 而不是
// process.cwd() —— 不管调用者从哪个目录起进程(仓库根 / apps/server /
// dist 编译产物), `<本文件目录>/../.env` 都稳定落在 apps/server/.env。
// src/load-env.ts → ../.env = apps/server/.env；编译后 dist/load-env.js →
// ../.env 同样 = apps/server/.env（dist/ 镜像 src/ 的目录结构，见
// tsconfig.json rootDir: "./src"）。
//
// 不存在就静默跳过 —— .env 本来就是可选文件（SETUP.md：dev 默认值已经够
// 用），没有它不是错误。
//
// 不覆盖已存在的环境变量 —— 已核实 `process.loadEnvFile` 的内建行为本就
// 如此（同名变量若已在 process.env 里，加载时保留原值，不用 .env 覆盖），
// 与 dotenv 的默认语义一致，不需要手写解析兜底。

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, '..', '.env');

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
