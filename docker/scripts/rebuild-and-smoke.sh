#!/usr/bin/env bash
# rebuild-and-smoke.sh —— CI/定时任务入口：重建镜像 + 自动冒烟（aiti-docker-image-plan §4.1/§6-6）
# 用法：
#   ./docker/scripts/rebuild-and-smoke.sh              # core+full 重建 + 双冒烟
#   ./docker/scripts/rebuild-and-smoke.sh core         # 只 core
# 退出码 = 冒烟失败项数（构建失败=127）。CI 接入：本脚本是唯一入口，
# 需要的宿主前提 = docker + 构建机 registry-mirror + 三个源码仓库（见 build.sh 头注释）。
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGETS="${1:-core full}"
FAILED=0

for t in $TARGETS; do
  log() { printf '[rebuild-and-smoke][%s] %s\n' "$t" "$*"; }
  log "构建开始 $(date '+%F %T')"
  if ! "$HERE/build.sh" --target "$t" --tag "aiti/aiti:$t" >"/tmp/aiti-build-$t.log" 2>&1; then
    log "构建失败（日志 /tmp/aiti-build-$t.log 尾部：）"
    tail -5 "/tmp/aiti-build-$t.log"
    FAILED=$((FAILED + 1))
    continue
  fi
  log "构建完成，冒烟中…"
  if "$HERE/scripts/smoke.sh" "$t"; then
    log "冒烟全绿"
  else
    log "冒烟有失败项"
    FAILED=$((FAILED + 1))
  fi
done

exit "$FAILED"
