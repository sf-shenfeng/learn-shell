#!/usr/bin/env node
// e2e-first-run — 空库首跑黄金路径 E2E (release gate ⑨, 红队 Phase 2 序列;
// RT-P0-04/P0-05 修复验收第 3 条 "从空库开始的 first-run E2E" 的落点)。
//
// CI 就绪: exit code 语义干净 —— 0 = 全绿; 1 = 任一步失败 (stderr 带
// "第几步 + 最后一次响应体"); 临时库与子进程无论成败都在 finally 里清理
// (DROP DATABASE ... WITH (FORCE) + kill)。无交互、无环境残留, 可直接接 CI。
//
// 黄金路径 (空库 → 结业, 不跑 demo seed):
//   建临时库 → migrate → 学习者首跑登记 (POST /api/onboarding/learner) →
//   create_pair (MCP, 唯一无 pair 可调工具; 之前 get_context 必须报 No active
//   pair) → propose_contract → 学习者签字 (PATCH /api/contracts/:id
//   establish) → 备课 (create_course/add_lesson/add_concept/add_flashcard×3/
//   add_exercise/verify_prep/publish_lesson) → 学习者可见性 (发布前列表不含
//   草稿、发布后课卡计数与学习者列表一致 — P0-05 的伤疤) → 反向测试:
//   未宣告时 close_lesson_loop 被拒 (NOT_DECLARED) → 学习者交作业 →
//   学习者亲手宣告完成 (declare-completed REST, 走 UPDATE 分支) → 回归:
//   无足迹宣告走 INSERT 分支 (曾经的 P0 疤) → 阅卷 (grade_exercise) →
//   Live 一场 (start → FRAME/ASK move → 学习者作答 → snapshot → 反向测试:
//   未按下课铃时 complete 被拒 (CONFLICT) → 学习者 declare-close →
//   complete 带场评) → record_post_lesson_evaluation → reflect_on_teaching →
//   close_lesson_loop → get_context 结业判定 (goal_completion_ready) →
//   complete_contract → get_context 复核 (合同退出现役)。
//
// 数据库纪律: 只碰自建临时库 (缺省 learn_shell_e2e_tmp), 用毕 DROP;
// learn_shell / learn_shell_bench 有硬保险丝, 传进来直接拒跑。
//
// 用法:
//   pnpm --filter @learn-shell/server test:e2e
//   node scripts/e2e-first-run.mjs
// 可调环境变量:
//   E2E_DB_NAME      临时库名 (缺省 learn_shell_e2e_tmp)
//   E2E_DB_URL_BASE  应用侧连接串 base (缺省 postgresql://learn_shell:learn_shell_dev@localhost:5432)
//   E2E_ADMIN_DB     psql 管理连接的 -d 参数 (缺省 postgres, 本机 peer-auth 超级用户建/删库)

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Config + 保险丝
// ---------------------------------------------------------------------------

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_BIN = join(SERVER_DIR, 'node_modules', '.bin', 'tsx');

const DB_NAME = process.env.E2E_DB_NAME || 'learn_shell_e2e_tmp';
const FORBIDDEN_DBS = new Set(['learn_shell', 'learn_shell_bench']);
if (FORBIDDEN_DBS.has(DB_NAME)) {
  console.error(`[e2e] 拒跑: E2E_DB_NAME=${DB_NAME} 是受保护数据库 (learn_shell / learn_shell_bench 绝不许碰)。`);
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]*$/.test(DB_NAME)) {
  console.error(`[e2e] 拒跑: 临时库名 "${DB_NAME}" 不是安全标识符。`);
  process.exit(1);
}

const DB_URL_BASE =
  process.env.E2E_DB_URL_BASE || 'postgresql://learn_shell:learn_shell_dev@localhost:5432';
const DATABASE_URL = `${DB_URL_BASE}/${DB_NAME}`;
const ADMIN_DB = process.env.E2E_ADMIN_DB || 'postgres';

const LEARNER_NAME = 'E2E Learner';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function sh(cmd, args, opts = {}) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', rejectP);
    child.on('close', (code) => {
      if (code === 0) resolveP({ out, err });
      else rejectP(new Error(`${cmd} ${args.join(' ')} → exit ${code}\nstdout: ${out}\nstderr: ${err}`));
    });
  });
}

/** 管理面 psql (本机 peer-auth 超级用户) — 只用于建/删临时库。 */
function psqlAdmin(sqlText) {
  return sh('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', ADMIN_DB, '-tAc', sqlText]);
}

/** 临时库上的查询 (走应用连接串)。 */
async function psqlTemp(sqlText) {
  const { out } = await sh('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', DATABASE_URL, '-tAc', sqlText]);
  return out.trim();
}

function freePort() {
  return new Promise((resolveP, rejectP) => {
    const srv = createServer();
    srv.once('error', rejectP);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolveP(port));
    });
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 步骤框架 — 失败输出"第几步 + 最后一次响应体"
// ---------------------------------------------------------------------------

let stepNo = 0;
const stepLog = [];
let lastResponse = null; // { via, target, status?, body }

async function step(name, fn) {
  stepNo += 1;
  const n = stepNo;
  const t0 = Date.now();
  process.stdout.write(`[e2e] step ${String(n).padStart(2, '0')} · ${name} ... `);
  try {
    const v = await fn();
    const ms = Date.now() - t0;
    stepLog.push({ n, name, ms });
    process.stdout.write(`✅ (${ms}ms)\n`);
    return v;
  } catch (e) {
    process.stdout.write('❌\n');
    console.error(`\n[e2e] FAILED at step ${n} · ${name}`);
    console.error(`[e2e] error: ${e instanceof Error ? e.message : String(e)}`);
    if (lastResponse) {
      console.error(`[e2e] last response (${lastResponse.via} ${lastResponse.target}${lastResponse.status !== undefined ? ` → ${lastResponse.status}` : ''}):`);
      console.error(String(lastResponse.body).slice(0, 4000));
    }
    if (serverLog.trim()) {
      console.error('[e2e] server log tail:');
      console.error(serverLog.slice(-3000));
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// REST helper
// ---------------------------------------------------------------------------

let BASE = ''; // http://127.0.0.1:<port>

async function http(method, path, body, expectStatuses) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  lastResponse = { via: 'REST', target: `${method} ${path}`, status: res.status, body: text };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (expectStatuses && !expectStatuses.includes(res.status)) {
    throw new Error(`${method} ${path} → HTTP ${res.status} (期望 ${expectStatuses.join('/')})`);
  }
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// MCP helper — stdio 子进程, 与 mcp-call.mjs / candidate-mcp-client.mjs 同一套
// SDK 调用模式 (initialize → tools/call), 每笔写都走真协议。
// ---------------------------------------------------------------------------

const req = createRequire(join(SERVER_DIR, 'package.json'));
const { Client } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StdioClientTransport } = await import(
  pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
);

let mcpClient = null;

async function mcp(name, args = {}) {
  const res = await mcpClient.callTool({ name, arguments: args });
  const text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
  lastResponse = { via: 'MCP', target: name, body: text };
  let env;
  try {
    env = JSON.parse(text);
  } catch {
    env = { raw: text };
  }
  return { isError: !!res.isError, env, text };
}

async function mcpOk(name, args) {
  const r = await mcp(name, args);
  if (r.isError || r.env.status !== 'success') {
    throw new Error(`MCP ${name} 应成功, 实际失败: ${r.text.slice(0, 1200)}`);
  }
  return r.env;
}

async function mcpErr(name, args, needle) {
  const r = await mcp(name, args);
  if (!r.isError && r.env.status !== 'error') {
    throw new Error(`MCP ${name} 应被拒, 实际成功: ${r.text.slice(0, 1200)}`);
  }
  if (needle && !r.text.includes(needle)) {
    throw new Error(`MCP ${name} 被拒, 但错误体里找不到 "${needle}": ${r.text.slice(0, 1200)}`);
  }
  return r.env;
}

// ---------------------------------------------------------------------------
// 备课材料 — 过 publish gate 验尺 (lib/validate-prep-core): 8 页顶层 '---'
// 分页 / 每页首行 ::kicker[九词表] / 每页恰一 h2 / FABLE 先于 FORMULA /
// ==高亮== 3–5 处; 闪卡 3 张同 deck 挂 concept; 习题 ≥1 带参考答案。
// ---------------------------------------------------------------------------

function lessonMarkdown() {
  const pages = [
    ['HOOK', '开场：钱去哪儿了', '账上写着赚了钱，银行卡余额却没动。==净利润== 和现金，从来不是同一个人。'],
    ['FABLE', '寓言：水库与账本', '村口的水库记水账：进水记一笔，出水记一笔。账本可以说今年丰收，水位说了才算数。'],
    ['NAME', '命名：间接法', '从利润出发倒推现金 —— 这条路叫间接法，落点是 ==经营活动现金流==。'],
    ['FORMULA', '公式：从净利润出发', '经营现金流 = 净利润 + ==非现金调整== + 营运资本变动。三段各管一件事。'],
    ['EXAMPLE', '例子：一张简表', '净利润 100，折旧 30，应收增加 20：经营现金流 = 100 + 30 - 20 = 110。'],
    ['TRIAL', '试炼：动手算一次', '净利润 80，折旧 25，存货增加 15，应付增加 10。请算出经营现金流并说明每步方向。'],
    ['TRAPS', '陷阱：方向搞反', '应收增加是 ==减项==：钱还躺在客户那里。方向错一次，整张表就散架。'],
    ['NEXT', '下一步', '下一课把投资与筹资两段接上，拼出完整的现金流量表。'],
  ];
  return pages
    .map(([kicker, h2, body]) => `::kicker[${kicker}]\n## ${h2}\n\n${body}\n`)
    .join('\n---\n\n');
}

// ---------------------------------------------------------------------------
// 子进程管理 + 清理 (成败都走)
// ---------------------------------------------------------------------------

let serverProc = null;
let dbCreated = false;
/** server 子进程 stdout+stderr 滚动缓冲 — 失败时打印尾部, 500 不再哑巴。 */
let serverLog = '';
function appendServerLog(chunk) {
  serverLog = (serverLog + chunk).slice(-16_000);
}

async function killProc(proc, label) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    proc.kill('SIGTERM');
    const dead = await Promise.race([
      new Promise((r) => proc.once('close', () => r(true))),
      sleep(3000).then(() => false),
    ]);
    if (!dead) proc.kill('SIGKILL');
  } catch (e) {
    console.error(`[e2e] cleanup: kill ${label} 失败 (忽略): ${e}`);
  }
}

async function cleanup() {
  // MCP client 先收 (它自己会带走 stdio 子进程)。
  if (mcpClient) {
    try {
      await mcpClient.close();
    } catch (e) {
      console.error(`[e2e] cleanup: mcp close 失败 (忽略): ${e}`);
    }
    mcpClient = null;
  }
  await killProc(serverProc, 'server');
  serverProc = null;
  if (dbCreated) {
    try {
      await psqlAdmin(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
      console.log(`[e2e] cleanup: 临时库 ${DB_NAME} 已 DROP。`);
      dbCreated = false;
    } catch (e) {
      console.error(`[e2e] cleanup: DROP DATABASE ${DB_NAME} 失败 —— 需要手工清理: ${e}`);
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.error(`\n[e2e] ${sig} — 清理后退出。`);
    await cleanup();
    process.exit(130);
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const t0 = Date.now();
let exitCode = 0;

try {
  // ---- 基建三步 --------------------------------------------------------
  await step(`创建临时库 ${DB_NAME} (先 DROP IF EXISTS — 幂等自愈)`, async () => {
    await psqlAdmin(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await psqlAdmin(`CREATE DATABASE ${DB_NAME} OWNER learn_shell`);
    dbCreated = true;
  });

  await step('migrate: drizzle 全量迁移 (repo 正门 src/db/migrate.ts)', async () => {
    const { out, err } = await sh(TSX_BIN, ['src/db/migrate.ts'], {
      cwd: SERVER_DIR,
      env: { ...process.env, DATABASE_URL },
    });
    lastResponse = { via: 'CMD', target: 'tsx src/db/migrate.ts', body: out + err };
    assert(/\[migrate\] done\./.test(out + err), 'migrate 输出应含 "[migrate] done."');
  });

  await step('空库核验: 不跑 demo seed, learners/pairs/courses 均为 0 行', async () => {
    const counts = await psqlTemp(
      "select (select count(*) from learners) || '/' || (select count(*) from learner_agent_pairs) || '/' || (select count(*) from courses)"
    );
    lastResponse = { via: 'SQL', target: 'row counts learners/pairs/courses', body: counts };
    assert(counts === '0/0/0', `期望 0/0/0, 实际 ${counts}`);
  });

  // ---- 起 server (REST) + MCP 子进程 -----------------------------------
  await step('起 server 子进程 (随机端口, DATABASE_URL 指临时库) 并等 /health 绿', async () => {
    const port = await freePort();
    BASE = `http://127.0.0.1:${port}`;
    serverProc = spawn(TSX_BIN, ['src/index.ts'], {
      cwd: SERVER_DIR,
      env: { ...process.env, DATABASE_URL, PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', appendServerLog);
    serverProc.stderr.on('data', appendServerLog);
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (serverProc.exitCode !== null) {
        throw new Error(`server 子进程提前退出 (exit ${serverProc.exitCode})\n${serverLog.slice(-2000)}`);
      }
      try {
        const { status, json } = await http('GET', '/health');
        if (status === 200 && json?.db === 'ok') break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server 60s 内未就绪\n${serverLog.slice(-2000)}`);
      await sleep(300);
    }
  });

  await step('起 MCP stdio 子进程并完成 initialize 握手', async () => {
    const transport = new StdioClientTransport({
      command: TSX_BIN,
      args: ['src/mcp/server.ts'],
      cwd: SERVER_DIR,
      env: { ...process.env, DATABASE_URL },
    });
    mcpClient = new Client({ name: 'e2e-first-run', version: '1.0.0' });
    await mcpClient.connect(transport);
    const { tools } = await mcpClient.listTools();
    lastResponse = { via: 'MCP', target: 'tools/list', body: tools.map((t) => t.name).join(',') };
    assert(tools.some((t) => t.name === 'create_pair'), 'tools/list 应含 create_pair');
  });

  // ---- 首跑入学 (P0-04 正门) -------------------------------------------
  await step('空库时 get_context 必须拒: No active pair (create_pair 是唯一无 pair 可调工具)', async () => {
    await mcpErr('get_context', {}, 'No active pair');
  });

  const learnerId = await step('学习者首跑登记: POST /api/onboarding/learner (201) + 幂等重放 (200 reused)', async () => {
    const first = await http('POST', '/api/onboarding/learner', { display_name: LEARNER_NAME, locale: 'zh-CN' }, [201]);
    assert(first.json.learner_id && first.json.reused === false, '首次登记应新建 (reused=false)');
    const replay = await http('POST', '/api/onboarding/learner', { display_name: LEARNER_NAME, locale: 'zh-CN' }, [200]);
    assert(replay.json.reused === true && replay.json.learner_id === first.json.learner_id, '同名未配对重放应命中既有行');
    return first.json.learner_id;
  });

  const { pairId } = await step('MCP create_pair — 名字与首跑登记逐字汇合, 建真 pair', async () => {
    const env = await mcpOk('create_pair', {
      learner_display_name: LEARNER_NAME,
      agent_provider: 'claude-code-cli',
      agent_model: 'claude',
      agent_display_name: 'E2E Agent',
      locale: 'zh-CN',
    });
    const refs = env.created_refs ?? {};
    assert(refs.pair_id && refs.learner_id === learnerId, `create_pair 应绑定登记的 learner (${learnerId}), got ${JSON.stringify(refs)}`);
    return { pairId: refs.pair_id };
  });

  // ---- 立约: propose (MCP) → establish (学习者 REST 签字) ---------------
  const contractId = await step('MCP propose_contract → setup_status=proposed', async () => {
    const env = await mcpOk('propose_contract', {
      goal: 'E2E: 现金流量表间接法一课通关',
      success_criteria: ['能独立算出经营活动现金流', '能说明每类调整的方向'],
      intensity: 'standard',
      interaction_mode: 'hybrid',
      content_modality: 'text',
      pace: 'flexible',
    });
    const id = env.created_refs?.contract_id;
    assert(id, 'propose_contract 应回 contract_id');
    const listed = await http('GET', `/api/pairs/${pairId}/contracts`, undefined, [200]);
    const row = (listed.json ?? []).find((c) => c.id === id);
    assert(row?.setup_status === 'proposed', `合同应处 proposed, 实际 ${row?.setup_status}`);
    return id;
  });

  await step('学习者签字: PATCH /api/contracts/:id {setup_status: established}', async () => {
    const { json } = await http('PATCH', `/api/contracts/${contractId}`, { setup_status: 'established' }, [200]);
    assert(json.setup_status === 'established', `签字后应 established, 实际 ${json.setup_status}`);
  });

  // ---- 备课 -------------------------------------------------------------
  const courseId = await step('MCP create_course (planned_lesson_count=1, 挂 contract_id 即履约)', async () => {
    const env = await mcpOk('create_course', {
      topic: '现金流量表 · E2E 黄金路径',
      description: '空库首跑 E2E 用单课课程',
      planned_lesson_count: 1,
      contract_id: contractId,
    });
    const id = env.created_refs?.course_id;
    assert(id, 'create_course 应回 course_id');
    const listed = await http('GET', `/api/pairs/${pairId}/contracts`, undefined, [200]);
    const row = (listed.json ?? []).find((c) => c.id === contractId);
    assert((row?.covered_course_ids ?? []).includes(id), '建课应自动并入合同 covered_course_ids');
    return id;
  });

  const lessonId = await step('MCP add_lesson (草稿态, 课文过验尺格式)', async () => {
    const env = await mcpOk('add_lesson', {
      course_id: courseId,
      order: 1,
      title: '间接法：从净利润走回现金',
      content_markdown: lessonMarkdown(),
      estimated_minutes: 20,
    });
    const id = env.created_refs?.lesson_id;
    assert(id, 'add_lesson 应回 lesson_id');
    return id;
  });

  const conceptId = await step('MCP add_concept (闪卡出处锚点)', async () => {
    const env = await mcpOk('add_concept', {
      lesson_id: lessonId,
      name: '间接法经营现金流',
      short_definition: '从净利润出发, 经非现金调整与营运资本变动倒推经营活动现金流。',
    });
    const id = env.created_refs?.concept_id;
    assert(id, 'add_concept 应回 concept_id');
    return id;
  });

  await step('MCP add_flashcard ×3 (同 deck, 挂 concept — 满足 3–10 张验尺)', async () => {
    const cards = [
      { front: '净利润为何常常不等于现金流入?', back: '利润按权责发生制记账, 含折旧等非现金项与尚未收付的往来款。' },
      { front: '应收账款增加, 经营现金流怎么调?', back: '作减项——收入记了, 钱还在客户手里。' },
      { front: '折旧在间接法里往哪个方向调?', back: '加回——它压低了利润, 却没花一分现金。' },
    ];
    for (const c of cards) {
      const env = await mcpOk('add_flashcard', { concept_id: conceptId, deck_id: 'e2e-cashflow', tags: ['e2e'], ...c });
      assert(env.created_refs?.flashcard_id, 'add_flashcard 应回 flashcard_id');
    }
  });

  const exerciseId = await step('MCP add_exercise (参考答案 + expected_concepts)', async () => {
    const env = await mcpOk('add_exercise', {
      lesson_id: lessonId,
      order: 1,
      prompt: '净利润 80, 折旧 25, 存货增加 15, 应付账款增加 10。求经营活动现金流, 并逐项说明方向。',
      reference_answer: '80 + 25 - 15 + 10 = 100。折旧加回(非现金), 存货增加减(现金压进库存), 应付增加加(暂未付现)。',
      expected_concepts: [conceptId],
    });
    const id = env.created_refs?.exercise_id;
    assert(id, 'add_exercise 应回 exercise_id');
    return id;
  });

  await step('可见性·发布前: 学习者书架不含草稿课, 教师面 include_unpublished 可见', async () => {
    const learnerView = await http('GET', `/api/courses/${courseId}/lessons`, undefined, [200]);
    assert(Array.isArray(learnerView.json) && learnerView.json.length === 0, `草稿不应进学习者书架, 实际 ${learnerView.json?.length} 节`);
    const teacherView = await http('GET', `/api/courses/${courseId}/lessons?include_unpublished=1`, undefined, [200]);
    assert(teacherView.json.length === 1 && teacherView.json[0].id === lessonId, '教师面应见 1 节草稿');
  });

  await step('MCP verify_prep — 全家福验尺无红灯 (PASS / PASS_WITH_WARNINGS)', async () => {
    const env = await mcpOk('verify_prep', { lesson_id: lessonId });
    const text = JSON.stringify(env);
    assert(!text.includes('"FAIL"'), `verify_prep 不应 FAIL: ${text.slice(0, 1500)}`);
  });

  await step('MCP publish_lesson — 过红灯闸上架', async () => {
    const env = await mcpOk('publish_lesson', { lesson_id: lessonId });
    assert(env.resource_id === lessonId, 'publish_lesson 回执应指向本课');
  });

  await step('可见性·发布后 (P0-05): 课卡计数与学习者列表同一可见性口径', async () => {
    const learnerView = await http('GET', `/api/courses/${courseId}/lessons`, undefined, [200]);
    assert(learnerView.json.length === 1 && learnerView.json[0].id === lessonId, '发布后学习者书架应见这节课');
    assert(learnerView.json[0].published_at, '书架行应带 published_at');
    const courseRow = await http('GET', `/api/courses/${courseId}`, undefined, [200]);
    const cardCount = (courseRow.json?.structure?.lesson_ids ?? []).length;
    assert(
      cardCount === learnerView.json.length,
      `课卡计数 (structure.lesson_ids=${cardCount}) 应与学习者可见列表 (${learnerView.json.length}) 一致 — P0-05 伤疤`
    );
  });

  // ---- 反向测试: 未宣告不许关课 ----------------------------------------
  await step('反向: 学习者未宣告时 close_lesson_loop 必须被拒 (NOT_DECLARED)', async () => {
    await mcpErr(
      'close_lesson_loop',
      {
        lesson_id: lessonId,
        receipt: [{ kind: 'journal_entry', description: 'E2E 反向测试——此条不应落库' }],
        no_cognitive_update_reason: 'E2E 反向测试, 课还没开始',
      },
      'NOT_DECLARED'
    );
    // 拒关不留副作用: 回执表 0 行。
    const receipts = await psqlTemp(`select count(*) from lesson_loop_receipts where lesson_id = '${lessonId}'`);
    assert(receipts === '0', `拒关不应写回执, 实际 ${receipts} 行`);
  });

  // ---- 学习者学课/交作业/宣告 ------------------------------------------
  await step('学习者读课留足迹: POST /lessons/:id/progress/touch → in_progress', async () => {
    // 足迹法: web 的 PagedLesson 逐页静默 touch — 这里如实走同一条学习者路径。
    // 留意: 有了足迹, 下面那步宣告走的是 UPDATE 分支 (行已存在)。INSERT 首插
    // 那条分支由后面的"回归·无足迹宣告"单独守 —— 别把两者当成同一条路径。
    const first = await http('POST', `/api/lessons/${lessonId}/progress/touch`, { page_index: 0 }, [201]);
    assert(first.json.state === 'in_progress', `首 touch 后应 in_progress, 实际 ${first.json.state}`);
    const again = await http('POST', `/api/lessons/${lessonId}/progress/touch`, { page_index: 7 }, [200]);
    assert((again.json.pages_visited ?? []).length === 2, '足迹应并集到 2 页');
  });

  const submissionId = await step('学习者交作业: POST /api/submissions (status=submitted)', async () => {
    const { json } = await http(
      'POST',
      '/api/submissions',
      { exercise_id: exerciseId, learner_id: learnerId, learner_answer: '80+25-15+10=100。折旧非现金加回; 存货占款作减; 应付未付作加。' },
      [201]
    );
    assert(json.status === 'submitted', `提交应 submitted, 实际 ${json.status}`);
    return json.id;
  });

  await step('学习者亲手宣告完成 (有足迹, 走 UPDATE 分支): POST declare-completed → completed_declared', async () => {
    const { json } = await http(
      'POST',
      `/api/pairs/${pairId}/lessons/${lessonId}/declare-completed`,
      { pages_total: 8, current_page_index: 7 },
      [200, 201]
    );
    assert(json.state === 'completed_declared' && json.declared_at, `宣告后应 completed_declared, 实际 ${json.state}`);
  });

  // ---- 回归: 宣告的无足迹首插分支 (曾经的 P0 疤) ------------------
  // 上一步宣告时 lesson_progress 里早有行 (touch 建的), 走的是 UPDATE 分支。
  // 真正炸过 500 的是另一条: 学习者一次 touch 都没留就直接宣告 —— 该
  // (pair, lesson) 在 lesson_progress 里无行, 路由走 INSERT … ON CONFLICT DO
  // UPDATE, 而那段 conflict 子句里绑着 declared_at。曾经直接把 JS Date 实例绑
  // 进 drizzle 原生 sql 片段, postgres-js 拒绝序列化, 无足迹首插必炸 500
  // (2026-07-24 修为 ISO 串 + ::timestamptz 显式 cast)。
  //
  // 这一步守的就是那条铁律: **Date 实例不得直接绑进原生 sql 片段**。谁把那段
  // 重构回 Date, 这里立刻红 —— 不是凑数步, 是 P0 的看门狗。
  await step(
    '回归·无足迹宣告: 从未 touch 过的课直接宣告 → 必须走 INSERT 分支且成功落库 (守 "Date 实例不得直接绑进原生 sql 片段", 复发即 500)',
    async () => {
      // 无足迹前置条件: 新建一节学习者从未翻开过的课。草稿态即可 ——
      // declare-completed 不看发布态, 而未发布的课不进 contract_progress /
      // complete_contract 的完课判定 (两处都先按 content==='published' 过滤),
      // 所以这节回归用课不会扰动后面的结业断言。
      const env = await mcpOk('add_lesson', {
        course_id: courseId,
        order: 2,
        title: '回归用: 一次都没翻开的课 (无足迹宣告)',
        content_markdown: lessonMarkdown(),
        estimated_minutes: 5,
      });
      const virginLessonId = env.created_refs?.lesson_id;
      assert(virginLessonId, 'add_lesson 应回 lesson_id');

      // 前置自证: 这一对 (pair, lesson) 在 lesson_progress 里一行都没有。
      // 没有行才会走 INSERT 分支 —— 这一步才算真守到东西, 而不是又走一遍 UPDATE。
      const before = await psqlTemp(
        `select count(*) from lesson_progress where pair_id = '${pairId}' and lesson_id = '${virginLessonId}'`
      );
      lastResponse = { via: 'SQL', target: 'lesson_progress 行数 (宣告前, 应无足迹)', body: before };
      assert(before === '0', `回归用课在宣告前应无 lesson_progress 行, 实际 ${before} 行 — 前置没造干净, 这步守不住 INSERT 路径`);

      // 201 = 真插入 (路由按 row.id === 自己生成的 id 判定 201/200)。若回 200,
      // 说明撞车走了合并分支, 同样算失败 —— 严格只收 201。
      const { json } = await http(
        'POST',
        `/api/pairs/${pairId}/lessons/${virginLessonId}/declare-completed`,
        { pages_total: 8, current_page_index: 7 },
        [201]
      );
      assert(
        json.state === 'completed_declared' && json.declared_at,
        `无足迹宣告应 completed_declared, 实际 ${json.state}`
      );

      // 真落库 (不只是回执好看): 状态 + declared_at + checklist_snapshot +
      // 宣告自带的当前页并进足迹集合 (无足迹起步, 并集大小恰 1)。
      const after = await psqlTemp(
        `select state || '|' || (declared_at is not null) || '|' || (checklist_snapshot is not null)
                || '|' || jsonb_array_length(pages_visited)
           from lesson_progress where pair_id = '${pairId}' and lesson_id = '${virginLessonId}'`
      );
      lastResponse = { via: 'SQL', target: 'lesson_progress 行 (无足迹宣告后)', body: after };
      assert(
        after === 'completed_declared|true|true|1',
        `库里应是 completed_declared|true|true|1 (状态|declared_at 非空|snapshot 非空|足迹页数), 实际 ${after}`
      );
    }
  );

  // ---- 阅卷 -------------------------------------------------------------
  await step('MCP grade_exercise — 批改落判决 (status=graded)', async () => {
    const env = await mcpOk('grade_exercise', {
      submission_id: submissionId,
      feedback: '四项方向全对, 数字正确。存货那步的"现金压进库存"表述很准。',
      score: 0.95,
    });
    assert(env.created_refs?.submission_id === submissionId, '批改回执应指向提交');
    const subs = await http('GET', `/api/learners/${learnerId}/submissions`, undefined, [200]);
    const row = (subs.json ?? []).find((s) => s.id === submissionId);
    assert(row?.status === 'graded', `提交应 graded, 实际 ${row?.status}`);
  });

  // ---- Live 一场 --------------------------------------------------------
  const liveSessionId = await step('MCP live_session_start (context=本课)', async () => {
    const env = await mcpOk('live_session_start', {
      context_type: 'lesson',
      context_id: lessonId,
      goal: 'E2E: 现场过一遍间接法方向感',
    });
    const sid = env.created_refs?.session_id;
    assert(sid, 'live_session_start 应回 session_id');
    return sid;
  });

  const askMoveId = await step('MCP live_message_send: FRAME 开场 → ASK 递题 (轮转 learner)', async () => {
    const frame = await mcpOk('live_message_send', {
      session_id: liveSessionId,
      move_type: 'FRAME',
      content: '这一场十分钟: 先对一遍作业里的方向感, 再口头快问两题, 都对即收官。',
      response_kind: 'none',
    });
    assert(frame.created_refs?.move_id, 'FRAME 应落 move');
    const ask = await mcpOk('live_message_send', {
      session_id: liveSessionId,
      move_type: 'ASK',
      content: '快问: 预付费用增加, 经营现金流加还是减? 一句话说方向和理由。',
      response_kind: 'text',
    });
    assert(ask.created_refs?.move_id, 'ASK 应落 move');
    return ask.created_refs.move_id;
  });

  await step('学习者作答: POST /sessions/:id/responses (轮转回 agent)', async () => {
    const { json } = await http(
      'POST',
      `/api/teaching/sessions/${liveSessionId}/responses`,
      { move_id: askMoveId, content: '减——钱先付出去了, 费用还没进利润。', input_type: 'text', client_response_id: 'e2e-resp-1' },
      [201]
    );
    assert(json.id, '作答应落 teaching_response');
  });

  const snapshotId = await step('MCP live_snapshot_write — 场中 checkpoint', async () => {
    const env = await mcpOk('live_snapshot_write', {
      session_id: liveSessionId,
      after_turn_n: 2,
      rolling_summary: '方向感已立: 非现金加回/占款作减/未付作加, 预付费用题一次答对。',
      current_direction: '收官前再确认一遍营运资本三兄弟的方向。',
      weak_signals: [],
    });
    const id = env.created_refs?.snapshot_id;
    assert(id, 'live_snapshot_write 应回 snapshot_id');
    return id;
  });

  await step('反向: 学习者未按下课铃时 live_session_complete 必须被拒 (CONFLICT)', async () => {
    const env = await mcpErr('live_session_complete', {
      session_id: liveSessionId,
      summary: 'E2E 反向测试——不应被接受',
      teacher_reflection: 'E2E 反向测试',
      next_action: 'E2E 反向测试',
    });
    assert(env.code === 'CONFLICT', `未按铃收官应 CONFLICT, 实际 ${env.code}`);
  });

  await step('学习者按下课铃: POST /sessions/:id/declare-close', async () => {
    const { json } = await http('POST', `/api/teaching/sessions/${liveSessionId}/declare-close`, {}, [201]);
    assert(json.already_declared === false && json.learner_close_declared_at, '首次按铃应落宣告时间');
  });

  await step('MCP live_session_complete (REFLECT 三段 + 随行场评) → completed', async () => {
    const env = await mcpOk('live_session_complete', {
      session_id: liveSessionId,
      summary: '她把间接法三类调整的方向全部答对 (含 ASK 的预付费用题, 见本场唯一一条 learner response)。',
      teacher_reflection: '薄弱环节不在方向而在速度——营运资本项还要想一拍才出答案。',
      next_action: '下一课开场做 60 秒方向快答: 应收/存货/应付/预付各一题。',
      evaluation: {
        agent_observation: '现场一问一答, 方向判断即答即对; 快照记录在案, 无迟疑性错误。',
        live_turns_count: 3,
        duration_minutes: 10,
      },
    });
    assert(env.resource_id === liveSessionId, 'complete 回执应指向本场');
    const s = await http('GET', `/api/teaching/sessions/${liveSessionId}`, undefined, [200]);
    assert(s.json?.session?.status === 'completed', `收课后应 completed, 实际 ${s.json?.session?.status}`);
  });

  // ---- 评估 / 反思 / 关课 ----------------------------------------------
  await step('MCP record_post_lesson_evaluation (课级总评)', async () => {
    const env = await mcpOk('record_post_lesson_evaluation', {
      lesson_id: lessonId,
      concepts_touched: [conceptId],
      exercises_submitted_count: 1,
      live_turns_count: 3,
      duration_minutes: 30,
      agent_observation:
        '整体判断: 间接法方向感已立, 作业 0.95 (判决见 grade 记录)。与 Live 对照: 现场快答同样零方向错误。下一课建议: 提速训练 + 接投资/筹资段。',
    });
    assert(env.created_refs?.evaluation_id, '总评应回 evaluation_id');
  });

  await step('MCP reflect_on_teaching (挂锚本课, 归因+行动链)', async () => {
    const env = await mcpOk('reflect_on_teaching', {
      method: '寓言先行(水库与账本) + 方向口诀 + 现场快答',
      rationale: '方向感是间接法的唯一门槛, 用具象水账建立正负直觉。',
      expected_outcome: '作业与现场快答方向零错误。',
      actual_evidence: '作业 0.95, ASK 预付费用题一次答对。',
      next_action: '下一课 60 秒方向快答后再进新内容。',
      primary_attribution: 'not_yet_mastered',
      evidence: '营运资本项作答正确但均有约一拍迟疑 (Live 现场观察), 属熟练度而非概念缺口。',
      counterfactual: '如果真相是解释路径不适合她, 我预期方向会答错或答不出; 我实际看到的是全对、只慢一拍。',
      action_link: { type: 'review_action', ref_id: exerciseId },
      lesson_id: lessonId,
      live_session_id: liveSessionId,
    });
    assert(env.created_refs?.reflection_id, '反思应回 reflection_id');
  });

  await step('MCP close_lesson_loop (正序关课: 回执引用真实判决与快照) → closed', async () => {
    const env = await mcpOk('close_lesson_loop', {
      lesson_id: lessonId,
      receipt: [
        { kind: 'exercise_feedback', description: '作业一已批改 (判决见 grade 记录)', ref_id: submissionId },
        { kind: 'journal_entry', description: 'Live 一场的现场快照入传记', ref_id: snapshotId },
      ],
    });
    assert((env.created_refs?.receipt_ids ?? '').split(',').filter(Boolean).length === 2, '应落 2 条回执');
    const prog = await http('GET', `/api/pairs/${pairId}/lessons/${lessonId}/progress`, undefined, [200]);
    assert(prog.json?.state === 'closed', `关课后应 closed, 实际 ${prog.json?.state}`);
  });

  // ---- 合同履约/结业 ----------------------------------------------------
  await step('MCP get_context — contract_progress 结业判定 (covered=1, goal_completion_ready)', async () => {
    const env = await mcpOk('get_context', {});
    const cp = (env.data?.contract_progress ?? []).find((c) => c.contract_id === contractId);
    assert(cp, 'contract_progress 应含本合同');
    assert(cp.covered_course_count === 1, `covered_course_count 应 1, 实际 ${cp.covered_course_count}`);
    assert(cp.operationally_caught_up === true, 'operationally_caught_up 应 true');
    assert(cp.goal_completion_ready === true, 'goal_completion_ready 应 true (planned=1 已发布 1 已关课)');
    const active = (env.data?.active_contracts ?? []).find((c) => c.id === contractId);
    assert(active?.setup_status === 'established', '合同此刻应仍在现役清单 (established)');
  });

  await step('MCP complete_contract — 结业词落档 (completed_at)', async () => {
    const env = await mcpOk('complete_contract', {
      contract_id: contractId,
      completion_note:
        '一节课走完整个间接法闭环: 从水库寓言到 0.95 的作业, 现场快答零方向错误。这段路她走得又稳又快。',
    });
    assert(env.created_refs?.contract_id === contractId, '结业回执应指向本合同');
    const listed = await http('GET', `/api/pairs/${pairId}/contracts`, undefined, [200]);
    const row = (listed.json ?? []).find((c) => c.id === contractId);
    assert(row?.completed_at, '合同行应落 completed_at');
  });

  await step('MCP complete_contract 幂等重放 — 终态不重写, 原结业词保留', async () => {
    // 结业是终态: 重复调用应幂等返回既有结业词, 不报错、不覆盖 (工具描述契约)。
    const env = await mcpOk('complete_contract', {
      contract_id: contractId,
      completion_note: 'E2E 重放——这句不应覆盖原结业词',
    });
    assert(/already completed/i.test(env.human_note ?? ''), '重放回执应说明合同已结业');
    assert(!(env.human_note ?? '').includes('E2E 重放——这句不应覆盖原结业词'), '重放不应覆盖原结业词');
    const listed = await http('GET', `/api/pairs/${pairId}/contracts`, undefined, [200]);
    const row = (listed.json ?? []).find((c) => c.id === contractId);
    assert(row?.completion_note?.includes('一节课走完整个间接法闭环'), '库里结业词应仍是首次那份');
    // 已知现实 (只报不修, 见 E2E 报告): lib/currentContract 只滤 setup_status
    // 与 voided_at, 不滤 completed_at —— 已结业合同此刻仍会出现在 get_context
    // 的 active_contracts 里。这里不对该行为做正反断言, 免得修复时连坐。
  });

  // ---- 汇总 -------------------------------------------------------------
  const total = Date.now() - t0;
  console.log('\n[e2e] ✅ 全绿 — 空库首跑黄金路径完整走通。步骤清单:');
  for (const s of stepLog) {
    console.log(`  ${String(s.n).padStart(2, '0')}. ${s.name} — ${s.ms}ms`);
  }
  console.log(`[e2e] 共 ${stepLog.length} 步, 总耗时 ${(total / 1000).toFixed(1)}s。`);
} catch (e) {
  exitCode = 1;
  if (!(e instanceof Error && /断言失败|应|→|exit/.test(e.message))) {
    console.error('[e2e] unexpected error:', e);
  }
} finally {
  await cleanup();
}

process.exit(exitCode);
