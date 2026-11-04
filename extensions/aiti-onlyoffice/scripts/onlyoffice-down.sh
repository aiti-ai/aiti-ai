#!/usr/bin/env bash
# aiti-onlyoffice · 停止并移除 DocumentServer 容器（数据卷保留）
set -euo pipefail
NAME=aiti-onlyoffice
docker rm -f "$NAME" >/dev/null 2>&1 && echo "[onlyoffice-down] 容器已停止移除（volume aiti-onlyoffice-data 保留）" \
  || echo "[onlyoffice-down] 容器不存在"
