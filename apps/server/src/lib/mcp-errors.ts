// Structured MCP tool errors — Agent Surface Hardening 第一批
// ("错误区分 retryable、conflict、permission、validation 与 not-found").
//
// Thrown from case bodies in mcp/server.ts exactly where the old code did
// `throw new Error(...)`, but carrying a `code` from the closed five-family
// taxonomy so the outer catch (see mcp/server.ts's CallToolRequestSchema
// handler) can build the right error envelope without guessing from message
// text. Throwing is still how these propagate — MCP SDK tool handlers are
// plain async functions, there's no separate "return an error" channel at
// this layer other than throwing or returning `{ isError: true, content }`
// — so this keeps the throw-based compatibility shape the SDK needs while
// giving the outer catch enough structure to do better than "everything is
// RETRYABLE". A raw `Error` (or anything else unexpected — a DB blip, a bug)
// still gets caught too; it just falls back to RETRYABLE (see mcp/server.ts).

import type { McpErrorCode } from '@learn-shell/contracts';

export class McpToolError extends Error {
  code: McpErrorCode;
  retryable: boolean;
  recovery_hint: string;
  details?: Record<string, unknown>;

  constructor(
    code: McpErrorCode,
    message: string,
    opts?: { retryable?: boolean; recovery_hint?: string; details?: Record<string, unknown> }
  ) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    this.retryable = opts?.retryable ?? code === 'RETRYABLE';
    this.recovery_hint = opts?.recovery_hint ?? defaultRecoveryHint(code);
    this.details = opts?.details;
  }
}

function defaultRecoveryHint(code: McpErrorCode): string {
  switch (code) {
    case 'VALIDATION':
      return 'Fix the input field(s) named in the message and retry the call.';
    case 'NOT_FOUND':
      return 'Re-check the id — it may be stale, deleted, or belong to a different pair.';
    case 'CONFLICT':
      return 'Reload the current state before retrying — a concurrent write or reused key changed what this call expected.';
    case 'PERMISSION':
      return 'Not permitted under the current scope/gate — do not retry as-is.';
    case 'RETRYABLE':
      return 'Transient failure — safe to retry the same call.';
  }
}

export function validationError(message: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('VALIDATION', message, { retryable: false, details });
}

export function notFoundError(message: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('NOT_FOUND', message, { retryable: false, details });
}

export function conflictError(message: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError('CONFLICT', message, { retryable: true, details });
}

export function permissionError(
  message: string,
  details?: Record<string, unknown>,
  recovery_hint?: string
): McpToolError {
  return new McpToolError('PERMISSION', message, { retryable: false, details, recovery_hint });
}
