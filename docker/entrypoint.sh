#!/bin/sh
# Learn Shell MCP server — container entrypoint contract:
#
#   DATABASE_URL unset/empty → boot in LS_INSPECT=1 (no-DB inspection mode).
#   DATABASE_URL set         → boot for real, against that database.
#
# Why this exists: Glama.ai's registry quality-check bot builds the image
# from the repo root Dockerfile and runs it as a bare container — no
# Postgres attached, no env vars set. That is not a real deployment, it's
# "does this MCP server start and answer initialize/tools-list cleanly."
# Without this fallback the process would hit requireDatabaseUrl() on the
# first DB-backed call (apps/server/src/db/require-database-url.ts) and
# either hang waiting for a connection or crash — instead of completing the
# handshake the bot is actually checking for.
#
# LS_INSPECT=1 (apps/server/src/mcp/server.ts) keeps the full
# initialize + tools/list + prompts/list + resources/list surface working
# with zero DB attached, and turns every DB-backed tool call into a clean
# structured `{"status":"error","code":"PERMISSION",...}` envelope instead
# of a stack trace or a hang. Same scenario apps/server/src/mcp/
# ls-inspect.smoke.test.ts exercises against the tsx dev entrypoint;
# verified by hand here against this image's actual production entrypoint
# (node --import … dist/mcp/server.js) before shipping this file.
#
# A real deployment (DATABASE_URL set) skips the export below and starts
# the exact same binary in its normal, fully-functional mode — this script
# never diverges the two paths beyond that one env var.
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  export LS_INSPECT=1
fi

# Same --import apps/server's own "start" script uses (package.json):
# @learn-shell/contracts ships raw .ts source (no dist/, package.json
# "exports" points straight at ./src/index.ts) with extensionless relative
# imports Node's default ESM resolver can't find on its own.
# register-esm-hooks.mjs installs the fallback resolver
# (scripts/esm-ext-hooks.mjs) that makes those resolve. Both paths below are
# cwd-relative, which is why the Dockerfile pins WORKDIR to apps/server.
exec node --import ./scripts/register-esm-hooks.mjs dist/mcp/server.js
