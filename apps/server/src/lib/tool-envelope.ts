// Unified machine receipt envelope construction — Agent Surface Hardening
// 第一批. Split
// out of mcp/server.ts into its own lib module (no side effects — unlike
// mcp/server.ts, which opens a stdio transport at import time, this file is
// safe to import from a unit test; see tool-envelope.test.ts).
//
// Every MCP tool case builds its result through `success()`/`fail()` rather
// than a bare `{ content: [{ type: 'text', text: '<sentence>' }] }`.
// `human_note` keeps the original human-readable sentence; the rest of the
// envelope is for the calling agent to consume without parsing it.
//
// Read/orient tools (get_context, get_learner_brief, live_pending,
// live_session_get, adhoc_thread_get, live_snapshot_get_latest,
// get_teacher_inbox) keep their existing rich JSON payload shape — it
// doesn't fit the resource_id/created_refs mutation shape — carried under
// `data` instead of reshaping it. Nothing outside this MCP process consumes
// these tools' text payloads (apps/web talks REST, never MCP), so this is a
// free reshape, not a breaking wire change for anyone.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpErrorEnvelope, McpSuccessEnvelope } from '@learn-shell/contracts';
import { withIdempotency, IdempotencyKeyReusedError } from './idempotency';
import { McpToolError } from './mcp-errors';

export function toResult(envelope: McpSuccessEnvelope | McpErrorEnvelope): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    ...(envelope.status === 'error' ? { isError: true } : {}),
  };
}

export function buildSuccessEnvelope(
  params: Omit<McpSuccessEnvelope, 'status'>
): McpSuccessEnvelope {
  // learner_url 绝对化的唯一豁口: 所有写工具回执都
  // 从这里过, 不逐处拼。LEARNER_APP_BASE_URL 配置了 ⇒ 相对路径拼成完整链接
  // (bench lane 由 bench-up.sh 传 :5174, 生产由部署环境传); 没配置 ⇒ 保持
  // 相对 + human_note 尾注一行指路——不拿 manifest://capabilities 的
  // localhost:5173 缺省来拼: 那是本地开发的报牌值, 环境没自报 base 时替它
  // 猜一个, 指错门比相对路径更糟。已是完整链接的 learner_url (不以 '/' 开头)
  // 原样放行。
  if (params.learner_url?.startsWith('/')) {
    const base = process.env.LEARNER_APP_BASE_URL?.trim().replace(/\/+$/, '');
    if (base) {
      return { status: 'success', ...params, learner_url: `${base}${params.learner_url}` };
    }
    return {
      status: 'success',
      ...params,
      human_note:
        `${params.human_note} · learner_url is a relative path (LEARNER_APP_BASE_URL not configured; ` +
        'see learner_app_base_url in manifest://capabilities for the base)',
    };
  }
  return { status: 'success', ...params };
}

export function buildErrorEnvelope(params: Omit<McpErrorEnvelope, 'status'>): McpErrorEnvelope {
  return { status: 'error', ...params };
}

export function success(params: Omit<McpSuccessEnvelope, 'status'>): CallToolResult {
  return toResult(buildSuccessEnvelope(params));
}

export function fail(params: Omit<McpErrorEnvelope, 'status'>): CallToolResult {
  return toResult(buildErrorEnvelope(params));
}

/** `payload` is the tool's raw input object (the `args` a case body received
 *  off `req.params.arguments`) — hashed by `withIdempotency` to detect "same
 *  key, different payload" reuse. `idempotency_key` itself is stripped before
 *  hashing here, once, centrally: it rides *inside* that same args object at
 *  every call site, so leaving it in would make the hash trivially
 *  self-consistent (same key ⇒ same idempotency_key field ⇒ payload always
 *  "matches") and defeat the whole point of fingerprinting the rest of the
 *  payload. Call sites pass their `args` object through untouched — no site
 *  needs to remember to strip the key itself. */
function payloadForHash(payload: unknown): unknown {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload) && 'idempotency_key' in payload) {
    const { idempotency_key: _omitted, ...rest } = payload as Record<string, unknown>;
    return rest;
  }
  return payload;
}

/** Runs a mutation's body through withIdempotency and stamps
 *  `idempotent_replay: true` onto the envelope when the stored result from a
 *  prior call with the same key is being replayed instead of a fresh write.
 *  `fn` builds the success envelope itself (via buildSuccessEnvelope) rather
 *  than returning a CallToolResult, so the raw envelope — not its
 *  JSON-stringified text form — is what gets cached and what gets the replay
 *  flag stamped onto it.
 *
 *  `payload` is the tool's raw args object, forwarded to `withIdempotency` for
 *  payload-fingerprint hashing (see idempotency.ts's "known wiring gap" note —
 *  this is that follow-up). See `payloadForHash` above for why idempotency_key
 *  is stripped here rather than at each of the ~30 mcp/server.ts call sites. */
export async function runIdempotentMutation(
  pairId: string,
  operation: string,
  idempotencyKey: string | undefined,
  payload: unknown,
  fn: () => Promise<McpSuccessEnvelope>
): Promise<CallToolResult> {
  const { value: envelope, replayed } = await withIdempotency(pairId, operation, idempotencyKey, fn, {
    payload: payloadForHash(payload),
  });
  return toResult(replayed ? { ...envelope, idempotent_replay: true } : envelope);
}

/** Pure — the classification half of errorFromException, split out for
 *  testability (no DB, no MCP SDK object construction). Given any thrown
 *  value, decides the error envelope fields it should produce. */
export function classifyThrown(e: unknown): Omit<McpErrorEnvelope, 'status'> {
  if (e instanceof IdempotencyKeyReusedError) {
    return {
      code: 'CONFLICT',
      message: e.message,
      retryable: false,
      recovery_hint: 'Mint a fresh idempotency_key per logical mutation — do not reuse one across tools.',
      human_note: e.message,
    };
  }
  if (e instanceof McpToolError) {
    return {
      code: e.code,
      message: e.message,
      retryable: e.retryable,
      recovery_hint: e.recovery_hint,
      human_note: e.message,
      details: e.details,
    };
  }

  // From an incident (bench run 0) — driver/DB errors used to fall through to a
  // blanket RETRYABLE, which sent a fresh candidate agent into a six-retry
  // loop against a deterministic failure. Map the recognizable deterministic
  // codes to honest classifications before the RETRYABLE fallback:
  //   UNDEFINED_VALUE — postgres-js client-side (postgres/src/types.js): an
  //     `undefined` reached a query parameter. Always a missing/undefined
  //     argument (or a server bug), never transient. Handlers should have
  //     validated first (lib/tool-args.ts) — this mapping is the safety net
  //     for any site the sweep missed.
  //   23502 not_null_violation / 23514 check_violation — bad input, VALIDATION.
  //   23503 foreign_key_violation — a referenced id doesn't exist, NOT_FOUND.
  //   23505 unique_violation — duplicate write, CONFLICT.
  const message = e instanceof Error ? e.message : String(e);
  const dbCode = (e as { code?: unknown } | null | undefined)?.code;
  if (dbCode === 'UNDEFINED_VALUE') {
    return {
      code: 'VALIDATION',
      message,
      retryable: false,
      recovery_hint:
        "An argument the query needed was undefined — re-check this tool's required fields " +
        'against its inputSchema and resend with every required field present. Retrying unchanged will fail identically.',
      human_note: message,
    };
  }
  if (dbCode === '23502' || dbCode === '23514') {
    return {
      code: 'VALIDATION',
      message,
      retryable: false,
      recovery_hint:
        'The database rejected the row (missing required column / constraint violation) — ' +
        'fix the named field and resend. Retrying unchanged will fail identically.',
      human_note: message,
    };
  }
  if (dbCode === '23503') {
    return {
      code: 'NOT_FOUND',
      message,
      retryable: false,
      recovery_hint:
        'A referenced id does not exist (foreign key violation) — re-check the id; it may be stale, ' +
        'mistyped, or belong to a different pair.',
      human_note: message,
    };
  }
  if (dbCode === '23505') {
    return {
      code: 'CONFLICT',
      message,
      retryable: false,
      recovery_hint:
        'A row with this unique value already exists — read the current state before retrying.',
      human_note: message,
    };
  }

  return {
    code: 'RETRYABLE',
    message,
    retryable: true,
    recovery_hint: 'Unexpected server error — retry; if it persists, check server logs.',
    human_note: message,
  };
}

/** Converts any thrown error into an error CallToolResult — the catch-all
 *  landing spot for the outer try/catch around every tool call (see
 *  mcp/server.ts's CallToolRequestSchema handler). `McpToolError` (thrown
 *  deliberately from case bodies via validationError/notFoundError/etc, see
 *  lib/mcp-errors.ts) carries its own code/retryable/recovery_hint;
 *  `IdempotencyKeyReusedError` is always a CONFLICT; anything else
 *  (unexpected exception — DB blip, bug) falls back to RETRYABLE, since an
 *  agent retrying an unrecognized failure is a safer default than it giving
 *  up. This is the "抛出兼容层" the MCP SDK still gets to rely on: throwing a
 *  plain Error from a case body still produces a well-formed envelope, it's
 *  just classified less precisely than a deliberate McpToolError. */
export function errorFromException(e: unknown): CallToolResult {
  return fail(classifyThrown(e));
}
