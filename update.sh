#!/bin/bash
# update.sh — one-command upgrade from a previous learn-shell trial snapshot.
#
# Usage (from THIS new folder, after extracting the new tarball):
#   ./update.sh /path/to/your/previous/learn-shell-trial
#
# What it does, in order:
#   1. carries over your private local files from the old folder
#      (.env, whisper-terms.local.ts) — if you never created them, skips silently
#   2. pnpm install       (fast — pnpm caches; only new deps download)
#   3. pg_dump backup     (best-effort: dumps your database to a timestamped
#                          .sql file in this folder before migrating; if pg_dump
#                          is missing or fails, warns loudly and asks you to
#                          confirm before continuing)
#   4. db:migrate         (your database lives in the Docker volume; migrations
#                          may include cleanup DROP/RENAME of columns the app
#                          already retired, alongside additive changes — not
#                          additive-only)
#   5. tells you to restart your two dev processes. That's it.
#
# Your database, courses, progress, flashcards: migrations here are not
# guaranteed additive-only (see drizzle/*.sql — some ALTER TABLE ... DROP
# COLUMN / RENAME COLUMN calls against columns the app no longer reads).
# Step 3 above backs up your data first as a safety net.

set -euo pipefail

OLD="${1:?usage: ./update.sh /path/to/previous/learn-shell-trial}"

if [ ! -d "$OLD" ]; then
  echo "✗ '$OLD' is not a directory" >&2
  exit 1
fi

echo "→ carrying over private local files (if any)…"
if [ -f "$OLD/apps/server/.env" ]; then
  cp "$OLD/apps/server/.env" apps/server/.env
  echo "  ✓ kept your apps/server/.env"
fi
if [ -f "$OLD/apps/web/src/lib/whisper-terms.local.ts" ]; then
  cp "$OLD/apps/web/src/lib/whisper-terms.local.ts" apps/web/src/lib/whisper-terms.local.ts
  echo "  ✓ kept your whisper-terms.local.ts"
fi

echo "→ pnpm install…"
pnpm install

echo "→ backing up database before migrating…"
BACKUP_FILE="learn-shell-backup-$(date +%Y%m%d-%H%M%S).sql"
DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ] && [ -f apps/server/.env ]; then
  DB_URL="$(grep -E '^DATABASE_URL=' apps/server/.env | cut -d= -f2-)"
fi
DB_URL="${DB_URL:-postgresql://learn_shell:learn_shell_dev@localhost:5432/learn_shell}"

if command -v pg_dump >/dev/null 2>&1; then
  if pg_dump "$DB_URL" > "$BACKUP_FILE" 2>/dev/null; then
    echo "  ✓ backed up to $BACKUP_FILE"
  else
    rm -f "$BACKUP_FILE"
    echo "  ⚠️  pg_dump FAILED — proceeding WITHOUT a fresh backup of your database." >&2
    read -r -p "  Press Enter to continue anyway, or Ctrl-C to stop and back up manually… "
  fi
else
  echo "  ⚠️  pg_dump not found on PATH — proceeding WITHOUT a backup of your database." >&2
  read -r -p "  Press Enter to continue anyway, or Ctrl-C to stop and back up manually… "
fi

echo "→ running database migrations (may include cleanup DROP/RENAME on retired columns)…"
pnpm --filter @learn-shell/server db:migrate

echo ""
echo "✓ Upgrade complete. Restart your two dev processes:"
echo "    pnpm --filter @learn-shell/server dev"
echo "    pnpm --filter @learn-shell/web dev"
echo "  (docker compose / Postgres kept running the whole time — nothing to redo there.)"
