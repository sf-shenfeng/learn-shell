// LS_INSPECT 冒烟测试 — 无库检视模式 (registry/automated-inspection 场景,
// 例如 Glama 质检机器人: 它把这个 MCP server 当子进程真跑起来, 但它的容器
// 里没有 Postgres, 也不会设 DATABASE_URL)。
//
// mcp/server.ts 顶层 import 就会 `await server.connect(transport)`
// (stdio 阻塞), 没法像别的 lib 测试那样直接 import 这个模块来测——必须像
// 真实的 MCP 客户端一样, 把它当子进程 spawn 起来, 用 SDK 自带的
// StdioClientTransport/Client 走真实的 stdio JSON-RPC 往返 (仓库里目前
// 没有别的 mcp/*.test.ts 或 stdio 测试夹具可复用, 这是第一个)。
//
// 子进程环境显式清空 DATABASE_URL (不是"没设"——防止开发机 shell 里已经
// export 过的值漏进子进程, 让这条测试在本地什么都没验证到) + 显式设
// LS_INSPECT=1, 断言三件事 (对应 brief 的三条硬指标):
//   1. initialize 握手成功 (Client.connect() 内部就是做这个)
//   2. tools/list 能枚举全部工具 (>=45, 含 get_context) 且不撞库
//   3. 真调一个需要数据库的工具 (get_context) 拿到的是干净的、机器可读的
//      PERMISSION 错误信封 (mcp/server.ts 的 inspectionModeError, 复用
//      lib/mcp-errors.ts 现成的五族分类), 不是裸堆栈、进程也没有崩溃
//      (子进程能干净退出本身就是"没崩溃"的证据)。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, 'server.ts');
// apps/server 的 devDependency tsx 本地二进制 —— 和 package.json 里
// `"mcp": "tsx src/mcp/server.ts"` 用的是同一个可执行文件, 不假设全局 tsx。
const tsxBin = resolve(here, '..', '..', 'node_modules', '.bin', 'tsx');

// 子进程只保留父进程真实环境 + 显式覆盖两个变量 —— 不用 SDK 默认的
// getDefaultEnvironment()(只挑 HOME/PATH/SHELL/... 几个"安全"变量), 因为
// tsx 解析 workspace 依赖(@learn-shell/contracts 等 pnpm 符号链接)需要完整
// 的 PATH/NODE_* 环境, 精简环境在 pnpm monorepo 下容易解析失败。
function buildInspectionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'DATABASE_URL') continue;
    env[key] = value;
  }
  env.LS_INSPECT = '1';
  return env;
}

test(
  'LS_INSPECT=1 boots with no DATABASE_URL: initialize handshake + tools/list + clean error on a DB-backed tool call',
  { timeout: 45_000 },
  async () => {
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: [serverEntry],
      env: buildInspectionEnv(),
      stderr: 'pipe',
    });

    // 子进程 stderr 攒下来——断言失败时打印出来定位, 平时静默 (server.ts
    // 头注: stdio transport 的 stdout 不能被诊断输出污染, 诊断信息本就该走
    // stderr; 这里只是攒起来供测试失败时人读, 不参与协议)。
    let stderrOutput = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString('utf-8');
    });

    const client = new Client({ name: 'ls-inspect-smoke-test', version: '0.0.0' }, { capabilities: {} });

    try {
      // 1. initialize 握手 —— Client.connect() 内部发 'initialize' 请求并
      //    等结果, 握手失败(或子进程直接崩溃退出)这一步就会抛。
      await client.connect(transport);

      // 2. tools/list 枚举全部工具, 不撞库 (TOOL_DEFINITIONS 是字面量数组)。
      const { tools } = await client.listTools();
      assert.ok(
        tools.length >= 45,
        `expected >=45 tools under LS_INSPECT, got ${tools.length}: ${stderrOutput}`
      );
      assert.ok(
        tools.some((t) => t.name === 'get_context'),
        `tools/list should include get_context: ${stderrOutput}`
      );
      // inputSchema 也要真的枚举出来, 不是占位——每个工具都得带一个非空
      // 的 JSON Schema properties/required 骨架。
      for (const t of tools) {
        assert.ok(t.inputSchema && typeof t.inputSchema === 'object', `${t.name} missing inputSchema`);
      }

      // 3. 真调一个需要数据库的工具 —— get_context 在 handleToolCall 里和
      //    其余 48 个工具一样, 无一例外要先撞库才能往下走 (见
      //    mcp/server.ts 顶部 LS_INSPECT 注释的勘察结论)。
      const result = await client.callTool({ name: 'get_context', arguments: {} });
      assert.equal(result.isError, true, `DB-backed tool call must come back isError under LS_INSPECT: ${stderrOutput}`);

      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content[0]?.text;
      assert.ok(text, 'error result should carry a text content block');
      const envelope = JSON.parse(text as string) as {
        status: string;
        code: string;
        message: string;
        retryable: boolean;
        recovery_hint: string;
      };
      assert.equal(envelope.status, 'error');
      assert.equal(envelope.code, 'PERMISSION');
      assert.equal(envelope.retryable, false);
      assert.match(envelope.message, /inspection mode: no database attached/);
      // 干净错误 == 不是裸 JS 堆栈: 消息里不该出现 "at " 调用帧这种 Error.stack 特征。
      assert.doesNotMatch(envelope.message, /\n\s+at /);
    } finally {
      await client.close();
    }
  }
);
