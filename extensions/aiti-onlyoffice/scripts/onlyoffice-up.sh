#!/usr/bin/env bash
# aiti-onlyoffice · OnlyOffice DocumentServer 一键启动（docs/aiti-editor-office-plan.md §2.4）
#
# 用法：scripts/onlyoffice-up.sh
#   - JWT secret 与 pi-web 扩展服务端共用同一份（~/.pi/web/data/aiti-onlyoffice/config/jwt-secret，
#     首次由扩展服务端自动生成；本脚本不存在时先生成随机值回写，保证两端一致）
#   - 容器访问宿主 pi-web 走 host.docker.internal（--add-host）；浏览器访问 8802 建议经
#     nginx location /onlyoffice/ 反代（同域免跨域，feature onlyoffice.publicUrl 填反代地址）
#   - 容器常态 ~2G 内存；数据持久化在 docker volume aiti-onlyoffice-data
set -euo pipefail

NAME=aiti-onlyoffice
PORT="${AITI_ONLYOFFICE_PORT:-8802}"
SECRET_FILE="${HOME}/.pi/web/data/aiti-onlyoffice/config/jwt-secret"

if [ ! -f "$SECRET_FILE" ]; then
  mkdir -p "$(dirname "$SECRET_FILE")"
  # 与 index.ts loadSecret 相同的格式（32 字节 hex）；chmod 600 对齐
  (umask 177 && head -c 32 /dev/urandom | xxd -p -c 64 > "$SECRET_FILE")
  echo "[onlyoffice-up] 已生成 JWT secret → $SECRET_FILE"
fi
JWT_SECRET="$(tr -d '[:space:]' < "$SECRET_FILE")"

if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "[onlyoffice-up] 容器已在运行（127.0.0.1:$PORT）"
  exit 0
fi
docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run -d --name "$NAME" \
  -p "127.0.0.1:${PORT}:80" \
  -e JWT_ENABLED=true -e "JWT_SECRET=${JWT_SECRET}" \
  -e JWT_HEADER=Authorization \
  -v aiti-onlyoffice-data:/var/www/onlyoffice/Data \
  -v aiti-onlyoffice-log:/var/log/onlyoffice \
  --add-host=host.docker.internal:host-gateway \
  onlyoffice/documentserver

echo "[onlyoffice-up] 启动中（首次拉镜像 + 初始化约需数分钟）…"
echo "[onlyoffice-up] healthcheck: curl http://127.0.0.1:${PORT}/healthcheck  → true 即就绪"
echo "[onlyoffice-up] 之后在 扩展管理器 → aiti-onlyoffice → 功能 勾选「启用 OnlyOffice」并刷新页面"
