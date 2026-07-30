// Argument validation helpers for MCP tool handlers / REST bodies — from an
// incident (bench fresh-agent run 0: adhoc_message_send 六连 UNDEFINED_VALUE).
//
// Root cause: the MCP SDK does NOT enforce a tool's inputSchema
// `required` list — a candidate agent that omits a required arg sails
// straight into the handler with `args.xxx === undefined`. drizzle-orm
// 0.36's three positions then behave very differently (verified against the
// installed package source, see the batch report's判定表):
//
//   .values({ col: undefined })  → drizzle emits SQL `DEFAULT` for that
//                                  column (pg-core/dialect.js buildInsertQuery)
//                                  — nullable col → NULL, NOT NULL col → a
//                                  clear not-null violation. Never crashes
//                                  the driver.
//   .set({ col: undefined })     → entry silently dropped (utils.js
//                                  mapUpdateSet filters `value !== undefined`);
//                                  all-undefined → "No values to set" throw.
//   eq(col, undefined) / any     → drizzle binds a Param(undefined) and
//   WHERE/query parameter          postgres-js REJECTS it client-side:
//                                  `UNDEFINED_VALUE: Undefined values are
//                                  not allowed` (postgres/src/types.js). THIS
//                                  is the lethal position — the crash was
//                                  eq(ad_hoc_messages.client_message_id,
//                                  undefined) in the dedupe select.
//
// So: every handler arg that can reach a query parameter must be validated
// (or defaulted) before the first query touches it. These helpers throw
// McpToolError(VALIDATION) — the envelope layer (lib/tool-envelope.ts) turns
// that into a precise, non-retryable error the calling agent can self-correct
// from, instead of the misleading RETRYABLE it got from the raw driver error.

import { validationError } from './mcp-errors';

/** Returns args[key] as a non-empty trimmed string, or throws a VALIDATION
 *  McpToolError naming the missing/invalid field. Use for every required
 *  string arg — especially any that reaches a WHERE/eq() parameter. */
export function requireStringArg(args: Record<string, unknown>, key: string): string {
  const raw = args[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw validationError(
      `${key} is required (non-empty string) — got ${raw === undefined ? 'nothing' : JSON.stringify(raw)}.`,
      { field: key }
    );
  }
  return raw;
}

/** Returns args[key] as a finite number, or throws VALIDATION. */
export function requireNumberArg(args: Record<string, unknown>, key: string): number {
  const raw = args[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw validationError(
      `${key} is required (number) — got ${raw === undefined ? 'nothing' : JSON.stringify(raw)}.`,
      { field: key }
    );
  }
  return raw;
}

/** Resolution for adhoc_message_send's client_message_id: the field
 *  used to be schema-required but SDK-unenforced, so omitting it crashed the
 *  dedupe select with UNDEFINED_VALUE. Now optional-with-default — a missing/
 *  blank value gets a server-minted id (same posture as every other tool's
 *  optional idempotency_key: supplying your own key is what buys you replay
 *  dedupe; omitting it just means this call has no retry protection). */
export function resolveClientMessageId(raw: unknown): { id: string; generated: boolean } {
  if (typeof raw === 'string' && raw.trim() !== '') {
    return { id: raw, generated: false };
  }
  return {
    id: `ahmcli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    generated: true,
  };
}
