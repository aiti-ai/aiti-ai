#!/usr/bin/env bash
# 10-apt-mirror.sh — switch apt sources to a CN mirror (injected at build time, aiti-docker-image-plan §4.3)
# Ubuntu 26.04+ uses the deb822 sources format (/etc/apt/sources.list.d/ubuntu.sources).
# Empty MIRROR = keep official sources (GitHub and other non-CN networks use them directly); local (CN) builds pass the mirror domain.
set -euo pipefail
MIRROR="${1:-}"
SRC=/etc/apt/sources.list.d/ubuntu.sources
if [ -z "$MIRROR" ]; then
  echo "[10-apt-mirror] MIRROR empty — keeping official sources"
  exit 0
fi
if [ -f "$SRC" ]; then
  sed -i "s|http://archive.ubuntu.com/ubuntu|http://${MIRROR}/ubuntu|g; s|http://security.ubuntu.com/ubuntu|http://${MIRROR}/ubuntu|g; s|http://cn.archive.ubuntu.com/ubuntu|http://${MIRROR}/ubuntu|g" "$SRC"
else
  # Fallback: the traditional one-line format (codename read from os-release, never hardcoded — noble=24.04, superseded in 26.04)
  CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME:-noble}")"
  cat > /etc/apt/sources.list <<EOF
deb http://${MIRROR}/ubuntu ${CODENAME} main restricted universe multiverse
deb http://${MIRROR}/ubuntu ${CODENAME}-updates main restricted universe multiverse
deb http://${MIRROR}/ubuntu ${CODENAME}-security main restricted universe multiverse
EOF
fi
echo "[10-apt-mirror] apt source -> ${MIRROR}"
