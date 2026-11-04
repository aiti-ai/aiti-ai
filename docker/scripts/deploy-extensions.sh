#!/usr/bin/env bash
# deploy-extensions.sh —— 构建容器内批量部署 pi-web 扩展产物（aiti-docker-image-plan §3.2 ⑤）
# 用法：bash deploy-extensions.sh <目标目录，如 /opt/aiti/extensions>
# 机制：逐扩展跑 tools/deploy.mjs（HOME 重定向到临时目录），部署完成后从 HOME/.pi/web/extensions
#       拷贝到目标目录。deploy commit / reload POST 在构建容器内允许失败（deploy.mjs 本就容忍）。
# S4 升级路径：aiti-ext-install（npm 发布链）就绪后整段替换。
set -euo pipefail
DEST="${1:?usage: deploy-extensions.sh <dest-dir>}"
# staging 根（含 pi-web-ext/）：容器内本脚本被拍扁到 /opt/aiti/src/，向上探测定位
find_root() {
  local d="$PWD"
  while [ "$d" != "/" ]; do
    if [ -d "$d/pi-web-ext" ]; then echo "$d"; return; fi
    d="$(dirname "$d")"
  done
  echo "[]" >&2; exit 1
}
SRC_ROOT="$(find_root)"
EXT_SRC="$SRC_ROOT/pi-web-ext"
cd "$EXT_SRC"
# cpu-meter/devtools 等构建脚本按 Node 解析链向上找 esbuild（宿主=仓库根 node_modules）
# staging 根没有 package.json——补一份局部安装供解析
if [ ! -d "$SRC_ROOT/node_modules" ]; then
  (cd "$SRC_ROOT" && npm install esbuild --no-audit --no-fund --loglevel=error) >"/tmp/deps-root-esbuild.log" 2>&1 \
    || echo "[deploy-ext] WARN 根 esbuild 安装失败（日志 /tmp/deps-root-esbuild.log）"
fi
BUILD_HOME=/tmp/deploy-home
mkdir -p "$BUILD_HOME" "$DEST"

# 白名单排除（方案 §8.1）：开发样例/隔离专用/基础设施不进生产镜像
EXCLUDE="^(_shared|shared|templates|ai-configs|sm-demo-source|demo|demo-lazy|aiti-crash-fatal)$"

for d in */; do
  ext="${d%/}"
  if [[ "$ext" =~ $EXCLUDE ]]; then echo "[deploy-ext] skip $ext (excluded)"; continue; fi
  if [ ! -f "$EXT_SRC/$ext/tools/deploy.mjs" ]; then echo "[deploy-ext] skip $ext (no deploy.mjs)"; continue; fi
  # vite 类扩展的 node_modules 不在 staging（gitignore）——容器内按需补装（一次性，构建缓存后免）
  if [ -f "$EXT_SRC/$ext/package.json" ] && [ ! -d "$EXT_SRC/$ext/node_modules" ]; then
    echo "[deploy-ext] installing deps for $ext ..."
    # ci 优先：lock 里 resolved 指向私有包（如 service-tunnels → npm.alot.pw）时按锁定
    # URL 直取，不被默认 registry 重解析丢包；无 lock/漂移时回落 install
    (cd "$EXT_SRC/$ext" && (npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error)) >"/tmp/deps-$ext.log" 2>&1 \
      || echo "[deploy-ext] WARN $ext deps install failed（继续尝试部署；日志 /tmp/deps-$ext.log）"
  fi
  echo "[deploy-ext] deploying $ext ..."
  if ! HOME="$BUILD_HOME" node "$EXT_SRC/$ext/tools/deploy.mjs" >/tmp/deploy-$ext.log 2>&1; then
    echo "[deploy-ext] WARN $ext deploy failed（继续；日志尾 8 行如下）"
    tail -8 "/tmp/deploy-$ext.log" || true
  fi
done

# 拷出部署产物（deploy.mjs 默认落 $HOME/.pi/web/extensions/<id>）
if [ -d "$BUILD_HOME/.pi/web/extensions" ]; then
  cp -a "$BUILD_HOME/.pi/web/extensions/." "$DEST/"
  echo "[deploy-ext] deployed -> $DEST ($(ls "$DEST" | wc -l) extensions)"
  rm -rf "$BUILD_HOME" /root/.npm
else
  echo "[deploy-ext] ERROR: 未找到部署产物 $BUILD_HOME/.pi/web/extensions"; exit 1
fi
