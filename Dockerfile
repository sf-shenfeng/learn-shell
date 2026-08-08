# syntax=docker/dockerfile:1
#
# Learn Shell MCP server — image for Glama.ai's registry quality-check bot.
# That bot builds this image and runs the container as a bare subprocess
# with no Postgres and no env vars set; it expects a clean MCP stdio
# `initialize` handshake, not a crash or a hang. See docker/entrypoint.sh
# for how that contract is met (LS_INSPECT=1 fallback).
#
# Two stages:
#   builder  — full pnpm workspace + devDependencies, runs `tsc` (this repo
#              has no bundler; dist/ is a straight tsc + tsc-alias output —
#              see apps/server/package.json "build").
#   runtime  — only the compiled dist/, production node_modules, and the
#              few runtime-read resource directories (skills/, docs/recipes)
#              the MCP server reads by path at request time.
#
# Scope: only @learn-shell/server and its one workspace dependency,
# @learn-shell/contracts, are ever copied into the build context. apps/web
# and packages/ui are never touched, so their unrelated toolchain (Vite,
# sharp, onnxruntime-node, …) can't become a failure mode for this image.

ARG NODE_IMAGE=node:22-slim

# -----------------------------------------------------------------------
# builder
# -----------------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder

# corepack ships with Node but isn't activated by default. Pin the exact
# pnpm version the lockfile was produced with (root package.json
# "packageManager") instead of letting corepack silently pick a drifted one.
RUN corepack enable && corepack prepare pnpm@11.1.3 --activate

WORKDIR /app

# Manifests first, source later — keeps `pnpm install`'s layer cached across
# source-only edits. Only server + contracts manifests: pnpm tolerates a
# workspace subset that's missing other lockfile-listed projects (verified
# locally — `pnpm install --frozen-lockfile` succeeds with apps/web and
# packages/ui absent from the checkout entirely).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json

# Full (dev+prod) install — tsc/tsc-alias are devDependencies of
# @learn-shell/server and are required for the build step below.
# --frozen-lockfile: fail loudly on any drift instead of silently
# reresolving inside an unattended registry build bot.
RUN pnpm install --frozen-lockfile

# The rest of the two packages this image actually builds.
COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY apps/server/src apps/server/src
COPY apps/server/scripts apps/server/scripts
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/contracts/src packages/contracts/src

# Runtime resources the MCP server reads by filesystem path at request time
# (not bundled by tsc). apps/server/src/mcp/server.ts computes SKILLS_DIR
# and RECIPES_DIR as `<repo-root>/skills` and `<repo-root>/docs/recipes` via
# __dirname math off the compiled file's own location (4 levels up from
# dist/mcp/server.js) — so these two directories have to exist at that exact
# relative depth in the image, not just "somewhere". Only the docs/ subset
# server.ts actually reads is copied — docs/media/ alone is 5MB+ of images
# for the docs site that no runtime code path touches.
COPY skills skills
COPY docs/recipes docs/recipes
COPY docs/LESSON-BLOCKS-v1.md docs/LESSON-BLOCKS-v1.md

# `tsc && tsc-alias` (apps/server/package.json "build"). Verified locally:
# produces dist/mcp/server.js with all relative imports extension-corrected.
RUN pnpm --filter @learn-shell/server build

# Prune devDependencies (tsx/typescript/tsc-alias/drizzle-kit/biome/turbo —
# none needed to run compiled dist/). This is a from-scratch reinstall, not
# an in-place `pnpm install --prod` over the existing dev install: verified
# locally that mutating in place leaves *dangling* symlinks behind for
# per-project devDependencies (e.g. apps/server/node_modules/tsx pointing at
# a now-nonexistent root node_modules/.pnpm/tsx@…) because pnpm doesn't
# re-sync already-linked project-level node_modules dirs against a pruned
# root store. Deleting all three node_modules first and reinstalling
# --prod fresh avoids that entirely — confirmed clean afterwards with
# `find . -xtype l` (zero dangling links) both here and in the copied
# runtime image. CI=true skips pnpm's interactive TTY confirmation before
# it recreates node_modules this way; there's no TTY in a build bot.
#
# Deliberately NOT `pnpm deploy --prod` here, despite it being the more
# obvious tool for "flatten to a self-contained prod dir": pnpm deploy
# re-links workspace dependencies through the content-addressable store
# (node_modules/.pnpm/@learn-shell+contracts@file+…/node_modules/…), and
# Node's own ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING guard refuses to
# type-strip .ts files once they're found under node_modules — which is
# exactly how @learn-shell/contracts ships (package.json "exports" points
# at ./src/index.ts directly, no dist/, no enums/namespaces/parameter
# properties, all erasable-syntax TS that Node 22's native type stripping
# otherwise handles fine). Confirmed this failure locally with a real
# `pnpm deploy --legacy` run.
#
# Plain `pnpm install --prod` keeps pnpm's ordinary workspace linking
# instead, which symlinks workspace:* deps straight to their source
# directory — apps/server/node_modules/@learn-shell/contracts resolves to
# ../../../../packages/contracts, which is outside node_modules from
# Node's own resolution/realpath point of view, so native type stripping
# still applies to it. Confirmed end-to-end locally, both before and after
# this prune step: LS_INSPECT=1 boot → initialize handshake → tools/list
# (50 tools) → get_context call returns the clean structured PERMISSION
# envelope, not a stack trace.
RUN rm -rf node_modules apps/server/node_modules packages/contracts/node_modules \
  && CI=true pnpm install --prod --frozen-lockfile

# -----------------------------------------------------------------------
# runtime
# -----------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# Mirrors the builder's relative depth exactly — two different symlink
# families depend on it:
#   - apps/server/node_modules/@learn-shell/contracts is a *relative*
#     symlink straight to source: ../../../../packages/contracts.
#   - every ordinary dependency under apps/server/node_modules (e.g.
#     @modelcontextprotocol/sdk, drizzle-orm) is a relative symlink into
#     the shared pnpm virtual store one level higher — e.g.
#     ../../../../node_modules/.pnpm/@modelcontextprotocol+sdk@…/… — so
#     the *root* node_modules (holding .pnpm/) has to be copied too, not
#     just apps/server/node_modules itself, or these resolve to nothing.
#     Verified locally with `find . -xtype l` (zero dangling links) against
#     this exact set of COPY paths before trusting it here.
# apps/web and packages/ui are absent on purpose (see header comment);
# nothing under apps/server/dist/mcp references them.
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/apps/server/dist apps/server/dist
COPY --from=builder /app/apps/server/scripts apps/server/scripts
COPY --from=builder /app/apps/server/package.json apps/server/package.json
COPY --from=builder /app/apps/server/node_modules apps/server/node_modules
COPY --from=builder /app/packages/contracts packages/contracts
COPY --from=builder /app/skills skills
COPY --from=builder /app/docs docs

COPY docker/entrypoint.sh /app/entrypoint.sh

# node:22-slim ships a preexisting uid-1000 "node" user in every official
# variant (full/slim/alpine) — run as it rather than root. Nothing here
# needs root: stdio transport only, no privileged ports, no bind mounts.
RUN chmod +x /app/entrypoint.sh && chown -R node:node /app
USER node

# entrypoint.sh's `--import ./scripts/register-esm-hooks.mjs` and
# `dist/mcp/server.js` args are cwd-relative (matches how apps/server's own
# "start"/"mcp" package.json scripts run), hence pinning WORKDIR here rather
# than passing absolute paths.
WORKDIR /app/apps/server

# No HEALTHCHECK: this is a stdio subprocess, not an HTTP service — there's
# no port for a healthcheck to probe, and the registry bot itself measures
# health as "did the initialize handshake succeed."
ENTRYPOINT ["/app/entrypoint.sh"]
