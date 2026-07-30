// Runtime "does this args object match its declared inputSchema shape" guard
// — Live 2.0 W3 schema-by-need suite (red team P1: "让老师不需要猜 schema").
//
// The MCP SDK does not enforce inputSchema server-side at all (see
// lib/tool-args.ts header for that story) — `additionalProperties: false`
// declared on every tool's inputSchema (mcp/server.ts TOOL_DEFINITIONS) is
// therefore honest-but-toothless unless something actually walks `args`
// against it before the handler runs. This module is that something: one
// recursive walk, hooked once in mcp/server.ts's handleToolCall dispatch
// (top of the function, before the switch), instead of every case body
// re-deriving its own "did you typo a field" check.
//
// Scope: only sub-schemas that declare a `properties` map are checked — a
// sub-schema with no declared shape (e.g. a genuinely free-form payload blob
// like live_message_send's `payload`, or `hints` inside adhoc_message_send's
// payload) is left alone; there is nothing to compare against, and rejecting
// every key would just brick a deliberately-open field. See mcp/server.ts's
// TOOL_DEFINITIONS comments for the short, explicit list of fields left this
// way on purpose.

export interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
  [key: string]: unknown;
}

export interface UnknownFieldViolation {
  field_path: string;
  received: unknown;
  expected: 'not a recognized field';
  candidates: string[];
  next_required_action: string;
}

/** Levenshtein edit distance. Inputs here are always short field names, so
 *  the O(n*m) DP table is plenty fast — no need for a rolling-array variant. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

/** Nearest `limit` known field names to `unknownKey` by edit distance,
 *  closest first (ties broken alphabetically for determinism). */
export function nearestFieldNames(unknownKey: string, known: string[], limit = 3): string[] {
  return [...known]
    .map((name) => ({ name, dist: levenshtein(unknownKey, name) }))
    .sort((a, b) => a.dist - b.dist || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((x) => x.name);
}

function schemaHint(toolName: string): string {
  return `Call \`schema ${toolName}\` (candidate-mcp.sh) or MCP tools/list for the full valid field list before retrying.`;
}

/** Recursively walks `value` against `schema`, returning the FIRST
 *  unknown-field violation found (fail-fast — one structured error per call,
 *  same posture as requireStringArg/requireNumberArg in lib/tool-args.ts).
 *  Only descends into a nested object / array-of-object sub-schema when that
 *  sub-schema itself declares `properties` — a sub-schema with no declared
 *  shape is intentionally left unchecked (see file header). */
export function findUnknownField(
  schema: JsonSchemaLike | undefined,
  value: unknown,
  toolName: string,
  pathPrefix = ''
): UnknownFieldViolation | null {
  if (!schema || !schema.properties) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

  const properties = schema.properties;
  const known = Object.keys(properties);
  const knownSet = new Set(known);
  const obj = value as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (!knownSet.has(key)) {
      return {
        field_path: path,
        received: obj[key],
        expected: 'not a recognized field',
        candidates: nearestFieldNames(key, known),
        next_required_action: schemaHint(toolName),
      };
    }

    const subSchema = properties[key];
    const subValue = obj[key];
    if (subSchema?.type === 'object' && subSchema.properties) {
      const nested = findUnknownField(subSchema, subValue, toolName, path);
      if (nested) return nested;
    } else if (
      subSchema?.type === 'array' &&
      subSchema.items?.type === 'object' &&
      subSchema.items.properties &&
      Array.isArray(subValue)
    ) {
      for (let i = 0; i < subValue.length; i++) {
        const nested = findUnknownField(subSchema.items, subValue[i], toolName, `${path}[${i}]`);
        if (nested) return nested;
      }
    }
  }
  return null;
}
