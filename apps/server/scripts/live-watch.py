#!/usr/bin/env python3
"""live-watch.py — portable event watchdog for the Learn Shell live bridge.

Any agent that can shell out to `python3` can run this. It replaces an
agent spin-polling /bridge/pending (burning tokens every cycle) with one
blocking process call: the agent runs this script as a single tool
invocation, the script does the waiting in shell-land, and it hands back
control (stdout line + exit code) the moment something is actually worth
looking at.

Responsibilities:
  - POST /bridge/heartbeat every 30s to keep the agent's online light lit
    (ttl 60s server-side, so 30s cadence gives a 2x safety margin).
  - Long-poll GET /bridge/wait for new pending events. If the server is
    an older build without /bridge/wait (404), fall back to plain 3s
    polling of GET /bridge/pending — same event detection logic, just
    without the server-side blocking.
  - On event: print one structured JSON line per new event to stdout,
    then exit 0 (blocking-tool-call mode) — unless --persistent, in
    which case keep running and keep printing lines (Monitor mode).
  - On no event within --timeout seconds total: exit 2 ("timed out, no
    event — agent should re-issue the blocking call").
  - Persist the seen-id set to a local cache file
    (~/.cache/ls-live-watch/seen-<pair_id>.json) so a reconnect after a
    crash/restart/network partition can tell "already delivered" apart
    from "went pending while nobody was watching" — see rule 6 below.
  - Retry heartbeat/wait/pending calls with capped exponential backoff
    (1s/2s/4s/8s) during connection failures or 5xx responses, instead
    of emitting one error line per attempt at whatever the normal
    cadence is.

============================================================================
六条军规 (2026-07-02/03 三代桥事故血泪 — must all be visibly wired in,
line references below refer to *this* file as originally written):
============================================================================
  1. 数据路径禁止 shell 字符串处理 — JSON 直入 json.loads，绝无 echo/grep
     加工。 See `_http_call()`: every response body goes straight from
     `resp.read()` into `json.loads(...)`. No subprocess/os.system/shell
     pipeline touches response data anywhere in this file (grep this file
     for "subprocess" or "os.system" — there are none).
  2. 先送达后推进游标 — seen 集合只在成功 print 后更新，落盘持久化同样只在
     成功 print 之后才发生（先送达，后推进内存游标，再落盘）. See
     `_emit_event()`: `seen[event_id] = ...`、`since_holder` 推进、以及
     `_persist_seen(...)` 三步都在 try 块内，只在 `print(...)` +
     `sys.stdout.flush()` 都不抛异常之后才执行。
  3. 去重键用事件/消息 id，禁用条数/时间戳类可碰撞签名. See
     `_event_id_from_pending_item()` / the `event_id` field the /bridge/wait
     endpoint already returns — always a genId()-minted id
     (`ls_..`/`tr_..`/`ahm_..`), never a list index, item count, or raw
     timestamp.
  4. urllib 必须 build_opener(ProxyHandler({})) 禁代理. See module-level
     `_OPENER` — every request in this file goes through it, never
     `urllib.request.urlopen()` directly.
  5. 上岗第一动作验证端点真实响应结构（GET pending 一次，校验形状，形状不符
     exit 3 并打印实际结构）. See `_startup_shape_check()`, called first
     thing in `main()` before the heartbeat/wait loop starts.
  6. 游标/锚点消失 fail-informed（原 fail-closed，见下方修订说明）— 用
     seen-id 集合而非位置锚；seen 集合持久化到本地文件
     (~/.cache/ls-live-watch/seen-<pair_id>.json，写临时文件+os.replace
     原子落盘，多实例并发写下"最后写入者生效"，不会写出半个文件)，跨
     进程/跨重连存活。首次运行（本地无持久化文件，`cache_existed=False`）
     保持旧的 fail-closed 行为：现存 pending 全部标记已见，不重播历史，
     打一行 {"type":"note", mode:"first_run_no_replay", ...} 说明 —
     这是为了不让一次新装机把整段历史当成"新事件"炸出来。此后每一次
     重连（持久化文件已存在，`cache_existed=True`）：现存 pending 里
     不在持久化 seen 集合中的条目，视为断线窗口期间漏发的信号，逐条以
     `note="replayed_after_reconnect"` 补发为正常 event（不是 note），
     之后才进入等待循环。seen 集合按"最近 500 条或 24 小时"双重上限
     裁剪，防止无限膨胀。 See `_load_seen_cache()` /
     `_prime_seen_from_pending()` / `_persist_seen()` / `_prune_seen()`.

     —— fail-closed → fail-informed 修订说明（2026-07-17
     开考中部署事故）：服务器重启期间学习者的作答已经落库、变成了
     pending 事件；watcher 断线重连后，按旧版第 6 条 fail-closed 规则，
     把这些现存 pending 全部标记"已见"、不重播——事件被军规自己的安全
     阀吞掉，从未播报，没人知道学习者答完了。教训是：cursor/anchor 消失
     时"什么都不做、全部当已读"不等于安全，那只是把风险从"重复播报"
     单向搬到了"永久漏播"，而漏播比重复更危险。真正的 fail-safe 需要
     一份不随进程死亡而消失的记忆——见不到这份记忆（真第一次启动）时
     才退回旧的静默 prime；见得到时（重连）就必须把"pending 减去
     seen"这个差集重新交出来，哪怕代价是偶尔重复播报一条本来就已经
     处理过的事件。宁可多说一句，不可漏说一句。

     —— Live 2.0 补记（2026-07-18，服务端 delivery cursor 上线）：第 6
     条原本的"记忆"完全活在本地文件里——本机磁盘丢了（重装/换机器）
     这份记忆就跟着丢，退回真第一次启动的沉默 prime，哪怕服务器其实
     还记得。现在服务端按 (pair_id, consumer_id) 也存了一份同样的游标
     （见 apps/server/src/lib/live-wait.ts 的 bridge_delivery_cursors），
     consumer_id 是从 pair_id 确定性推出的（见 `_consumer_id()`），不
     依赖任何本地文件就能在下次运行/换机器时复现同一个身份。本地
     seen-cache 现在降级为"崩溃保险带"：本地文件仍是首选的记忆来源
     （存在就信它，见 `_load_seen_cache` 调用点不变），只有在本地文件
     确实缺失时才向服务端探一次这个 consumer_id 的持久化游标（见
     `main()` 里 `cache_existed=False` 分支的 probe 调用）——探到非空
     游标就当断线重连处理，不再走旧的"静默标记当前 pending 为已读"、
     从未真正一次性全新装机过的假设。真正的全新装机（本地无文件 +
     服务端这个 consumer_id 也从未出现过）仍然是旧的 fail-closed 首次
     prime，语义不变。真正推进服务端游标的动作没有新增端点——见
     lib/live-wait.ts 的"隐式确认"注释：每次 /bridge/wait 调用只要带上
     非空 since，就是在确认"上一批我已处理完"，服务端据此 upsert 这行
     游标；不带 since（`_poll_wait` 的 `since=None`）则只读不写，专门
     留给这里的探测场景用。

  7. 上岗先报版本——版本静默=过期门铃隐患（2026-07-18 混合版本
     事故：考生沙箱实际执行的是一份 SHA-256 不同的过期 live-watch.py，
     watcher 启动却不吐一个字的版本信息，agent 无从察觉自己手里的门铃是
     旧的，直到红队拿两份文件的哈希去对才现形）。修法：连接前（任何
     heartbeat/wait/pending 请求之前）向 stderr 打印一行结构化自报——
     `live-watch watcher_version=<版本> protocol_version=<协议版>
     consumer_id=<id> seen_cache=<路径>` —— 见 `main()` 顶部、
     `_startup_shape_check()` 之前。watcher_version 见本文件顶部
     `WATCHER_VERSION` 常量（硬编码，改动即须递增，绝不允许原地复用旧版本号
     掩盖真实变更）；protocol_version 见 `PROTOCOL_VERSION`，与服务端
     lib/live-wait.ts 实现的同一套 (pair_id, consumer_id) 游标协议对应。
     静默 = 危险的默认信任；报版本不解决版本旧的问题，但让"旧"这件事
     从只有对哈希才能发现，变成看一眼 stderr 就知道。

Usage:
    live-watch.py --pair-id main-watch [--base-url http://localhost:3000]
                  [--timeout 480] [--persistent]

Exit codes:
    0   event(s) delivered (blocking mode only — persistent mode never
        exits this way, it keeps running)
    2   --timeout seconds elapsed with no new event
    3   startup shape check failed (see stdout for the actual response
        shape the server returned)
    130 interrupted (Ctrl-C / SIGINT)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Rule 4: no proxy. A LAN request to the teaching server must never get
# silently redirected into whatever HTTP(S)_PROXY the host shell has set
# (this is exactly how the 07-02 bridge incident turned a local call into
# a hanging 502 through an upstream proxy).
# ---------------------------------------------------------------------------
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# 版本三件套（混合版本事故修复）：hardcoded, bumped by hand — this
# is the one fact a stale copy of this file can never fake, because bumping
# it requires actually editing this line. Any distribution channel that
# copies this script out of the repo (candidate kits, bench sandboxes) now
# has a cheap tripwire: diff the version this file *announces at startup*
# against what the primary repo currently ships. Set to 2.0.0 for the Live
# 2.0 phase 1 release (server-side delivery cursor / consumer_id, 2026-07-18,
# commit 0195f8c). Bump on any future behavior-relevant change to this
# script — never silently reuse a version string across a real edit.
WATCHER_VERSION = "2.0.0"
# Names the (pair_id, consumer_id) delivery-cursor protocol this watcher
# speaks with the server — see apps/server/src/lib/live-wait.ts, which
# implements the server side of the same cursor and documents the protocol
# name in its header comment. Bump the suffix only on a wire-incompatible
# change to the cursor contract (e.g. a new since-token shape); this watcher
# and live-wait.ts must always agree on the number.
PROTOCOL_VERSION = "bridge-cursor/1"

HEARTBEAT_INTERVAL_S = 30
HEARTBEAT_TTL_S = 60
FALLBACK_POLL_INTERVAL_S = 3
# Server's own cap is now parametrized up to 300s (Live 2.0), but this
# script's own per-call budget is always min()'d against the heartbeat
# interval anyway (see main()'s call_timeout calc) — 30s heartbeat cadence
# dominates, so there's no benefit to raising this past the old ceiling.
WAIT_MAX_TIMEOUT_S = 55
# Live 2.0: a short probe call used only to read back a consumer_id's
# server-persisted cursor (and catch anything already pending past it)
# without committing to a real long-poll wait.
PROBE_TIMEOUT_S = 1

# Rule 6 (persisted seen-cache): where the cross-reconnect memory lives, and
# how big/old it's allowed to grow before we prune it.
SEEN_CACHE_DIR = Path(os.path.expanduser("~/.cache/ls-live-watch"))
SEEN_MAX_COUNT = 500
SEEN_MAX_AGE_S = 24 * 60 * 60

# Backoff for heartbeat/wait/pending calls during connection failures or
# 5xx responses (see file header / rule 6 revision note).
BACKOFF_BASE_S = 1.0
BACKOFF_CAP_S = 8.0


class EndpointUnavailable(Exception):
    """Raised when a route 404s — used to detect /bridge/wait absence."""


def _http_call(
    method: str,
    url: str,
    payload: Optional[dict] = None,
    timeout: float = 10.0,
) -> tuple[int, Any]:
    """One HTTP round trip. Returns (status_code, parsed_json).

    Rule 1: the response body is handed to json.loads() directly — no
    shell string processing (echo/grep/sed/awk) touches it anywhere.
    """
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.getcode()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise EndpointUnavailable(url) from e
        raw = e.read()
        status = e.code
    try:
        parsed = json.loads(raw) if raw else None
    except json.JSONDecodeError as e:
        raise ValueError(f"non-JSON response from {url}: {raw[:200]!r}") from e
    return status, parsed


def _note(**fields: Any) -> None:
    line = {"type": "note", "ts": time.time(), **fields}
    print(json.dumps(line, ensure_ascii=False), flush=True)


def _error(**fields: Any) -> None:
    line = {"type": "error", "ts": time.time(), **fields}
    print(json.dumps(line, ensure_ascii=False), flush=True)


def _backoff_delay(retry_count: int) -> float:
    """1s/2s/4s/8s, capped at BACKOFF_CAP_S. retry_count is 0 on the first
    failure of a streak (so the first backoff is 1s, not 0s)."""
    return min(BACKOFF_CAP_S, BACKOFF_BASE_S * (2 ** max(0, retry_count)))


# ---------------------------------------------------------------------------
# Event-id extraction — mirrors apps/server/src/routes/teaching.ts's
# computeBridgeWaitEvents() derivation so the fallback-polling path (which
# only has /bridge/pending's item shape, no server-computed event_id) can
# reconstruct the same dedupe key the wait endpoint would have given it.
# Rule 3: always a genId()-minted id, never a count/index/timestamp.
# ---------------------------------------------------------------------------
def _event_id_from_pending_item(item: dict) -> Optional[str]:
    channel = item.get("channel")
    if channel == "live_teaching":
        latest_response = item.get("latest_response")
        if latest_response and isinstance(latest_response, dict) and latest_response.get("id"):
            return latest_response["id"]
        return item.get("session_id")
    if channel == "adhoc":
        latest_message = item.get("latest_message")
        if latest_message and isinstance(latest_message, dict) and latest_message.get("id"):
            return latest_message["id"]
        return item.get("thread_id")
    return None


def _pending_item_to_event(item: dict) -> Optional[dict]:
    """Reshape one /bridge/pending item into the same event dict shape
    /bridge/wait would have produced (adds event_id). Shared by the
    fallback-polling path and the reconnect-replay prime path so both
    derive event_id the same way (rule 3)."""
    eid = _event_id_from_pending_item(item)
    if not eid:
        return None
    evt = dict(item)
    evt["event_id"] = eid
    return evt


def _id_timestamp(event_id: str) -> int:
    """Same decode as the server's idTimestamp(): the base36 segment
    embedded in genId()'s `${prefix}_${tsBase36}_${rand}` format."""
    parts = event_id.split("_")
    if len(parts) < 2:
        return 0
    try:
        return int(parts[1], 36)
    except ValueError:
        return 0


def _is_newer(candidate_id: str, since: str) -> bool:
    if not since:
        return True
    ct, st = _id_timestamp(candidate_id), _id_timestamp(since)
    if ct != st:
        return ct > st
    return candidate_id > since


def _max_event_id(a: str, b: str) -> str:
    if not a:
        return b
    if not b:
        return a
    return b if _is_newer(b, a) else a


# ---------------------------------------------------------------------------
# Rule 5: first action on start — verify the real response shape of
# /bridge/pending before trusting anything else about this server.
# ---------------------------------------------------------------------------
def _startup_shape_check(base_url: str, pair_id: str) -> dict:
    url = f"{base_url}/api/teaching/bridge/pending?pair_id={urllib.parse.quote(pair_id)}"
    try:
        status, data = _http_call("GET", url)
    except EndpointUnavailable:
        _error(stage="startup_shape_check", reason="bridge_pending_404", url=url)
        sys.exit(3)
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
        _error(stage="startup_shape_check", reason="request_failed", detail=str(e), url=url)
        sys.exit(3)

    shape_ok = (
        status == 200
        and isinstance(data, dict)
        and isinstance(data.get("bridge"), dict)
        and "pair_id" in data.get("bridge", {})
        and isinstance(data.get("items"), list)
    )
    if not shape_ok:
        _error(
            stage="startup_shape_check",
            reason="unexpected_shape",
            status=status,
            actual=data,
        )
        sys.exit(3)
    return data


# ---------------------------------------------------------------------------
# Rule 6 (fail-informed): persisted seen-cache. seen is keyed by event_id ->
# the wall-clock time (time.time()) it was seen, so we can prune by both
# count and age. Cache lives at SEEN_CACHE_DIR / seen-<sanitized pair_id>.json.
# ---------------------------------------------------------------------------
def _seen_cache_path(pair_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", pair_id) or "unknown"
    return SEEN_CACHE_DIR / f"seen-{safe}.json"


# ---------------------------------------------------------------------------
# Live 2.0: consumer_id for the server-persisted delivery cursor. Deliberately
# *not* a random id stashed in a local file (that would defeat the "换机器"
# guarantee — a wiped/new machine would just mint a fresh identity and the
# server's memory of the old one would be orphaned). Deterministic from
# pair_id instead, so the same logical watcher resolves to the same
# consumer_id no matter which host or process runs it — exactly the identity
# the server needs to hand back the right cursor on reconnect. --consumer-id
# is available to override this default only if a caller genuinely wants a
# second, independently-tracked watcher against the same pair.
# ---------------------------------------------------------------------------
def _default_consumer_id(pair_id: str) -> str:
    return f"live-watch:{pair_id}"


def _load_seen_cache(pair_id: str) -> tuple[dict[str, float], bool]:
    """Returns (seen, cache_existed). cache_existed distinguishes a true
    first-ever run (no file at all — old fail-closed prime behavior applies)
    from a reconnect (file present, even if its contents end up empty)."""
    path = _seen_cache_path(pair_id)
    if not path.exists():
        return {}, False
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        seen: dict[str, float] = {}
        for e in data.get("events", []):
            if isinstance(e, dict) and e.get("id"):
                seen[str(e["id"])] = float(e.get("seen_at", 0.0))
        return seen, True
    except (OSError, ValueError, json.JSONDecodeError, KeyError, TypeError) as e:
        # Corrupt cache — fail-informed, not fail-crashed: log it loudly and
        # degrade to first-run behavior rather than blocking startup or
        # (worse) silently trusting a half-written file.
        _note(stage="seen_cache", reason="corrupt_cache_ignored", path=str(path), detail=str(e))
        return {}, False


def _prune_seen(seen: dict[str, float]) -> dict[str, float]:
    now = time.time()
    pruned = {k: v for k, v in seen.items() if now - v <= SEEN_MAX_AGE_S}
    if len(pruned) > SEEN_MAX_COUNT:
        newest = sorted(pruned.items(), key=lambda kv: kv[1], reverse=True)[:SEEN_MAX_COUNT]
        pruned = dict(newest)
    return pruned


def _persist_seen(pair_id: str, seen: dict[str, float]) -> None:
    """Atomic write: tempfile in the same dir + os.replace. Safe under
    concurrent multi-instance writers (each gets its own unique tempfile via
    tempfile.mkstemp; os.replace is atomic on the same filesystem) — worst
    case under a race is "last writer wins", never a half-written file."""
    pruned = _prune_seen(seen)
    if len(pruned) != len(seen):
        seen.clear()
        seen.update(pruned)
    records = [{"id": k, "seen_at": v} for k, v in seen.items()]
    payload = {"pair_id": pair_id, "updated_at": time.time(), "events": records}
    try:
        SEEN_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        _error(stage="seen_cache", reason="mkdir_failed", detail=str(e))
        return
    path = _seen_cache_path(pair_id)
    fd = None
    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(
            dir=str(SEEN_CACHE_DIR), prefix=".tmp-seen-", suffix=".json"
        )
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            fd = None  # fdopen now owns the fd; don't double-close on except
            f.write(json.dumps(payload, ensure_ascii=False))
        os.replace(tmp_path, path)
    except OSError as e:
        _error(stage="seen_cache", reason="write_failed", detail=str(e), path=str(path))
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _prime_seen_from_pending(
    pending_data: dict,
    pair_id: str,
    seen: dict[str, float],
    since_holder: list[str],
    cache_existed: bool,
) -> int:
    """Returns the number of events replayed as real `type: event` lines
    during priming (always 0 on a true first run). Callers in blocking mode
    must treat a nonzero return the same as any other newly-emitted event
    for exit-code purposes (see `main()`) — otherwise a replayed event can
    sit on stdout while the exit code still says "timed out, nothing to see
    here", which is exactly the kind of stdout/exit-code mismatch this
    guard exists to prevent."""
    items = pending_data.get("items", [])

    if not cache_existed:
        # True first run: no persisted memory of anything ever having been
        # delivered. Old fail-closed behavior — mark everything currently
        # pending as seen without replaying it, so a fresh install doesn't
        # dump the entire pre-existing backlog as "new" events.
        for item in items:
            eid = _event_id_from_pending_item(item)
            if eid:
                seen[eid] = time.time()
                since_holder[0] = _max_event_id(since_holder[0], eid)
        _note(
            stage="startup_prime",
            mode="first_run_no_replay",
            primed_count=len(seen),
            msg="no persisted seen-cache found; treating as a fresh install — "
            "pre-existing pending items marked seen, not replayed as events",
        )
        _persist_seen(pair_id, seen)
        return 0

    # Reconnect: a persisted seen-cache from a prior run exists. Anything
    # pending now that ISN'T in that cache was missed during the gap
    # (crash/restart/network partition) — replay it as a real event instead
    # of silently marking it seen (see file header, fail-informed rationale).
    replayed = 0
    already_seen = 0
    for item in items:
        evt = _pending_item_to_event(item)
        if evt is None:
            continue
        eid = evt["event_id"]
        if eid in seen:
            since_holder[0] = _max_event_id(since_holder[0], eid)
            already_seen += 1
            continue
        evt["note"] = "replayed_after_reconnect"
        if _emit_event(evt, seen, since_holder, pair_id):
            replayed += 1
    _note(
        stage="startup_prime",
        mode="reconnect_replay",
        replayed_count=replayed,
        already_seen_count=already_seen,
        total_pending=len(items),
        msg="persisted seen-cache found; pending items missing from it were replayed as events",
    )
    return replayed


def _summarize_event(evt: dict) -> dict:
    """Shrink a full event payload down to a stdout-friendly summary line."""
    channel = evt.get("channel")
    base = {
        "type": "event",
        "channel": channel,
        "reason": evt.get("reason"),
        "event_id": evt.get("event_id"),
        "queued_at": evt.get("queued_at"),
    }
    if evt.get("note"):
        base["note"] = evt["note"]
    if channel == "live_teaching":
        session = evt.get("session") or {}
        base["session_id"] = evt.get("session_id") or session.get("id")
        base["context_type"] = session.get("context_type")
        base["context_id"] = session.get("context_id")
        base["goal"] = session.get("goal")
        latest_response = evt.get("latest_response")
        if latest_response:
            content = latest_response.get("content", "")
            base["response_preview"] = content[:160]
    elif channel == "adhoc":
        base["thread_id"] = evt.get("thread_id")
        latest_message = evt.get("latest_message") or {}
        content = latest_message.get("content", "")
        base["message_preview"] = content[:160]
    return base


def _emit_event(evt: dict, seen: dict[str, float], since_holder: list[str], pair_id: str) -> bool:
    """Print one event line. Rule 2: seen/since/persisted-cache only advance
    *after* the print succeeds. Returns True if the event was newly emitted."""
    event_id = evt.get("event_id")
    if not event_id or event_id in seen:
        return False
    line = _summarize_event(evt)
    try:
        print(json.dumps(line, ensure_ascii=False), flush=True)
    except (BrokenPipeError, OSError):
        # Delivery failed — do NOT advance the cursor/seen-set. The event
        # stays "unseen" and will be retried on the next cycle.
        return False
    # Delivery confirmed — now, and only now, advance in-memory state and
    # persist it (so a crash one line later still remembers this one).
    seen[event_id] = time.time()
    since_holder[0] = _max_event_id(since_holder[0], event_id)
    _persist_seen(pair_id, seen)
    return True


def _send_heartbeat(base_url: str, pair_id: str, retry_counts: dict[str, int]) -> bool:
    """Returns True on success (or on a permanent 404 — not worth backing
    off a route that doesn't exist), False on a transient failure. Caller
    should only advance `last_heartbeat` on True — leaving it stale on False
    means the next loop tick re-fires the heartbeat check immediately, which
    combined with the sleep below is what turns this into a real retry loop
    instead of one silent miss every 30s."""
    url = f"{base_url}/api/teaching/bridge/heartbeat"
    try:
        status, _data = _http_call(
            "POST", url, payload={"pair_id": pair_id, "ttl_seconds": HEARTBEAT_TTL_S}
        )
    except EndpointUnavailable:
        _error(stage="heartbeat", reason="not_found", url=url)
        retry_counts["heartbeat"] = 0
        return True
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
        retry = retry_counts.get("heartbeat", 0)
        delay = _backoff_delay(retry)
        _error(stage="heartbeat", reason="request_failed", detail=str(e), retry=retry, backoff_s=delay)
        retry_counts["heartbeat"] = retry + 1
        time.sleep(delay)
        return False
    if not (200 <= status < 300):
        retry = retry_counts.get("heartbeat", 0)
        delay = _backoff_delay(retry)
        _error(stage="heartbeat", reason="bad_status", status=status, retry=retry, backoff_s=delay)
        retry_counts["heartbeat"] = retry + 1
        time.sleep(delay)
        return False
    if retry_counts.get("heartbeat", 0) > 0:
        _note(stage="heartbeat", reason="recovered", after_retries=retry_counts["heartbeat"])
    retry_counts["heartbeat"] = 0
    return True


def _poll_wait(
    base_url: str,
    pair_id: str,
    since: Optional[str],
    consumer_id: str,
    timeout_s: int,
    retry_counts: dict[str, int],
) -> Optional[dict]:
    """One call to /bridge/wait. Returns parsed JSON, or None if the
    endpoint doesn't exist (caller should fall back to polling).

    Live 2.0: `consumer_id` is always sent — the server only persists/reads
    a delivery cursor for calls that carry one (see lib/live-wait.ts), so
    this is what actually opts this script into the new protocol.
    `since=None` deliberately *omits* the since= query param instead of
    sending an empty string — that's the signal (per resolveWaitSince()) to
    resume from this consumer_id's server-persisted cursor rather than
    starting over from "nothing seen". Passing `since=""` explicitly would
    instead be read as "start over from the beginning" and would overwrite
    whatever cursor the server already had — not what a resume wants."""
    params = [
        ("pair_id", pair_id),
        ("timeout_s", str(timeout_s)),
        ("consumer_id", consumer_id),
    ]
    if since is not None:
        params.append(("since", since))
    url = f"{base_url}/api/teaching/bridge/wait?{urllib.parse.urlencode(params)}"
    try:
        status, data = _http_call("GET", url, timeout=timeout_s + 10)
    except EndpointUnavailable:
        return None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
        retry = retry_counts.get("wait", 0)
        delay = _backoff_delay(retry)
        _error(stage="wait", reason="request_failed", detail=str(e), retry=retry, backoff_s=delay)
        retry_counts["wait"] = retry + 1
        time.sleep(delay)
        return {"events": [], "timeout": True, "since": since or ""}
    if status != 200 or not isinstance(data, dict) or "events" not in data:
        retry = retry_counts.get("wait", 0)
        delay = _backoff_delay(retry)
        _error(
            stage="wait",
            reason="unexpected_shape",
            status=status,
            actual=data,
            retry=retry,
            backoff_s=delay,
        )
        retry_counts["wait"] = retry + 1
        time.sleep(delay)
        return {"events": [], "timeout": True, "since": since or ""}
    if retry_counts.get("wait", 0) > 0:
        _note(stage="wait", reason="recovered", after_retries=retry_counts["wait"])
    retry_counts["wait"] = 0
    return data


def _poll_pending(
    base_url: str, pair_id: str, retry_counts: dict[str, int]
) -> tuple[list[dict], bool]:
    """Fallback path: one GET /bridge/pending, reshaped into the same event
    dict shape /bridge/wait would have produced (adds event_id). Returns
    (events, had_transient_error) — when had_transient_error is True the
    backoff sleep has already happened inside this call, so the caller
    should not add its own FALLBACK_POLL_INTERVAL_S sleep on top."""
    url = f"{base_url}/api/teaching/bridge/pending?pair_id={urllib.parse.quote(pair_id)}"
    try:
        status, data = _http_call("GET", url)
    except EndpointUnavailable:
        _error(stage="pending_fallback", reason="not_found", url=url)
        return [], False
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
        retry = retry_counts.get("pending", 0)
        delay = _backoff_delay(retry)
        _error(
            stage="pending_fallback", reason="request_failed", detail=str(e), retry=retry, backoff_s=delay
        )
        retry_counts["pending"] = retry + 1
        time.sleep(delay)
        return [], True
    if status != 200 or not isinstance(data, dict) or not isinstance(data.get("items"), list):
        retry = retry_counts.get("pending", 0)
        delay = _backoff_delay(retry)
        _error(
            stage="pending_fallback",
            reason="unexpected_shape",
            status=status,
            actual=data,
            retry=retry,
            backoff_s=delay,
        )
        retry_counts["pending"] = retry + 1
        time.sleep(delay)
        return [], True
    if retry_counts.get("pending", 0) > 0:
        _note(stage="pending_fallback", reason="recovered", after_retries=retry_counts["pending"])
    retry_counts["pending"] = 0
    events = []
    for item in data["items"]:
        evt = _pending_item_to_event(item)
        if evt is not None:
            events.append(evt)
    return events, False


def main() -> None:
    parser = argparse.ArgumentParser(description="Learn Shell live-bridge watchdog")
    parser.add_argument("--base-url", default="http://localhost:3000")
    parser.add_argument("--pair-id", required=True)
    parser.add_argument("--timeout", type=int, default=480, help="overall max hang, seconds")
    parser.add_argument(
        "--persistent",
        action="store_true",
        help="keep running and keep printing event lines instead of exiting on first event (Monitor mode)",
    )
    parser.add_argument(
        "--consumer-id",
        default=None,
        help="Live 2.0 server-side delivery cursor identity (default: deterministic "
        "from --pair-id, see _default_consumer_id()). Override only to run a second, "
        "independently-tracked watcher against the same pair.",
    )
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    pair_id = args.pair_id
    consumer_id = args.consumer_id or _default_consumer_id(pair_id)

    # Rule 7: report our own version before making any network call at all —
    # a silent watcher is exactly how a mixed-version incident can go
    # undetected (stale copy, no self-report, no way for the calling agent
    # to notice). Plain stderr, not JSON — this is a human/log-scanning
    # tripwire, not an event line for the caller's event-parsing loop.
    print(
        f"live-watch watcher_version={WATCHER_VERSION} "
        f"protocol_version={PROTOCOL_VERSION} "
        f"consumer_id={consumer_id} "
        f"seen_cache={_seen_cache_path(pair_id)} "
        f"capture-only unless host wake is configured; keep the Agent turn blocked",
        file=sys.stderr,
        flush=True,
    )

    # Rule 5: first action, verify the real shape.
    pending_data = _startup_shape_check(base_url, pair_id)

    # Rule 6 (fail-informed): load whatever cross-reconnect memory exists.
    # Local seen-cache is now the *crash safety net*, not the sole source of
    # truth (Live 2.0 — see file header) — the server persists its own
    # cursor for `consumer_id`, keyed independent of any local file.
    seen, cache_existed = _load_seen_cache(pair_id)
    retry_counts: dict[str, int] = {"heartbeat": 0, "wait": 0, "pending": 0}
    replayed_at_startup = 0

    if cache_existed:
        # Local memory present — trust it for since_holder as before (this
        # also covers the pre-2.0-upgrade case: an existing local cache with
        # a server that has never heard of this consumer_id yet. Sending
        # this value as an explicit `since` on the very first real wait call
        # below acts as the implicit ack that migrates it into the server's
        # persisted cursor — see lib/live-wait.ts's resolveWaitSince()).
        since_holder = [max(seen.keys(), key=lambda k: (_id_timestamp(k), k))] if seen else [""]
        replayed_at_startup = _prime_seen_from_pending(
            pending_data, pair_id, seen, since_holder, cache_existed
        )
    else:
        # No local memory. Before falling back to the old fail-closed
        # "silently mark everything currently pending as seen, don't
        # replay" prime, ask the server whether it already remembers this
        # consumer_id (Live 2.0 crash/machine-change insurance — see file
        # header's "Live 2.0 补记"). since=None omits the since= param, so
        # this reads the server's persisted cursor for `consumer_id`
        # instead of writing one; a short timeout is enough because
        # waitForBridgeEvents resolves immediately if anything is already
        # pending past that cursor.
        probe = _poll_wait(base_url, pair_id, None, consumer_id, PROBE_TIMEOUT_S, retry_counts)
        probe_since = (probe or {}).get("since") or ""
        if probe is None:
            # Old server, /bridge/wait doesn't exist at all — pure legacy
            # fallback path takes over below (wait_supported starts True but
            # will be downgraded on the very next real call, same as before
            # the probe existed).
            since_holder = [""]
            replayed_at_startup = _prime_seen_from_pending(
                pending_data, pair_id, seen, since_holder, cache_existed
            )
        elif probe_since:
            # Server already has a persisted cursor for this consumer_id —
            # trust it and skip the old fail-closed local prime entirely.
            # Anything the probe already caught gets emitted now (dedup via
            # `seen` still applies as the usual safety net).
            since_holder = [probe_since]
            for evt in probe.get("events", []):
                if _emit_event(evt, seen, since_holder, pair_id):
                    replayed_at_startup += 1
            _note(
                stage="startup_prime",
                mode="server_cursor_reconnect",
                consumer_id=consumer_id,
                server_since=probe_since,
                replayed_count=replayed_at_startup,
                msg="local seen-cache absent but the server already had a persisted cursor "
                "for this consumer_id — trusting it instead of the fail-closed local prime "
                "(crash restart or same identity resumed on a new machine)",
            )
        else:
            # Server has never seen this consumer_id either — genuinely a
            # first-ever contact. Old fail-closed prime applies unchanged.
            since_holder = [""]
            replayed_at_startup = _prime_seen_from_pending(
                pending_data, pair_id, seen, since_holder, cache_existed
            )

    # Contract: "on event, exit 0" applies to replayed events too — a
    # reconnect-replay line on stdout with no matching exit code is exactly
    # the stdout/exit-code mismatch this guard exists to prevent.
    if replayed_at_startup and not args.persistent:
        sys.exit(0)

    wait_supported = True  # optimistic; downgraded permanently on first 404
    last_heartbeat = 0.0
    start = time.monotonic()
    deadline = start + args.timeout

    if _send_heartbeat(base_url, pair_id, retry_counts):
        last_heartbeat = time.monotonic()

    try:
        while True:
            now = time.monotonic()
            if not args.persistent and now >= deadline:
                print(json.dumps({"type": "timeout", "elapsed_s": round(now - start, 1)}), flush=True)
                sys.exit(2)

            if now - last_heartbeat >= HEARTBEAT_INTERVAL_S:
                if _send_heartbeat(base_url, pair_id, retry_counts):
                    last_heartbeat = time.monotonic()
                # else: leave last_heartbeat stale — the backoff sleep already
                # happened inside _send_heartbeat, and the next loop tick will
                # retry immediately since the interval check is still true.

            emitted_any = False

            if wait_supported:
                # Budget this /wait call so we resurface in time for the
                # next heartbeat and don't blow past --timeout.
                until_heartbeat = HEARTBEAT_INTERVAL_S - (time.monotonic() - last_heartbeat)
                remaining_budget = (deadline - time.monotonic()) if not args.persistent else WAIT_MAX_TIMEOUT_S
                call_timeout = max(1, int(min(WAIT_MAX_TIMEOUT_S, until_heartbeat, remaining_budget)))
                # since_holder[0] or None: a known cursor is sent explicitly
                # (doubling as this consumer_id's ack — see _poll_wait's
                # docstring); an empty/unknown one is omitted so the server
                # falls back to whatever it has persisted for consumer_id.
                result = _poll_wait(
                    base_url, pair_id, since_holder[0] or None, consumer_id, call_timeout, retry_counts
                )
                if result is None:
                    wait_supported = False
                    _note(
                        stage="mode_switch",
                        msg="/bridge/wait unavailable (404) — falling back to 3s /bridge/pending polling",
                    )
                    continue
                for evt in result.get("events", []):
                    if _emit_event(evt, seen, since_holder, pair_id):
                        emitted_any = True
            else:
                events, had_error = _poll_pending(base_url, pair_id, retry_counts)
                for evt in events:
                    if _is_newer(evt["event_id"], since_holder[0]) and _emit_event(
                        evt, seen, since_holder, pair_id
                    ):
                        emitted_any = True
                if not emitted_any and not had_error:
                    time.sleep(FALLBACK_POLL_INTERVAL_S)

            if emitted_any and not args.persistent:
                sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
