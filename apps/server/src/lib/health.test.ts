// degraded 不许伪装健康 — /health 状态码轻测试。
//
// 不起真 DB: `db.execute` 用 node:test 的 mock.method 打桩 (resolve/reject),
// 纯走 Hono 的 app.request(), 零网络连接、零对 *_bench 库的依赖——这条测试本身
// 就不需要 RUN_DB_TESTS 门控, 因为它根本不碰数据库。
//
// 放在 lib/ 而不是 src/ 顶层: package.json 的 test glob 是
// `src/**/*.test.ts`, 在无 globstar 的 shell (pnpm 默认走 sh) 下 `**` 退化成
// 单层 `*`, 只吃"恰好一层子目录"的文件——src/index.test.ts 这种顶层文件会被
// 静默漏跑。lib/ 恰好一层, 且域内 (CLAUDE.md 允许 lib/ 加"小工具函数与测试")。
//
// 断言: db 可达 → 200 + status:'ok'; db 不可达 → 503 + status:'degraded'
// (body 结构不变, 只有状态码从"骗人的 200"改口说实话)。

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db/client';
import app from '../index';

test('/health: db 可达 → 200 + status ok', async () => {
  const executeMock = mock.method(db, 'execute', async () => [{ '?column?': 1 }]);
  try {
    const res = await app.request('/health');
    const body = (await res.json()) as { status: string; db: string };
    assert.equal(res.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.db, 'ok');
  } finally {
    executeMock.mock.restore();
  }
});

test('/health: db 不可达 → 503 + status degraded (不伪装健康)', async () => {
  const executeMock = mock.method(db, 'execute', async () => {
    throw new Error('connection refused (simulated)');
  });
  try {
    const res = await app.request('/health');
    const body = (await res.json()) as { status: string; db: string; db_error: string | null };
    assert.equal(res.status, 503);
    assert.equal(body.status, 'degraded');
    assert.equal(body.db, 'unreachable');
    assert.match(body.db_error ?? '', /connection refused/);
  } finally {
    executeMock.mock.restore();
  }
});
