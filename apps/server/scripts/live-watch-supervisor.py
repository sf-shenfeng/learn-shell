#!/usr/bin/env python3
"""live-watch-supervisor.py — reference shell for hosts with no background
wake primitive.

Context (2026-07-19 red-team finding): `live-watch.py` already collapses
waiting into one blocking tool call — the agent issues it, the shell blocks,
and the model turn doesn't resume until stdout produces something. That
works cleanly on a harness that can *wake a finished model turn from
background stdout*. Some harnesses (Codex-type) cannot: a one-shot watcher
that exits 0 because an event arrived still leaves the model turn dead —
nothing re-invokes it, so the event sits unread until a human notices and
re-issues the call by hand. The 480s timeout (exit code 2) has the same
problem: nobody re-hangs it automatically.

This script is the missing outer loop for exactly that class of host. It
does not reimplement any of `live-watch.py`'s six/seven rules (proxy-free
opener, id-keyed dedup, seen-cache, fail-informed replay, startup shape
check, version self-report, ...) — it shells out to the genuine article
every cycle and only handles what sits *outside* one watcher invocation:
respawning it forever, and giving a host with no stdout-wake primitive a
durable place to leave events for the agent to find on its own schedule.

What it does:
  1. Loop forever: run `live-watch.py` (same args, passed straight through)
     as a child process and block on it exactly once per cycle.
       - exit 0 (event delivered, one or more JSON lines on stdout): each
         valid JSON line is appended to today's spool file, then the
         watcher is respawned immediately. No sleep — the whole point is
         that a "turn ended" moment never turns into a stalled watcher.
       - exit 2 (--timeout elapsed, nothing to see): respawn immediately.
         This is the watcher's normal breathing cadence, not a fault.
       - anything else (startup shape check failure, unexpected crash,
         etc.): back off 1s/2s/4s/8s (capped), then respawn. Same capped
         exponential schedule live-watch.py already uses for its own
         request retries — no new policy invented here.
  2. Spool file: a plain newline-delimited JSON log at
     `~/.cache/ls-live-watch/spool-<pair>-<YYYYMMDD>.ndjson` (same cache
     root live-watch.py already uses for its seen-cache). One event per
     line. Rolls to a new file at local-date boundaries; files (and their
     paired .offset files, see below) older than SPOOL_MAX_AGE_DAYS are
     deleted at startup. Short of that, this script never deletes or
     truncates a spool file — it only ever appends.
  3. Consumption is the agent's job, not this script's: at a convenient
     turn boundary (not a background wake — a normal turn the agent was
     already having), read the spool cheaply (`wc -l`, tail, whatever),
     process whatever's new, and record how far you got in a sibling
     offset file, `spool-<pair>-<YYYYMMDD>.offset`, containing nothing but
     the number of spool lines already processed. This script never reads
     or writes that offset file — it is purely an agent-side bookmark next
     to a supervisor-side log.
  4. Startup banner (stderr, one line, family resemblance to live-watch.py
     rule 7 — a silent supervisor is just as much a stale-doorbell risk as
     a silent watcher): `live-watch-supervisor supervisor_version=<ver>
     protocol_version=<proto> pair_id=<id> spool=<path>`.
  5. SIGTERM: terminate the in-flight watcher child, append one
     `{"type":"shutdown",...}` marker line to the current spool file, exit
     0. No new spool/respawn activity happens after a SIGTERM is received,
     even if a child was mid-flight with an event already on its stdout —
     that event is not lost, just not yet delivered; the very next
     supervisor start (or a manual `live-watch.py` call) will pick it back
     up via live-watch.py's own seen-cache/server-cursor replay, same as
     any other reconnect.

What it deliberately does not do:
  - No `--persistent` passthrough. Persistent mode never exits (0 or 2),
    which would starve this script's per-event spool-append step of ever
    running — this supervisor's outer loop *is* the persistence mechanism,
    a persistent child would just be a second, conflicting one.
  - No parsing/validation of event *content* — a line is spooled if it is
    syntactically valid JSON, full stop. What it means is the agent's
    problem, exactly as it already is for a bare live-watch.py caller.

Usage:
    live-watch-supervisor.py --pair-id main-watch [--base-url ...]
                              [--timeout 480] [--consumer-id ...]
                              [--watcher-path /path/to/live-watch.py]

Exit codes:
    0   graceful shutdown (SIGTERM received)
    1   could not locate live-watch.py to run
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

SUPERVISOR_VERSION = "1.0.0"
# Same protocol name live-watch.py's PROTOCOL_VERSION announces — this
# script doesn't speak the wire protocol itself (the child watcher does),
# it just repeats the name in its own banner so a stale-supervisor check is
# as cheap as a stale-watcher check already is.
PROTOCOL_VERSION = "bridge-cursor/1"

# Same cache root live-watch.py uses for its seen-cache — one place to look
# for all of this pair's local live-bridge state.
CACHE_DIR = Path(os.path.expanduser("~/.cache/ls-live-watch"))
SPOOL_MAX_AGE_DAYS = 7

# Same capped-exponential schedule live-watch.py already uses for its own
# request retries (see BACKOFF_BASE_S/BACKOFF_CAP_S there) — reused here
# for respawn backoff on anything other than the two expected exit codes.
BACKOFF_BASE_S = 1.0
BACKOFF_CAP_S = 8.0

# Active child handle, so the SIGTERM handler can reach in and kill it
# rather than waiting for it to finish on its own.
_active_proc: Optional[subprocess.Popen] = None
_shutdown_requested = False


def _sanitize(pair_id: str) -> str:
    # Mirrors live-watch.py's _seen_cache_path() sanitizer so filenames for
    # the same pair_id look related at a glance.
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", pair_id) or "unknown"


def _today_str() -> str:
    return date.today().strftime("%Y%m%d")


def _spool_path(pair_id: str, day: str) -> Path:
    return CACHE_DIR / f"spool-{_sanitize(pair_id)}-{day}.ndjson"


def _offset_path(pair_id: str, day: str) -> Path:
    # Never opened by this script — documented here only so the naming
    # convention lives in one place.
    return CACHE_DIR / f"spool-{_sanitize(pair_id)}-{day}.offset"


def _log(**fields) -> None:
    """Supervisor's own operational log line — stderr only. This script's
    stdout is deliberately unused: nothing in this design reads it (that's
    the whole reason the spool file exists), so keeping it silent avoids
    ever half-training an operator to expect something there."""
    line = {"type": "supervisor_log", "ts": time.time(), **fields}
    print(json.dumps(line, ensure_ascii=False), file=sys.stderr, flush=True)


def _append_spool_line(path: Path, line: str) -> None:
    """Append exactly one line to the spool file.

    Atomicity choice: O_APPEND single-line write, not tempfile+rename.
    Rename-replace (as live-watch.py's seen-cache uses) fits a
    read-whole/replace-whole document; it does not fit an append-only log
    that many respawn cycles keep growing — rename would require reading
    the entire existing spool back in on every single event just to write
    it out again, and a rename during that window could clobber a line
    written by an overlapping second supervisor instance. A file opened
    with O_APPEND instead gets POSIX's per-write-call atomicity guarantee:
    each write() lands as one indivisible block at the current end of file,
    so two writers appending concurrently interleave whole writes, never
    torn ones. One event line is small (well under typical filesystem
    write-atomicity limits), so one os.write() call per line is enough —
    no in-process locking needed even with multiple supervisor instances
    on the same pair.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (line if line.endswith("\n") else line + "\n").encode("utf-8")
    fd = os.open(str(path), os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o644)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)


def _cleanup_old_spool_files(pair_id: str) -> None:
    """Delete spool/offset files older than SPOOL_MAX_AGE_DAYS. Only ever
    called at startup, and only ever targets files whose embedded date is
    stale — never touches today's (or any recent) file, and never touches
    another pair_id's files."""
    safe = _sanitize(pair_id)
    pattern = re.compile(rf"^spool-{re.escape(safe)}-(\d{{8}})\.(ndjson|offset)$")
    cutoff = date.today() - timedelta(days=SPOOL_MAX_AGE_DAYS)
    try:
        candidates = list(CACHE_DIR.glob(f"spool-{safe}-*.*"))
    except OSError:
        return
    for f in candidates:
        m = pattern.match(f.name)
        if not m:
            continue
        try:
            file_date = datetime.strptime(m.group(1), "%Y%m%d").date()
        except ValueError:
            continue
        if file_date < cutoff:
            try:
                f.unlink()
                _log(stage="cleanup", reason="spool_expired", path=str(f), age_days=(date.today() - file_date).days)
            except OSError as e:
                _log(stage="cleanup", reason="unlink_failed", path=str(f), detail=str(e))


def _backoff_delay(retry_count: int) -> float:
    return min(BACKOFF_CAP_S, BACKOFF_BASE_S * (2 ** max(0, retry_count)))


def _handle_sigterm(signum, frame) -> None:
    global _shutdown_requested
    _shutdown_requested = True
    if _active_proc is not None and _active_proc.poll() is None:
        try:
            _active_proc.terminate()
        except OSError:
            pass


def main() -> None:
    global _active_proc

    parser = argparse.ArgumentParser(
        description="Respawning supervisor around live-watch.py, for hosts with no "
        "background-stdout wake primitive."
    )
    parser.add_argument("--base-url", default="http://localhost:3000")
    parser.add_argument("--pair-id", required=True)
    parser.add_argument("--timeout", type=int, default=480, help="passed through to each live-watch.py cycle")
    parser.add_argument(
        "--consumer-id",
        default=None,
        help="passed through to live-watch.py (see its --consumer-id help)",
    )
    parser.add_argument(
        "--watcher-path",
        default=None,
        help="path to live-watch.py (default: sibling of this script)",
    )
    args = parser.parse_args()

    watcher_path = (
        Path(args.watcher_path)
        if args.watcher_path
        else Path(__file__).resolve().parent / "live-watch.py"
    )
    if not watcher_path.exists():
        _log(stage="startup", reason="watcher_not_found", path=str(watcher_path))
        sys.exit(1)

    pair_id = args.pair_id
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _cleanup_old_spool_files(pair_id)

    signal.signal(signal.SIGTERM, _handle_sigterm)

    banner_spool = _spool_path(pair_id, _today_str())
    print(
        f"live-watch-supervisor supervisor_version={SUPERVISOR_VERSION} "
        f"protocol_version={PROTOCOL_VERSION} pair_id={pair_id} "
        f"spool={banner_spool} "
        f"capture-only unless host wake is configured; keep the Agent turn blocked",
        file=sys.stderr,
        flush=True,
    )

    cmd_base = [
        sys.executable,
        str(watcher_path),
        "--base-url",
        args.base_url,
        "--pair-id",
        pair_id,
        "--timeout",
        str(args.timeout),
    ]
    if args.consumer_id:
        cmd_base += ["--consumer-id", args.consumer_id]

    retry_count = 0

    while not _shutdown_requested:
        proc = subprocess.Popen(cmd_base, stdout=subprocess.PIPE, stderr=None, text=True)
        _active_proc = proc
        stdout_data, _ = proc.communicate()
        _active_proc = None
        returncode = proc.returncode

        if _shutdown_requested:
            break

        if returncode == 0:
            spool_path = _spool_path(pair_id, _today_str())
            lines = [ln for ln in stdout_data.splitlines() if ln.strip()]
            written = 0
            for ln in lines:
                try:
                    json.loads(ln)
                except json.JSONDecodeError:
                    _log(stage="spool", reason="non_json_line_dropped", line_preview=ln[:200])
                    continue
                _append_spool_line(spool_path, ln)
                written += 1
            if written:
                _log(stage="spool", reason="events_appended", count=written, path=str(spool_path))
            retry_count = 0
            continue  # immediate respawn — event delivered, no reason to wait

        if returncode == 2:
            retry_count = 0
            continue  # immediate respawn — normal timeout cadence, not a fault

        # Any other exit code: startup shape failure (3), interrupted (130),
        # unexpected crash, etc. — back off and try again rather than
        # spinning or giving up.
        delay = _backoff_delay(retry_count)
        _log(stage="respawn", reason="unexpected_exit", exit_code=returncode, retry=retry_count, backoff_s=delay)
        retry_count += 1
        slept = 0.0
        while slept < delay and not _shutdown_requested:
            step = min(0.5, delay - slept)
            time.sleep(step)
            slept += step

    # Graceful shutdown: leave a marker in today's spool so a consumer that
    # was mid-batch can see the supervisor stopped cleanly, then exit.
    shutdown_line = json.dumps(
        {"type": "shutdown", "ts": time.time(), "pair_id": pair_id, "reason": "sigterm"},
        ensure_ascii=False,
    )
    _append_spool_line(_spool_path(pair_id, _today_str()), shutdown_line)
    _log(stage="shutdown", reason="sigterm_handled")
    sys.exit(0)


if __name__ == "__main__":
    main()
