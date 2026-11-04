#!/usr/bin/env bash
# 30-install-pi.sh —— pi 引擎 + pi 侧扩展包（aiti-docker-image-plan §2.1.2/§8.3）
# 用法：30-install-pi.sh <NPM_MIRROR>
# 落地：全局 pi CLI（@earendil-works/pi-coding-agent）+ /opt/aiti/agent/settings.json packages
set -euo pipefail
NPM_MIRROR="${1:-https://registry.npmmirror.com}"
AGENT_DIR=/opt/aiti/agent
mkdir -p "$AGENT_DIR"

npm config set registry "$NPM_MIRROR"
# pi 引擎全局安装（pi-web 依赖同款；SDK 进程内用 /opt/aiti/app/node_modules 的版本）
npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@0.84.3

# settings.json（packages 六件）改由 entrypoint.sh 首启动生成——支持挂载 ~/.pi 继承宿主
# 配置（jq 合并：用户键优先 + packages 并集，2026-09-10）；构建期不再预写。
