// Node module customization hook: resolve extensionless relative specifiers.
//
// apps/server's own `dist/` is fully extension-corrected at build time by
// tsc-alias (see package.json "build"). This hook exists for a different
// gap: workspace dependencies such as @learn-shell/contracts ship
// extensionless-import TypeScript source directly (their package.json
// "exports" points at ./src/index.ts, no compiled dist), so `node`'s
// default ESM resolver still hits ERR_MODULE_NOT_FOUND for their internal
// `./envelope`-style imports even though our own dist is fine.
//
// This resolve hook only engages as a *fallback*: it calls the default
// resolver first, and only tries suffixed candidates when that throws
// ERR_MODULE_NOT_FOUND for a relative specifier. Nothing here changes
// resolution for specifiers that already resolve normally.
const CANDIDATE_SUFFIXES = ['.js', '.ts', '/index.js', '/index.ts'];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !isRelative) {
      throw err;
    }
    for (const suffix of CANDIDATE_SUFFIXES) {
      try {
        return await nextResolve(`${specifier}${suffix}`, context);
      } catch {
        // try next candidate
      }
    }
    throw err;
  }
}
