#!/usr/bin/env bash
# 50-gui-start.sh —— 容器内 GUI 自启编排（aiti-docker-image-plan §3.3 full 分支）
# 容器无 systemd → 复用 aiti-ui-env setup-linux.sh 同款命令序列（R2 的 AITI_NO_SYSTEMD 等效分支）。
# 由 entrypoint 以 aiti 用户后台拉起；端口默认回环（对外经 service-tunnels + TOTP，R5）。
set -u
# ⚠ RLIMIT_NOFILE 上限（O20，冒烟实证）：现代容器 NOFILE 默认 2^30——x11vnc 每接受一个
# 客户端会按 NOFILE 逐 fd fcntl 扫描（十几亿次，实测十几分钟才发 RFB banner）→ VNC
# 功能性死亡。GUI 会话统一压到 65536（x11vnc/websockify/浏览器余量充足）。
ulimit -n "${AITI_GUI_NOFILE:-65536}" 2>/dev/null || true
export DISPLAY="${DISPLAY:-:99}"
SIZE="${AITI_GUI_SIZE:-1920x1080x24}"

# 1. Xvfb 虚拟显示 [gui.xvfb]
# -auth 文件必须先存在（Xvfb 不自建，缺失报 EE 但继续=无 auth 裸跑）——预创建空文件
# （空=无授权条目；配合 -nolisten tcp + 单用户容器，unix socket 本就是用户隔离）
touch /tmp/.Xauth-aiti
Xvfb :99 -screen 0 "$SIZE" -nolisten tcp -auth /tmp/.Xauth-aiti &
sleep 0.5  # 等价 setup-linux.sh 的就绪等待：仅一次性启动编排，非轮询等待逻辑

# 2. dbus 会话总线 + AT-SPI [gui.bus]
dbus-daemon --session --fork --address="unix:path=/tmp/dbus-aiti" 2>/dev/null || true
export DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/dbus-aiti"
/usr/libexec/at-spi-bus-launcher --launch-immediately 2>/dev/null &

# 3. openbox 窗口管理器 [gui.wm]
openbox &

# 4. x11vnc（:5900，默认 localhost）[gui.vnc]
x11vnc -display "$DISPLAY" -localhost -nopw -quiet -forever -shared -bg 2>/dev/null || true

# 5. vnc-bridge（noVNC 静态页 + WS :6080）[gui.web]
if [ -f /opt/aiti/data/aiti-ui-env/vnc-bridge.mjs ]; then
  node /opt/aiti/data/aiti-ui-env/vnc-bridge.mjs --port 6080 --vnc 5900 --web /usr/share/novnc &
else
  # 兜底：websockify 直桥（novnc 包自带）
  websockify --web /usr/share/novnc 6080 localhost:5900 2>/dev/null &
fi

# 6. Chrome/Chromium + CDP（:9222，容器内 --no-sandbox）[debug.cdp]
# 镜像装的是 google-chrome-stable（ubuntu 源 chromium-browser 是 snap 过渡包，见 Dockerfile.full R4）；
# chromium 兜底供其他发行版/自改镜像复用本脚本
google-chrome-stable $AITI_CHROMIUM_FLAGS --start-maximized about:blank 2>/dev/null \
  || chromium-browser $AITI_CHROMIUM_FLAGS --start-maximized about:blank 2>/dev/null \
  || chromium $AITI_CHROMIUM_FLAGS --start-maximized about:blank 2>/dev/null &
echo "[gui-start] browser cdp :9222"

wait
