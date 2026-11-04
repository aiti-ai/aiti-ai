#!/usr/bin/env bash
# 10-apt-mirror.sh —— apt 源切国内镜像（构建期注入，aiti-docker-image-plan §4.3）
# Ubuntu 26.04 起源配置为 deb822 格式（/etc/apt/sources.list.d/ubuntu.sources）。
# MIRROR 为空 = 保持官方源（GitHub 等境外网络直用）；本地（国内）构建传镜像域。
set -euo pipefail
MIRROR="${1:-}"
SRC=/etc/apt/sources.list.d/ubuntu.sources
if [ -z "$MIRROR" ]; then
  echo "[10-apt-mirror] MIRROR 为空——保持官方源"
  exit 0
fi
if [ -f "$SRC" ]; then
  sed -i "s|http://archive.ubuntu.com/ubuntu|http://${MIRROR}/ubuntu|g; s|http://security.ubuntu.com/ubuntu|http://${MIRROR}/ubuntu|g; s|http://cn.archive.ubuntu.com/ubuntu|http://${MIRROR}/ubuntu|g" "$SRC"
else
  # 兜底：传统 one-line 格式（代号从 os-release 取，勿硬编码——noble=24.04，26.04 已换代）
  CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME:-noble}")"
  cat > /etc/apt/sources.list <<EOF
deb http://${MIRROR}/ubuntu ${CODENAME} main restricted universe multiverse
deb http://${MIRROR}/ubuntu ${CODENAME}-updates main restricted universe multiverse
deb http://${MIRROR}/ubuntu ${CODENAME}-security main restricted universe multiverse
EOF
fi
echo "[10-apt-mirror] apt source -> ${MIRROR}"
