#!/usr/bin/env bash
# aiti-ui-env · 服务化安装（systemd）——Xvfb/openbox/AT-SPI/VNC 常驻，agent 随时可裁决落屏
#
# 用法：
#   ./install-service.sh            # 自动选 user 模式（推荐：agent 与 Xvfb 同用户）
#   ./install-service.sh --system   # 系统级（/etc/systemd/system，专有 ui-env 系统用户）
#   ./install-service.sh --user     # 强制 user 模式
#   ./install-service.sh --stop     # 停止并卸载
#
# user 模式（推荐）：
#   unit 写到 ~/.config/systemd/user/；loginctl enable-linger 保活（登出也常驻——服务场景关键）
#   Xvfb 跑在与 agent 相同的用户下 → 无 Xauthority/权限问题，AT-SPI bus 路径固定可探测
# system 模式：
#   unit 写到 /etc/systemd/system/，Xvfb 跑专有 ui-env 系统用户（权限收敛）
#   局限：系统服务缺 user bus/XDG_RUNTIME_DIR 便利性——这正是"服务里虚拟环境有限"的常态，
#   本方案定位服务只保基础设施常驻，应用仍由 agent 按模式拉起（见 plan §5）
set -u

DISPLAY_NUM="${UI_ENV_DISPLAY_NUM:-99}"
RESOLUTION="${UI_ENV_RESOLUTION:-1920x1080x24}"
AUTH_DIR="${UI_ENV_XAUTH_DIR:-/tmp/ui-env-$DISPLAY_NUM}"
VNC_PORT="${UI_ENV_VNC_PORT:-5900}"
WEB_PORT="${UI_ENV_VNC_WEB_PORT:-6080}"
NOVNC_DIR="${UI_ENV_NOVNC_DIR:-/opt/novnc}"
MODE="user"
STOP=0
UNIT_DIR="$HOME/.config/systemd/user"
SYSTEM_USER="ui-env"

for a in "$@"; do
  case "$a" in
    --system) MODE="system" ;;
    --user) MODE="user" ;;
    --stop) STOP=1 ;;
  esac
done

is_active() { # $1=unit 名
  if [ "$MODE" = "user" ]; then systemctl --user is-active "$1" >/dev/null 2>&1
  else systemctl is-active "$1" >/dev/null 2>&1; fi
}
sysctl_cmd() {
  if [ "$MODE" = "user" ]; then systemctl --user "$@"; else systemctl "$@"; fi
}

if [ "$STOP" = 1 ]; then
  [ "$MODE" = "user" ] || SD="sudo "
  for u in ui-env.target ui-env-vnc ui-env-wm ui-env-bus ui-env-xvfb; do
    ${SD}systemctl $([ "$MODE" = "user" ] && echo --user) disable --now "$u" >/dev/null 2>&1 || true
  done
  echo "[aiti-ui-env] 已停止并禁用全部 ui-env units（文件保留在 $UNIT_DIR 或 /etc/systemd/system）"
  exit 0
fi

# 只有 system 模式需要目标目录权限
if [ "$MODE" = "system" ]; then SD="sudo "; mkdir -p /etc/systemd/system
else SD=""; mkdir -p "$UNIT_DIR"; fi

cat_unit() { # $1=相对目录 $2=unit名 $3=内容
  local dir="$1" name="$2"
  printf '%s\n' "$3" > "$dir/$name"
  echo "[aiti-ui-env] 写入 $dir/$name"
}

# 内容变量已展开；user/system 差异用 U 前缀标记，这里直接以当前 shell 值写死
# 5900 被占（桌面 gdm 等）时自动换随机端口——避免 x11vnc 起不来/bridge 连到错屏
if (ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -q ":$VNC_PORT "; then
  OLD_VNC="$VNC_PORT"
  VNC_PORT=$(shuf -i 5950-5999 -n 1 2>/dev/null || echo 5990)
  echo "[aiti-ui-env] $OLD_VNC 被占用 → VNC 端口改随机 $VNC_PORT（middleware 注册表模式自动匹配；legacy systemd 探测用 env UI_ENV_VNC_PORT=$VNC_PORT）"
fi
XAUTH="$AUTH_DIR/Xauthority"
BUS="$AUTH_DIR/bus"
RT="$AUTH_DIR/runtime"


unit_xvfb="[Unit]
Description=aiti-ui-env Xvfb virtual display (:$DISPLAY_NUM)
After=systemd-user-sessions.service

[Service]
Type=simple
Environment=XAUTHORITY=$XAUTH
ExecStartPre=/bin/sh -c 'mkdir -p $AUTH_DIR $RT && chmod 700 $RT && (XAUTHORITY=$XAUTH xauth generate :$DISPLAY_NUM . trusted 2>/dev/null || true)'
ExecStart=/usr/bin/Xvfb :$DISPLAY_NUM -screen 0 $RESOLUTION -nolisten tcp -auth $XAUTH
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
"

unit_bus="[Unit]
Description=aiti-ui-env session dbus bus + AT-SPI
After=ui-env-xvfb.service
Requires=ui-env-xvfb.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'if [ ! -S $BUS ]; then dbus-daemon --session --fork --address=unix:path=$BUS --print-address >/dev/null 2>&1 || true; fi; export DBUS_SESSION_BUS_ADDRESS=unix:path=$BUS; DISPLAY=:$DISPLAY_NUM at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 || true'
ExecStop=/bin/sh -c 'rm -f $BUS'

[Install]
WantedBy=default.target
"

unit_wm="[Unit]
Description=aiti-ui-env openbox window manager on :$DISPLAY_NUM
After=ui-env-xvfb.service ui-env-bus.service
Requires=ui-env-xvfb.service

[Service]
Type=simple
Environment=DISPLAY=:$DISPLAY_NUM
Environment=XAUTHORITY=$XAUTH
Environment=XDG_RUNTIME_DIR=$RT
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=$BUS
ExecStart=/usr/bin/openbox
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
"

# VNC：x11vnc 只回环；node vnc-bridge 把 6080 的 WS 转发到 5900 并 serve noVNC 静态页
# （零依赖 node 脚本；token 经 env 传入，不落命令行）
unit_vnc="[Unit]
Description=aiti-ui-env VNC-on-web (127.0.0.1:$VNC_PORT RFB + 127.0.0.1:$WEB_PORT noVNC)
After=ui-env-xvfb.service
Requires=ui-env-xvfb.service

[Service]
Type=simple
Environment=DISPLAY=:$DISPLAY_NUM
Environment=XAUTHORITY=$XAUTH
ExecStartPre=/bin/sh -c 'command -v x11vnc >/dev/null 2>&1 || echo warn-missing-x11vnc; command -v node >/dev/null 2>&1 || echo warn-missing-node'
# 都只绑回环：外部经 pi-web middleware 代理（/aiti-ui-env/vnc/*）访问，不对外开端口
ExecStart=/bin/sh -c 'x11vnc -display :$DISPLAY_NUM -forever -shared -rfbport $VNC_PORT -localhost -auth $XAUTH 2>>/tmp/aiti-ui-env-vnc.log & BRIDGE=$HOME/.pi/web/data/aiti-ui-env/cache/vnc-bridge.mjs; TOKEN=$(cat $HOME/.pi/web/data/aiti-ui-env/config/vnc-token 2>/dev/null || node -e "process.stdout.write(require(\"crypto\").randomBytes(16).toString(\"hex\"))"); [ -n "$TOKEN" ] || TOKEN=$(node -e "process.stdout.write(require(\"crypto\").randomBytes(16).toString(\"hex\"))"); UI_ENV_VNC_TOKEN=$TOKEN UI_ENV_VNC_WEB_PORT=$WEB_PORT UI_ENV_VNC_PORT=$VNC_PORT UI_ENV_NOVNC_DIR=$NOVNC_DIR exec node $BRIDGE 2>>/tmp/aiti-ui-env-vnc.log'
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
"

unit_target="[Unit]
Description=aiti-ui-env virtual display stack target
Requires=ui-env-xvfb.service ui-env-bus.service ui-env-wm.service ui-env-vnc.service
After=ui-env-xvfb.service ui-env-bus.service ui-env-wm.service ui-env-vnc.service

[Install]
WantedBy=default.target
"

if [ "$MODE" = "user" ]; then
  cat_unit "$UNIT_DIR" "ui-env-xvfb.service" "$unit_xvfb"
  cat_unit "$UNIT_DIR" "ui-env-bus.service" "$unit_bus"
  cat_unit "$UNIT_DIR" "ui-env-wm.service" "$unit_wm"
  cat_unit "$UNIT_DIR" "ui-env-vnc.service" "$unit_vnc"
  cat_unit "$UNIT_DIR" "ui-env.target" "$unit_target"
  systemctl --user daemon-reload
  systemctl --user enable --now ui-env.target
  loginctl enable-linger "$(id -un)" 2>/dev/null && echo "[aiti-ui-env] 已启用 linger（登出后常驻）" || echo "[aiti-ui-env] linger 启用失败（sudo loginctl enable-linger $(id -un)）"
  echo "[aiti-ui-env] user 服务已就绪：systemctl --user status ui-env.target"
else
  # 系统模式：专有用户 + sudo 写入 /etc/systemd/system
  id "$SYSTEM_USER" >/dev/null 2>&1 || sudo useradd -r -s /usr/sbin/nologin "$SYSTEM_USER" 2>/dev/null || true
  # Xvfb 系统用户跑，/tmp/ui-env-99 归它；agent 同主机读 socket 无碍
  sudo mkdir -p "$AUTH_DIR" "$RT" && sudo chmod 700 "$RT"
  sudo chown -R "$SYSTEM_USER" "$AUTH_DIR" 2>/dev/null || true
  cat_unit /etc/systemd/system "ui-env-xvfb.service" "$unit_xvfb"
  cat_unit /etc/systemd/system "ui-env-bus.service" "$unit_bus"
  cat_unit /etc/systemd/system "ui-env-wm.service" "$unit_wm"
  cat_unit /etc/systemd/system "ui-env-vnc.service" "$unit_vnc"
  cat_unit /etc/systemd/system "ui-env.target" "$unit_target"
  sudo systemctl daemon-reload
  sudo systemctl enable --now ui-env.target
  echo "[aiti-ui-env] system 服务已就绪：systemctl status ui-env.target"
fi

echo
echo "验证："
echo "  ss -tln | grep -E ':$VNC_PORT|:$WEB_PORT'      # VNC TCP + web（均应只在 127.0.0.1）"
echo "  ls /tmp/.X11-unix/X$DISPLAY_NUM                 # 虚拟屏 socket"
echo "  DISPLAY=:$DISPLAY_NUM xdpyinfo | head -3        # 屏可达"
echo "浏览器：打开 pi-web 🖥️ 显示环境面板 → VNC-on-web（当前站点路径下直访，无新端口）"
echo "CLI：eval \"\$(ui-env env)\"  → 拿当前模式裁决的显示环境"