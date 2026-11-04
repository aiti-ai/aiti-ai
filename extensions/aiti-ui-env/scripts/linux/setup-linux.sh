#!/usr/bin/env bash
# aiti-ui-env · Linux 安装脚本（Xvfb + openbox + dbus/AT-SPI + x11vnc + node vnc-bridge + noVNC）
#
# 用法：
#   sudo ./setup-linux.sh            # apt 安装全部组件（缺失项；幂等）
#   ./setup-linux.sh --dry-run       # 只报告缺什么，不安装
#   ./setup-linux.sh --bare          # 不装包，直接裸拉起虚拟屏（Xvfb+dbus+at-spi+openbox）
#   ./setup-linux.sh --ask-ai        # 失败时输出可整段投喂 AI 的排查上下文
#
# 安装策略：优先系统包管理器（apt/apt-get），缺包或版本过期 → justget 多源竞速下载兜底
# （noVNC/纯静态类）、实在搞不定 → --ask-ai 打印求助 prompt。
# justget 位置：默认 $JUSTGET_BIN / PATH / ~/workspace/justget
set -u

DISPLAY_NUM="${UI_ENV_DISPLAY_NUM:-99}"
RESOLUTION="${UI_ENV_RESOLUTION:-1920x1080x24}"
AUTH_DIR="${UI_ENV_XAUTH_DIR:-/tmp/ui-env-$DISPLAY_NUM}"
VNC_PORT="${UI_ENV_VNC_PORT:-5900}"
WEB_PORT="${UI_ENV_VNC_WEB_PORT:-6080}"
NOVNC_DIR="${UI_ENV_NOVNC_DIR:-/opt/novnc}"
LOG="/tmp/aiti-ui-env-setup.log"
ASK_AI=0
BARE=0
DRY=0

has() { command -v "$1" >/dev/null 2>&1; }
say() { echo "[aiti-ui-env] $*"; }
warn() { echo "[aiti-ui-env] WARN $*"; }

# ── ask-ai：失败时输出可整段投喂 AI 的排查上下文（函数先定义后使用） ──
ask_ai() {
  local topic="$1" detail="$2"
  echo
  echo "══════════ AI 协助请求（把下面整段发给 AI） ══════════"
  echo "目标：在无头服务器搭建 aiti-ui-env 虚拟屏（Xvfb+openbox+AT-SPI+VNC-on-web）"
  echo "故障：$topic"
  echo "--- 系统信息 ---"
  . /etc/os-release 2>/dev/null && echo "OS: $PRETTY_NAME"
  uname -a
  echo "--- 失败详情 ---"
  echo "$detail"
  echo "--- 我的环境 ---"
  echo "DISPLAY_NUM=$DISPLAY_NUM RESOLUTION=$RESOLUTION VNC=$VNC_PORT WEB=$WEB_PORT"
  echo "justget=${JUSTGET:-未找到}"
  echo "命令输出日志：$LOG"
  echo "请给出：1) 缺什么/错在哪 2) 逐条修复命令 3) 装完后的启动验证"
  echo "══════════════════════════════════════════════════"
}

# justget 执行器：路径 → node 跑；命令名 → 直接跑
jget() {
  if [ -n "$JUSTGET" ] && [ -f "$JUSTGET" ]; then node "$JUSTGET" "$@"
  elif has justget; then justget "$@"
  else return 1; fi
}

for a in "$@"; do
  case "$a" in
    --bare) BARE=1 ;;
    --dry-run) DRY=1 ;;
    --ask-ai) ASK_AI=1 ;;
  esac
done

# ── 0. justget 探测 ──
JUSTGET=""
for c in "${JUSTGET_BIN:-}" "$HOME/workspace/justget/dist/cli.js" "$HOME/workspace/justget/justget.mjs"; do
  [ -n "$c" ] && [ -f "$c" ] && JUSTGET="$c" && break
done
[ -z "$JUSTGET" ] && has justget && JUSTGET="justget"
if [ -z "$JUSTGET" ] && [ "$BARE" = 0 ]; then
  warn "未找到 justget（多源下载兜底会跳过）。可：git clone --depth 1 <justget仓库> ~/workspace/justget 或放入 PATH"
fi

# 工具检查清单
tools=(Xvfb openbox x11vnc dbus-daemon at-spi-bus-launcher xauth xdpyinfo xdotool wmctrl)
# VNC web 层用自写 node vnc-bridge（零依赖）；需 node + 部署扩展
has node || say "注意: 缺 node（pi-web 运行环境自带；独立部署需装）"
missing=()
for t in "${tools[@]}"; do has "$t" || missing+=("$t"); done

if [ ${#missing[@]} -gt 0 ]; then
  say "缺少: ${missing[*]}"
  [ "$DRY" = 1 ] && { echo "[aiti-ui-env] dry-run: apt install 建议 → ${missing[*]}"; exit 0; }
  if [ "$BARE" = 1 ]; then
    say "--bare 模式跳过包安装（仅拉起已有组件）"
  else
    say "尝试系统包管理器安装…"
    if has apt-get; then
      DEBIAN_FRONTEND=noninteractive apt-get update -y >>"$LOG" 2>&1
      DEBIAN_FRONTEND=noninteractive apt-get install -y \
        xvfb openbox x11vnc novnc dbus-x11 at-spi2-core \
        xauth x11-utils xdotool wmctrl tigervnc-common >>"$LOG" 2>&1 || {
          warn "apt 安装部分失败，看 $LOG"
          [ "$ASK_AI" = 1 ] && ask_ai "apt 安装失败" "$(tail -30 "$LOG")"
        }
    elif has dnf; then
      dnf install -y xorg-x11-server-Xvfb openbox x11vnc novnc at-spi2-core dbus-x11 xauth xorg-x11-utils xdotool wmctrl >>"$LOG" 2>&1
    else
      warn "无 apt/dnf；走 justget 兜底或手动安装（--ask-ai 求助）"
      [ "$ASK_AI" = 1 ] && ask_ai "无系统包管理器" "当前发行版: $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
    fi
  fi
  # 复查
  for t in "${missing[@]}"; do has "$t" && say "OK $t 已就位"; done
  missing2=(); for t in "${tools[@]}"; do has "$t" || missing2+=("$t"); done
  if [ ${#missing2[@]} -gt 0 ] && [ "$ASK_AI" = 1 ] && [ "$BARE" = 0 ]; then
    ask_ai "仍缺: ${missing2[*]}" "apt 日志尾部: $(tail -20 "$LOG" 2>/dev/null)"
  fi
fi

# ── 1. noVNC 兜底下载（apt 装了 novnc 则跳过；--dry-run/--bare 跳过） ──
if [ "$DRY" = 0 ] && [ "$BARE" = 0 ] && [ -n "$JUSTGET" ] && ! has novnc && ! [ -f "$NOVNC_DIR/vnc.html" ]; then
  say "noVNC 未装，justget 下载兜底 → $NOVNC_DIR"
  mkdir -p "$NOVNC_DIR"
  URL="https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz"
  if jget "$URL" -o "$NOVNC_DIR/noVNC.tar.gz" \
    -m "https://gh-proxy.com/$URL" -m "https://ghfast.top/$URL" >>"$LOG" 2>&1; then
    tar -xzf "$NOVNC_DIR/noVNC.tar.gz" -C "$NOVNC_DIR" --strip-components=1
    rm -f "$NOVNC_DIR/noVNC.tar.gz"
    say "OK noVNC 就绪 $NOVNC_DIR/vnc.html"
  else
    warn "noVNC 下载失败（看 $LOG）"
    [ "$ASK_AI" = 1 ] && ask_ai "noVNC 下载失败" "$(tail -15 "$LOG")"
  fi
fi

# ── 2. 裸拉起虚拟屏（--bare 或非 systemd 环境；幂等） ──
if [ "$DRY" = 0 ]; then
  [ "$BARE" = 1 ] && say "裸拉起虚拟屏 :$DISPLAY_NUM（$RESOLUTION）"
  mkdir -p "$AUTH_DIR" "$AUTH_DIR/runtime"
  chmod 700 "$AUTH_DIR/runtime" 2>/dev/null
  if has Xvfb && ! [ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ]; then
    XAUTHORITY="$AUTH_DIR/Xauthority" xauth generate ":$DISPLAY_NUM" . trusted 2>/dev/null || true
    nohup Xvfb ":$DISPLAY_NUM" -screen 0 "$RESOLUTION" -nolisten tcp -auth "$AUTH_DIR/Xauthority" >>"$LOG" 2>&1 &
    disown
    sleep 0.6
    say "OK Xvfb 已起"
  elif [ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ]; then
    say "Xvfb :$DISPLAY_NUM 已在跑"
  fi
  if has dbus-daemon && ! [ -S "$AUTH_DIR/bus" ]; then
    dbus-daemon --session --fork --address="unix:path=$AUTH_DIR/bus" --print-address >/dev/null 2>&1 || true
    DISPLAY=":$DISPLAY_NUM" at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 || true
    say "OK dbus + AT-SPI bus 已起"
  fi
  if has openbox && ! DISPLAY=":$DISPLAY_NUM" xprop -root _NET_SUPPORTING_WM_CHECK >/dev/null 2>&1; then
    # 只认 :$DISPLAY_NUM 上已有 WM（pgrep 全局匹配会误判桌面 :0 的 openbox，导致 :99 永远无 WM）
    nohup env DISPLAY=":$DISPLAY_NUM" XAUTHORITY="$AUTH_DIR/Xauthority" \
      XDG_RUNTIME_DIR="$AUTH_DIR/runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$AUTH_DIR/bus" \
      openbox >>"$LOG" 2>&1 &
    disown
    say "OK openbox 已起"
  fi
  # 5900 被占（桌面 gdm 等）时换随机端口，避免起不来/连错屏；本段仅回环兜底，主路径用扩展面板（随机端口+注册表）
  if (ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -q ":$VNC_PORT "; then
    warn "$VNC_PORT 被占用（桌面 x11vnc 等）→ 换随机端口（仅本次裸起）"
    VNC_PORT=$(shuf -i 5950-5999 -n 1 2>/dev/null || echo 5990)
  fi
  if has x11vnc && ! (ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -q ":$VNC_PORT "; then
    # -auth 必须与 Xvfb 一致（Xvfb -auth 保护时无 cookie 会被拒）；仅回环
    nohup x11vnc -display ":$DISPLAY_NUM" -forever -shared -rfbport "$VNC_PORT" -localhost -auth "$AUTH_DIR/Xauthority" >>"$LOG" 2>&1 &
    disown
    say "OK x11vnc :$VNC_PORT 已起（仅回环）"
  fi
  if command -v node >/dev/null 2>&1 && ! (ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -q ":$WEB_PORT "; then
    if has novnc && [ -z "${NOVNC_DIR//\/opt\/novnc/}" ]; then
      NOVNC_DIR="/usr/share/novnc"
    fi
    local bridge="$HOME/.pi/web/data/aiti-ui-env/cache/vnc-bridge.mjs" # 数据分层：<extRoot>/cache
    if [ -f "$bridge" ]; then
      local tok; tok=$(cat "$HOME/.pi/web/data/aiti-ui-env/config/vnc-token" 2>/dev/null || node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))")
      [ -z "$tok" ] && tok=$(node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))")
      # 只绑回环：外部经 pi-web middleware 代理访问（/aiti-ui-env/vnc/*），不对外开端口
      UI_ENV_VNC_TOKEN="$tok" UI_ENV_VNC_WEB_PORT="$WEB_PORT" UI_ENV_VNC_PORT="$VNC_PORT" UI_ENV_NOVNC_DIR="$NOVNC_DIR" nohup node "$bridge" >>"$LOG" 2>&1 &
      disown
      say "OK node vnc-bridge/noVNC 已起（仅回环 :$WEB_PORT；外部走 middleware 代理；无 python 依赖）"
    else
      say "注意: 缺 $bridge（先部署扩展 node tools/deploy.mjs），跳过 VNC web 层"
    fi
  fi
  say "面板内查看：打开 🖥️ 显示环境 → VNC-on-web（经当前站点 middleware 代理，无新端口）"
  say "（公网暴露无需开端口——middleware rewrite 已内置令牌校验）"
else
  echo "[aiti-ui-env] dry-run 结束。缺: ${missing[*]:-无}"
fi

exit 0