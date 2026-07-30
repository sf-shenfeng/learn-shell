# Upgrading from a previous snapshot

Five steps, ~1 minute (your database lives in the Docker volume; migrations
may include cleanup `DROP`/`RENAME` of already-retired columns alongside
additive ones — not additive-only. `update.sh` takes a timestamped backup
before running them; back up yourself first if you ever migrate by hand).

1. Extract the new tarball to a **new** folder.
2. In the new folder: `./update.sh /path/to/your/old/folder`
   (carries over your `.env` / personal whisper vocab if you made them,
   installs deps, backs up the database, runs migrations).
3. Restart the two dev processes (`server dev` + `web dev`). An upgrade
   only counts when the new code is what's actually breathing on the
   port — if anything looks off, confirm the server really restarted
   (its log shows a fresh boot, or `GET :3000/api/version` shows a new
   `boot_at`) before debugging anything else.
4. Hard-refresh the browser tab.
5. Delete the old folder whenever you feel like it.

No agent needed — these are copy-paste commands. If you'd rather have your
AI do it, paste it this file; that's the whole briefing.
