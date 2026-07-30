// Drizzle + postgres-js client.
//
// 连接池是惰性单例: 池在"第一次真正被用到"的那一刻才建, 一个进程内只建一次。
//
// 为什么必须惰性 —— 这里曾经有一个指向**生产库名**的缺省连接串
// ('postgresql://learn_shell:learn_shell_dev@localhost:5432/learn_shell'),
// 在模块顶层就被求值。忘设 DATABASE_URL 的进程不会报错, 只会安静地连上生产库
// (lib/require-bench-db.ts 的注释里指认的正是这一处; 7/19 t144test 入侵案就是
// 这个形状)。缺省必须删掉, 换成 requireDatabaseUrl 的"缺失即拒"。
//
// 但"顶层直接必填"会砸掉另一头: 十几个测试文件在模块顶层 import 本模块, 其中
// 若干个没有 RUN_DB_TESTS 门控, 靠的就是"import 不落地连接、跳过即可"。顶层抛错
// 会把无 DB 环境下的"优雅跳过"变成"顶层崩溃"。
//
// 惰性化同时满足两头: import 不读环境变量、不建池、不抛错; 而任何一次真实的
// 查询都会先撞 requireDatabaseUrl 那堵墙。想连库的必须先说清连哪个库, 只想
// import 的不用付这个代价。

import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema/index';
import { requireDatabaseUrl } from './require-database-url';

type TypeMap = Record<number, (value: never) => unknown>;

// drizzle 在 construct 的那一刻(见 postgres-js/driver.js)就会往
// `client.options.parsers` / `client.options.serializers` 里塞 6 个
// transparent parser 覆盖 postgres-js 的默认日期解析。那是**唯一**一处
// 建 db 时就要摸到 client 的地方(session 构造只是把 client 存起来)。
// 池这会儿还不该存在, 所以先把这些写入接在下面两张暂存表里, 建池时原样并进去。
const deferredParsers: TypeMap = {};
const deferredSerializers: TypeMap = {};

function createQueryClient() {
  const sql = postgres(requireDatabaseUrl('db/client'), {
    // dev-friendly settings; tweak for prod
    max: 10,
    idle_timeout: 30,
    connect_timeout: 5,
  });

  Object.assign(sql.options.parsers, deferredParsers);
  Object.assign(sql.options.serializers, deferredSerializers);

  return sql;
}

type QueryClientHandle = ReturnType<typeof createQueryClient>;

let pool: QueryClientHandle | undefined;

function resolvePool(): QueryClientHandle {
  pool ??= createQueryClient();
  return pool;
}

/** `queryClient.options` 在池建立之前的替身。
 *
 *  只有 parsers / serializers 两张表允许在无池状态下拿到(那是 drizzle 构造
 *  时唯一要动的东西); 其余任何字段都照常去要真池——也就是说, 池不在、
 *  DATABASE_URL 又没设的时候, 读 `options.host` 会响亮地撞 requireDatabaseUrl,
 *  而不是拿到一个安静的 undefined。宁可炸也不给假答案。 */
const deferredOptions = new Proxy({} as Record<PropertyKey, unknown>, {
  get(_target, prop) {
    if (!pool) {
      if (prop === 'parsers') return deferredParsers;
      if (prop === 'serializers') return deferredSerializers;
    }
    return Reflect.get(resolvePool().options, prop);
  },
  set(_target, prop, value) {
    return Reflect.set(resolvePool().options, prop, value);
  },
  has(_target, prop) {
    return Reflect.has(resolvePool().options, prop);
  },
  ownKeys() {
    return Reflect.ownKeys(resolvePool().options);
  },
  getOwnPropertyDescriptor(_target, prop) {
    const descriptor = Reflect.getOwnPropertyDescriptor(resolvePool().options, prop);
    // 壳上没有对应属性, 报 non-configurable 会直接违反 Proxy 不变式。
    return descriptor ? { ...descriptor, configurable: true } : undefined;
  },
});

// Exported (not just `const`) so callers that need the raw tagged-template
// sql interface — rather than drizzle's query builder — can reuse this same
// pool instead of opening a second connection. verify_prep (mcp/server.ts)
// is the first consumer: lib/validate-prep-core.ts's validateLesson/
// resolveCourseLessonIds were lifted out of scripts/validate-prep.ts, which
// wrote them against postgres-js's raw `sql` tag directly (not drizzle) —
// passing this queryClient in lets the long-running MCP server reuse it
// verbatim instead of forking the query layer or opening a short-lived
// second pool per call (which the CLI does, fine for a one-shot process,
// wasteful for a server that's already up).
//
// 这是个门面, 不是池本身: 池在第一次调用/取属性时才建。壳用箭头函数, 一来让
// 代理可调用(保住 sql`SELECT 1` 这种 tagged-template 用法, verify_prep 在用),
// 二来不带 function 声明那个 non-configurable 的 `prototype` own property 去跟
// Proxy 不变式打架。
//
// 缓存 bind 结果, 让 queryClient.unsafe === queryClient.unsafe 仍然成立。
const boundMethods = new WeakMap<object, unknown>();

export const queryClient: QueryClientHandle = new Proxy(
  (() => undefined) as unknown as QueryClientHandle,
  {
    apply(_target, thisArg, args) {
      const sql = resolvePool() as unknown as (...callArgs: unknown[]) => unknown;
      return Reflect.apply(sql, thisArg, args);
    },
    get(_target, prop) {
      if (prop === 'options') return pool ? pool.options : deferredOptions;

      const sql = resolvePool();
      const value = Reflect.get(sql, prop, sql);
      if (typeof value !== 'function') return value;

      let bound = boundMethods.get(value as object);
      if (!bound) {
        bound = (value as (...callArgs: unknown[]) => unknown).bind(sql);
        boundMethods.set(value as object, bound);
      }
      return bound;
    },
    set(_target, prop, value) {
      const sql = resolvePool();
      return Reflect.set(sql, prop, value, sql);
    },
    has(_target, prop) {
      return Reflect.has(resolvePool(), prop);
    },
    deleteProperty(_target, prop) {
      return Reflect.deleteProperty(resolvePool(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(resolvePool());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolvePool(), prop);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    defineProperty(_target, prop, descriptor) {
      return Reflect.defineProperty(resolvePool(), prop, descriptor);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(resolvePool());
    },
  }
) as QueryClientHandle;

// `db` 本身不是代理, 是货真价实的 drizzle 实例 —— 建它不需要连接, 只需要上面
// 那个门面。保持真身很重要: mock.method(db, 'execute', ...) 这类不碰 DB 的
// 测试(lib/health.test.ts)要能在没有 DATABASE_URL 的环境里照常打桩。
export const db = drizzle(queryClient, { schema });
export type DB = typeof db;

/** Structural type covering both `db` and a `db.transaction(tx => ...)`
 *  handle — both extend PgDatabase and expose the same query builder methods
 *  (select/insert/update/delete). Lets write-path helpers (appendSessionEvent,
 *  withIdempotency) accept either, so a caller can fold multiple statements
 *  into one transaction (Agent Surface Hardening 第一批). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbClient = PgDatabase<any, any, any>;

// For shutdown hooks if we ever need them.
//
// 池从没建起来就是 no-op —— 不为了关一个池而先建一个池(那会把
// requireDatabaseUrl 那堵墙搬到关闭路径上; 关一个从不存在的连接不该要求
// DATABASE_URL)。
export async function closeDb(): Promise<void> {
  if (!pool) return;
  await pool.end({ timeout: 5 });
}
