#!/usr/bin/env bash
# rebuild-and-smoke.sh — CI / cron entry: rebuild images + automatic smoke (aiti-docker-image-plan §4.1/§6-6)
# Usage:
#   ./docker/scripts/rebuild-and-smoke.sh              # rebuild core+full + both smokes
#   ./docker/scripts/rebuild-and-smoke.sh core         # core only
# Exit code = smoke failure count (build failure = 127). CI integration: this script is the single entry point;
# host prerequisites = docker + a registry mirror on the build machine + the three source repos (see the build.sh header).
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGETS="${1:-core full}"
FAILED=0

for t in $TARGETS; do
  log() { printf '[rebuild-and-smoke][%s] %s\n' "$t" "$*"; }
  log "build started $(date '+%F %T')"
  if ! "$HERE/build.sh" --target "$t" --tag "aiti/aiti:$t" >"/tmp/aiti-build-$t.log" 2>&1; then
    log "build failed (tail of /tmp/aiti-build-$t.log:)"
    tail -5 "/tmp/aiti-build-$t.log"
    FAILED=$((FAILED + 1))
    continue
  fi
  log "build done, smoking…"
  if "$HERE/scripts/smoke.sh" "$t"; then
    log "smoke all green"
  else
    log "smoke has failures"
    FAILED=$((FAILED + 1))
  fi
done

exit "$FAILED"
