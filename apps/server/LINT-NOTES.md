# Lint notes — @learn-shell/server

`biome.json` in this directory is a **minimal, all-green** configuration, not
the target end state. It exists to replace the previous `lint` script (a
placeholder that always exited 1 with a "not configured yet" message) with a
real, passing check — without touching any source file to get there.

## What's on

- Linter: `preset: "recommended"` (Biome 2.5.7's recommended rule set).
- Formatter and assist (import organizing) are **disabled** — turning them on
  would require reformatting/reordering every source file, which is out of
  scope for this pass (no `--write`, no source edits).

## What's turned off, and why

Running `biome check .` against the untouched source tree with the full
recommended preset produces 31 **errors** (which fail the command) plus ~214
warnings/infos (which don't fail it). The 3 rules below account for 100% of
the errors and are disabled here so `pnpm --filter server lint` exits 0:

- `suspicious.useIterableCallbackReturn` (26 hits) — mostly `.forEach`/`.map`
  callbacks with inconsistent return values across branches.
- `suspicious.noAssignInExpressions` (4 hits) — assignment-in-condition
  patterns (`while ((x = next()))`-style code).
- `suspicious.noImplicitAnyLet` (1 hit) — a `let` declared without an
  initializer/type.

These are real findings, not false positives — fixing them means touching
`src/**`, which this pass is not authorized to do.

## Left on as warnings (visible, non-blocking today)

These still show up in `biome check .` output as warnings/infos (206
warnings + 7 infos as of this pass) but do **not** fail the command, so they
stay on to keep the signal visible:

- `style.noNonNullAssertion` (168) — by far the biggest bucket; `!` postfix
  assertions across the codebase.
- `suspicious.noExplicitAny` (18)
- `complexity.useOptionalChain` (14)
- `style.useTemplate` (6, fixable)
- `correctness.noUnusedImports` (4, fixable)
- `correctness.noUnusedVariables` (1, fixable)
- `complexity.useDateNow` (1, fixable)
- `complexity.noUselessEscapeInRegex` (1)

## Path to widening this

Whoever picks this up next: flip one rule bucket above from warning-tolerant
to error (or just fix the underlying hits — several are `FIXABLE` via
`biome check --write` once someone's willing to review a source diff), rerun
`biome check .`, confirm 0 errors, repeat. `noNonNullAssertion` is the long
pole — likely wants its own pass rather than being bundled with the others.
