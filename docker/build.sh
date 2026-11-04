#!/usr/bin/env bash
# build.sh —— aiti Docker 镜像构建入口（aiti-docker-image-plan §3/§4.1；2026-10-30 起本仓自足版）
# 用法：
#   ./docker/build.sh --target core --tag aiti/aiti:core
#   ./docker/build.sh --target full --tag aiti/aiti:full
# 机制：本仓（aiti-ai）即发布仓——app 源码 = 仓根、extensions/ = 移植扩展、packages/ = aiti-bridge
# 链、pi-plugins/ = pi 插件源；组装 staging 构建上下文后 docker build（BuildKit）。
# staging 布局与历史版一致（pi-web/、pi-web-ext/、packages/、pi-ext/）——Dockerfile 零改动。
# 外部依赖（env 可覆盖，均有合理默认）：
#   JUSTGET_SRC（缺省 ~/workspace/justget，独立仓 justdb/justget；缺失则镜像无 justget，其余照常）
#   PI_SUBAGENTS_NOTE：@aiti-ai/pi-subagents 走 npm 私源安装（源码仓 aiti-ai/pi-subagents-private，不入本仓）
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
# 本仓自足：app/扩展/桥/插件全部来自本仓；justget 仍为外部源（独立仓）
PI_WEB_SRC="${PI_WEB_SRC:-$REPO_ROOT}"           # app 源码 = 本仓根
PI_WEB_EXT_SRC="${PI_WEB_EXT_SRC:-$REPO_ROOT/extensions}"  # 扩展 = 本仓移植镜像
PACKAGES_SRC="${PACKAGES_SRC:-$REPO_ROOT/packages}"        # aiti-bridge 链
PI_EXT_SRC="${PI_EXT_SRC:-$REPO_ROOT/pi-plugins}"          # pi 插件（models-combo/git-trace/plan-sandbox；qoder 系私有插件保留在 aiti-ai，不入本仓）
JUSTGET_SRC="${JUSTGET_SRC:-$HOME/workspace/justget}"

TARGET="core"
TAG=""
PLATFORM=""
CN=0
PRIVREG="${AITI_PRIVATE_REGISTRY:-}"
NPM_REG="${NPM_REG:-}"   # 覆盖全局 registry（私源为代理型仓库时可直指，覆盖公共+私有全部依赖）
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2;;
    --tag) TAG="$2"; shift 2;;
    --platform) PLATFORM="$2"; shift 2;;
    --cn) CN=1; shift;;
    --private-registry) PRIVREG="$2"; shift 2;;
    --npm-registry) NPM_REG="$2"; shift 2;;
    *) echo "unknown arg $1"; exit 1;;
  esac
done
TAG="${TAG:-aiti/aiti:${TARGET}}"

# ① 预检（方案 §4.1 步骤 1）：基础镜像可达性（48 主机经 registry-mirror 已实证 26.04 可拉）
if ! docker image inspect ubuntu:26.04 >/dev/null 2>&1; then
  echo "[build] 预检：拉取 ubuntu:26.04 ..."
  docker pull ubuntu:26.04
fi

# ①a 镜像源策略：默认官方源（GitHub 等境外 CI/正式发布直用）；--cn（或 env AITI_CN=1）注入国内镜像。
# 私仓（--private-registry / env AITI_PRIVATE_REGISTRY）为**临时**测试通道：@aiti-ai/* 私包
# 尚未发公网 npm 时本地测试用；正式发布不传 = @aiti-ai/* 走公网 npm，无需任何配置。
EXTRA_ARGS=()
if [[ "$CN" = "1" || "${AITI_CN:-0}" = "1" ]]; then
  EXTRA_ARGS=(
    --build-arg APT_MIRROR=mirrors.tuna.tsinghua.edu.cn
    --build-arg NPM_MIRROR=https://registry.npmmirror.com
    --build-arg HF_ENDPOINT=https://hf-mirror.com
    --build-arg PIP_MIRROR=https://pypi.tuna.tsinghua.edu.cn/simple
  )
  echo "[build] 国内镜像源模式（--cn）：apt=tuna npm=npmmirror hf=hf-mirror pypi=tuna"
else
  echo "[build] 官方源模式（境外网络/GitHub/正式发布；国内构建请加 --cn）"
fi
if [[ -n "$NPM_REG" ]]; then
  EXTRA_ARGS+=(--build-arg "NPM_MIRROR=${NPM_REG}")
  echo "[build] 全局 registry 覆盖：${NPM_REG}"
fi
PRIV_ARGS=()
if [[ -n "$PRIVREG" ]]; then
  EXTRA_ARGS+=(--build-arg "AITI_NPM_REGISTRY=${PRIVREG}")
  echo "[build] 私仓测试模式：@aiti-ai/* ← ${PRIVREG}（临时；正式发布不带此参数）"
fi

# ② 组装 staging 构建上下文（git 无关文件已由 rsync exclude 控制）
STAGE="${REPO_ROOT}/.docker-build-context"
# 每次清空重建：rsync --exclude 会保护（不删）接收端已存在的排除文件，旧 staging
# 的大目录（.next-*/.venv/ai-configs）会永久残留进构建上下文（首跑实测 20GB 教训）
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$HERE/.dockerignore" "$STAGE/.dockerignore"
echo "[build] staging -> $STAGE"
rsync -a --delete \
  --exclude 'node_modules' --exclude '.next' --exclude '.next-*' --exclude '.git' \
  --exclude '.docker-build-context' --exclude 'dist' \
  --exclude '.aiti-trace' --exclude 'tsconfig.tsbuildinfo' \
  --exclude '/extensions' --exclude '/pi-plugins' --exclude '/packages' \
  --exclude '/docker' --exclude '/test-results' \
  "$PI_WEB_SRC/" "$STAGE/pi-web/"
rsync -a --delete \
  --exclude 'node_modules' --exclude '.git' \
  "$PI_WEB_EXT_SRC/" "$STAGE/pi-web-ext/"
rsync -a --delete \
  --exclude 'node_modules' --exclude '.git' --exclude 'dist' \
  "$PACKAGES_SRC/" "$STAGE/packages/"
rsync -a --delete \
  --exclude 'node_modules' --exclude '.git' --exclude 'dist' \
  "$PI_EXT_SRC/" "$STAGE/pi-ext/"
rsync -a --delete \
  --exclude 'node_modules' --exclude '.git' \
  "$HERE/" "$STAGE/docker/"
if [ -d "$JUSTGET_SRC" ]; then
  rsync -a --delete --exclude 'node_modules' --exclude '.git' "$JUSTGET_SRC/" "$STAGE/justget/"
fi

# ③ 构建（full 依赖 core 先行：docker build 的 FROM aiti/aiti:core 取本地镜像）
PLATFORM_ARG=(); [[ -n "$PLATFORM" ]] && PLATFORM_ARG=(--platform "$PLATFORM")
echo "[build] docker build --target ${TARGET} -> ${TAG}"
docker build ${PLATFORM_ARG+"${PLATFORM_ARG[@]}"} "${EXTRA_ARGS[@]}" \
  -f "$STAGE/docker/Dockerfile.${TARGET}" \
  -t "$TAG" \
  "$STAGE"

echo "[build] done: ${TAG}"
echo "[build] 冒烟（方案 §4.1 步骤 4）："
echo "  docker run --rm -p 30142:30142 -v aiti-data:/opt/aiti -v ~/workspace:/workspace ${TAG}"
