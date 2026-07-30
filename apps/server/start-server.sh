#!/usr/bin/env bash
# Learn Shell — PRODUCTION server (:3000, learn_shell db).
# 唯一被军规认可的生产重启路径(2026-07-09 CORS 事故立法;2026-07-12 重建:
# 原脚本只存在于本地开发机现场、从未入库,重启风暴中失传——本次重建并入 git,
# 户口本从此在仓库里)。bench 平行考场见 bench/start-bench-server.sh,两文件
# 物理隔离,禁止合并。
# 路径按脚本自身位置定位,clone 到任意路径 / Linux 均可用(不依赖 ~/learn-shell 硬编码)。
export PORT="3000"
# Default is localhost-only; add LAN/prod origins via the CORS_ORIGINS env var (comma-separated).
export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:5173}"
cd "$(dirname "$0")"
exec npx tsx watch src/index.ts
