// @learn-shell/server
//
// Hono REST + (future) MCP server.
// Round 2 backend bootstrap (Stage B1): /health now does a real DB ping.
// Stages B2-B8 will fill schemas / REST routes / MCP server.

// P1-02: apps/server/.env 真加载 — 必须排第一行, 早于下面 './db/client'
// (模块加载时就读 process.env.DATABASE_URL 建连接池)。
import './load-env';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sql } from 'drizzle-orm';
import { CONTRACTS_VERSION } from '@learn-shell/contracts';
import { db } from './db/client';
import { redactConnectionString } from './lib/redact-connection-string';
import readRoutes from './routes/read';
import writeRoutes from './routes/write';
import teachingRoutes from './routes/teaching';
import adhocRoutes from './routes/adhoc';
import annotationRoutes from './routes/annotations';
import documentRoutes from './routes/documents';
import exportRoutes from './routes/export';
import syllabusRoutes from './routes/syllabus';
import versionRoutes from './routes/version';

const app = new Hono();

// CORS — apps/web dev (:5173) needs to fetch from :3000.
const corsOrigins = (
  process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:4173'
)
  .split(',')
  .map((s) => s.trim());

app.use(
  '*',
  cors({
    origin: corsOrigins,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  })
);

app.get('/health', async (c) => {
  let dbStatus: 'ok' | 'unreachable' = 'unreachable';
  let dbError: string | null = null;
  try {
    await db.execute(sql`select 1`);
    dbStatus = 'ok';
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }
  // degraded 不许伪装健康: db 不可达时回 503, 别让 200 骗探活方 (apps/web
  // 的自动切 live / 任何外部监控) 以为服务健康——body 结构不变 (status:
  // 'degraded' 照旧), 只是状态码从 200 改说实话。
  return c.json(
    {
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      contracts_version: CONTRACTS_VERSION,
      server: '@learn-shell/server',
      db: dbStatus,
      db_error: dbError,
      timestamp: new Date().toISOString(),
    },
    dbStatus === 'ok' ? 200 : 503
  );
});

// REST API
app.route('/api', readRoutes);
app.route('/api', writeRoutes);
app.route('/api/teaching', teachingRoutes);
app.route('/api/adhoc', adhocRoutes);
app.route('/api', annotationRoutes);
app.route('/api', documentRoutes);
app.route('/api', exportRoutes);
app.route('/api', syllabusRoutes);
app.route('/api', versionRoutes);

const port = Number(process.env.PORT ?? 3000);

// v1 trust model = single-machine (no auth exists by design — see README/SETUP
// security notice). Default bind is loopback-only so the server is invisible
// off-host out of the box; HOST=0.0.0.0 is an explicit opt-in to LAN exposure
// (self-host / off-machine topology — see SETUP.md §5.5).
const hostname = process.env.HOST ?? '127.0.0.1';

if (import.meta.url === `file://${process.argv[1]}`) {
  serve({ fetch: app.fetch, port, hostname });
  const exposureNote =
    hostname === '127.0.0.1' || hostname === 'localhost'
      ? '(loopback-only)'
      : '(⚠️ LAN/network-exposed — no auth exists, only do this on a trusted network)';
  console.log(`[learn-shell/server] listening on ${hostname}:${port} ${exposureNote}`);
  console.log(
    `[learn-shell/server] DATABASE_URL = ${redactConnectionString(process.env.DATABASE_URL)} (host:port/database only — the password is never logged)`
  );
}

export default app;
