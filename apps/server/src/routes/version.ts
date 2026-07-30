// Hono REST route — GET /api/version (deploy-verification).
//
// 部署完成的定义是新代码在端口上呼吸——此端点是呼吸的指纹.
//
// sha is resolved WITHOUT spawning a child process (no `git rev-parse`):
// read .git/HEAD directly at module load (boot time) and cache the result —
// boot_at doubles as the restart proof (a redeploy always gets a fresh
// timestamp even if the sha is unchanged, e.g. a config-only restart).
// Handles both HEAD forms:
//   - symbolic: "ref: refs/heads/main"  -> read .git/<ref> for the sha
//   - detached: a raw 40-char sha written directly into HEAD
// If .git is missing entirely (e.g. a tarball/trial install with no git
// checkout), this must never crash boot — falls back to sha: null,
// source: 'no-git'.

import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const v = new Hono();

type VersionSource = 'head' | 'ref' | 'no-git' | 'error';

interface VersionInfo {
  sha: string | null;
  sha_short: string | null;
  boot_at: string;
  node_env?: string;
  source: VersionSource;
}

function resolveSha(): { sha: string | null; source: VersionSource } {
  // apps/server/src/routes -> apps/server/src -> apps/server -> apps -> repo root
  // (same depth/pattern as SKILLS_DIR/RECIPES_DIR in ../mcp/server.ts)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const repoRoot = resolve(__dirname, '..', '..', '..', '..');
  const gitDir = resolve(repoRoot, '.git');

  try {
    const head = readFileSync(resolve(gitDir, 'HEAD'), 'utf8').trim();
    const refMatch = head.match(/^ref:\s*(.+)$/);
    if (refMatch && refMatch[1]) {
      const refPath = refMatch[1].trim();
      try {
        const sha = readFileSync(resolve(gitDir, refPath), 'utf8').trim();
        return { sha, source: 'ref' };
      } catch {
        // Symbolic ref present but the ref file itself is missing (e.g.
        // packed-refs only, or a fresh repo with no commits yet) — no
        // child process fallback per spec; report null rather than guess.
        return { sha: null, source: 'error' };
      }
    }
    // Detached HEAD: HEAD contains the sha directly.
    return { sha: head, source: 'head' };
  } catch {
    // No .git/HEAD readable at all — most likely no .git dir (tarball
    // install). Never let this throw during module load / boot.
    return { sha: null, source: 'no-git' };
  }
}

// Cached at module load (boot time) — not recomputed per-request.
const { sha, source } = resolveSha();
const sha_short = sha ? sha.slice(0, 7) : null;
const boot_at = new Date().toISOString();

v.get('/version', (c) => {
  const info: VersionInfo = {
    sha,
    sha_short,
    boot_at,
    source,
  };
  if (process.env.NODE_ENV) {
    info.node_env = process.env.NODE_ENV;
  }
  return c.json(info);
});

export default v;
