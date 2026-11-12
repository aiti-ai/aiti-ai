#!/usr/bin/env bash
# 50-gui-start.sh — in-container GUI autostart orchestration (aiti-docker-image-plan §3.3 full branch)
# No systemd in containers → reuses the same command sequence as aiti-ui-env setup-linux.sh (the R2 AITI_NO_SYSTEMD equivalent branch).
# Launched in the background by the entrypoint as user aiti; ports loopback by default (external access via service-tunnels + TOTP, R5).
set -u
# ⚠ RLIMIT_NOFILE ceiling (O20, smoke-verified): modern containers default NOFILE to 2^30 — on every client
# connection x11vnc fcntl-scans fd by fd up to NOFILE (over a billion calls; the RFB banner took minutes to arrive in practice)
# → VNC functionally dead. GUI sessions uniformly cap at 65536 (ample headroom for x11vnc/websockify/browsers).
ulimit -n "${AITI_GUI_NOFILE:-65536}" 2>/dev/null || true
export DISPLAY="${DISPLAY:-:99}"
SIZE="${AITI_GUI_SIZE:-1920x1080x24}"

# 1. Xvfb virtual display [gui.xvfb]
# The -auth file must exist first (Xvfb does not create it; missing → EE errors but it continues = running bare without auth) — pre-create an
# empty file (empty = no authorization entries; combined with -nolisten tcp + a single-user container, the unix socket is the user isolation)
touch /tmp/.Xauth-aiti
Xvfb :99 -screen 0 "$SIZE" -nolisten tcp -auth /tmp/.Xauth-aiti &
sleep 0.5  # equivalent of setup-linux.sh's readiness wait: one-shot startup orchestration, not polling logic

# 2. dbus session bus + AT-SPI [gui.bus]
dbus-daemon --session --fork --address="unix:path=/tmp/dbus-aiti" 2>/dev/null || true
export DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/dbus-aiti"
/usr/libexec/at-spi-bus-launcher --launch-immediately 2>/dev/null &

# 3. openbox window manager [gui.wm]
openbox &

# 4. x11vnc (:5900, localhost by default) [gui.vnc]
x11vnc -display "$DISPLAY" -localhost -nopw -quiet -forever -shared -bg 2>/dev/null || true

# 5. vnc-bridge (noVNC static page + WS :6080) [gui.web]
if [ -f /opt/aiti/data/aiti-ui-env/vnc-bridge.mjs ]; then
  node /opt/aiti/data/aiti-ui-env/vnc-bridge.mjs --port 6080 --vnc 5900 --web /usr/share/novnc &
else
  # fallback: websockify direct bridge (bundled with the novnc package)
  websockify --web /usr/share/novnc 6080 localhost:5900 2>/dev/null &
fi

# 6. Chrome/Chromium + CDP (:9222, --no-sandbox in-container) [debug.cdp]
# The image installs google-chrome-stable (ubuntu's chromium-browser is a snap transition package — see Dockerfile.full R4);
# the chromium fallback lets other distros / custom images reuse this script
google-chrome-stable $AITI_CHROMIUM_FLAGS --start-maximized about:blank 2>/dev/null \
  || chromium-browser $AITI_CHROMIUM_FLAGS --start-maximized about:blank 2>/dev/null \
  || chromium $AITI_CHROMIUM_FLAGS --start-maximized about:blank 2>/dev/null &
echo "[gui-start] browser cdp :9222"

wait
