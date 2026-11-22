#!/usr/bin/env bash
# aiti-ui-env · macOS 环境自检/装配（幂等）
#
# macOS 无 Xvfb/openbox 等价物（详见 docs/aiti-ui-env-macos-support-plan.md）：
#   桌面   = Aqua 控制台会话（GUI 应用以 pi-web 同身份 spawn 即落桌面）
#   无头层 = 屏幕共享 VNC server（com.apple.screensharing，5900）+ vnc-bridge/noVNC 浏览器查看
# 本脚本做两件事：
#   （无参数）          全量自检，输出各项 ✓/✗ 与修复指引
#   enable              尝试开启屏幕共享（需免密 sudo；无则打印手动步骤）
#   install-extras      brew 装 cliclick（可选增强，对应 Linux xdotool）
#   --ask-ai            失败时输出可直接丢给 AI 的排查 prompt
#
# 用法：bash scripts/macos/setup-macos.sh [enable|install-extras|--ask-ai]
set -u

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { echo "  ${GRN}✓${RST} $1"; }
bad()  { echo "  ${RED}✗${RST} $1"; }
warn() { echo "  ${YLW}!${RST} $1"; }
FAILURES=()

# /usr/sbin 在 daemon/ssh 上下文常不在 PATH（netstat/screencapture/system_profiler 在此）
NETSTAT=/usr/sbin/netstat; [ -x "$NETSTAT" ] || NETSTAT=$(command -v netstat 2>/dev/null || echo netstat)

port_listening() { "$NETSTAT" -an -p tcp 2>/dev/null | grep -q "[:.]$1 .*LISTEN"; }

managername() { launchctl managername 2>/dev/null || echo "?"; }
console_user() { /usr/bin/stat -f%Su /dev/console 2>/dev/null || echo "?"; }
me() { echo "${USER:-$(id -un)}"; }

brew_bin() {
  for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$p" ] && { echo "$p"; return 0; }; done
  command -v brew 2>/dev/null || return 1
}

cliclick_bin() {
  for p in /opt/homebrew/bin/cliclick /usr/local/bin/cliclick; do [ -x "$p" ] && { echo "$p"; return 0; }; done
  command -v cliclick 2>/dev/null || return 1
}

SCREENSHARING_PLIST="/System/Library/LaunchDaemons/com.apple.screensharing.plist"

check_all() {
  echo "── macOS UI 环境自检 ──"
  # 1) Node
  if command -v node >/dev/null 2>&1; then ok "node $(node -v 2>/dev/null)"; else bad "node 未安装"; FAILURES+=("node"); fi
  # 2) Aqua 会话
  local mgr cu me_
  mgr=$(managername); cu=$(console_user); me_=$(me)
  if [ "$mgr" = "Aqua" ]; then ok "本进程 launchd 上下文 = Aqua（GUI 会话）"
  else warn "本进程 launchd 上下文 = $mgr（非 Aqua）：GUI 可能无法显示；pi-web 请以 LaunchAgent（gui 域）运行"; FAILURES+=("aqua-context:$mgr"); fi
  if [ "$cu" != "root" ] && [ "$cu" != "?" ]; then
    if [ "$cu" = "$me_" ]; then ok "控制台登录用户 = $cu（GUI 应用落其桌面）"
    else bad "控制台用户 $cu ≠ 本进程用户 $me_：GUI 无法落到桌面"; FAILURES+=("console-user:$cu"); fi
  else
    bad "Mac 停在登录窗口（/dev/console 属主 root）：登录用户会话后桌面才可用"; FAILURES+=("login-window"); fi
  # 3) 屏幕共享 VNC
  if port_listening 5900; then ok "屏幕共享 VNC（5900 监听中）——浏览器查看层就绪"
  else bad "屏幕共享（VNC server）未开启"; FAILURES+=("screensharing"); fi
  # 4) 可选增强
  if command -v brew >/dev/null 2>&1 || [ -n "$(brew_bin 2>/dev/null || true)" ]; then ok "Homebrew 已装（$(brew_bin 2>/dev/null)）"
  else warn "Homebrew 未装（可选增强装不了，不影响核心链路）"; fi
  if [ -n "$(cliclick_bin 2>/dev/null || true)" ]; then ok "cliclick（CLI 点击自动化）已装"
  else warn "cliclick 未装（可选；brew install cliclick）"; fi
  if [ -d /opt/X11 ] || [ -d "/Applications/Utilities/XQuartz.app" ] || [ -d /tmp/.X11-unix ]; then
    ok "XQuartz（X11 应用支持）已装"
  else warn "XQuartz 未装（可选；brew install --cask xquartz）"; fi
  # 5) 部署产物（noVNC / bridge）
  local data="${UI_ENV_DATA_DIR:-$HOME/.pi/web/data/aiti-ui-env}"
  if [ -f "$data/cache/novnc/vnc.html" ]; then ok "noVNC 静态页已部署（$data/cache/novnc）"
  else bad "noVNC 静态页缺失：重新部署扩展（node pi-web-ext/aiti-ui-env/tools/deploy.mjs）"; FAILURES+=("novnc"); fi
  if [ -f "$data/cache/vnc-bridge.mjs" ]; then ok "vnc-bridge 已部署"
  else bad "vnc-bridge 缺失：重新部署扩展"; FAILURES+=("vnc-bridge"); fi
  echo ""
  if [ ${#FAILURES[@]} -eq 0 ]; then echo "${GRN}全部核心项就绪${RST}"
  else echo "${YLW}待修复 ${#FAILURES[@]} 项：${FAILURES[*]}${RST}"; fi
}

enable_screensharing() {
  if port_listening 5900; then ok "屏幕共享已开启（5900 监听中），无需操作"; return 0; fi
  echo "尝试开启屏幕共享（系统服务 com.apple.screensharing）…"
  if sudo -n true 2>/dev/null; then
    if sudo -n launchctl load -w "$SCREENSHARING_PLIST" 2>/dev/null; then
      for i in 1 2 3 4 5 6 7 8 9 10; do
        sleep 0.5
        if port_listening 5900; then ok "屏幕共享已开启（5900 监听中）"; return 0; fi
      done
      bad "launchctl load 已执行但 5900 未监听：看系统设置 → 通用 → 共享 → 屏幕共享 是否被 MDM/策略限制"; return 1
    fi
    bad "launchctl load 失败"; return 1
  fi
  warn "无免密 sudo，请手动任选其一："
  echo "    ① 系统设置 → 通用 → 共享 → 打开「屏幕共享」"
  echo "    ② 终端执行：sudo launchctl load -w $SCREENSHARING_PLIST"
  echo "    ③ 给当前终端免密 sudo 后重跑本命令"
  return 1
}

install_extras() {
  local brew
  brew=$(brew_bin 2>/dev/null || true)
  if [ -z "$brew" ]; then warn "未装 Homebrew，跳过（https://brew.sh）"; return 1; fi
  if [ -n "$(cliclick_bin 2>/dev/null || true)" ]; then ok "cliclick 已装，跳过"; return 0; fi
  echo "brew install cliclick …"
  "$brew" install cliclick && ok "cliclick 已装" || { bad "brew install cliclick 失败"; return 1; }
}

ask_ai() {
  cat <<EOF
── 给 AI 的排查 prompt（复制整段） ──
我在 macOS（$(sw_vers -productVersion 2>/dev/null)）上配置 aiti-ui-env 扩展的 UI 环境，自检失败项：${FAILURES[*]:-（未跑自检）}。
环境事实：launchd 上下文=$(managername)；控制台用户=$(console_user)；本进程用户=$(me)；
屏幕共享 5900=$($([ -x "$NETSTAT" ] && "$NETSTAT" -an -p tcp 2>/dev/null | grep -q "[:.]5900 .*LISTEN" && echo 开 || echo 关))；
Homebrew=$(brew_bin 2>/dev/null || echo 无)。
请给我具体修复步骤（优先不改系统安全的方案），并解释每一步在做什么。
EOF
}

case "${1:-}" in
  "")             check_all ;;
  enable)         enable_screensharing || FAILURES+=("enable") ;;
  install-extras) install_extras || FAILURES+=("extras") ;;
  --ask-ai)       [ ${#FAILURES[@]} -eq 0 ] && check_all; ask_ai ;;
  *) echo "用法: $0 [enable|install-extras|--ask-ai]" >&2; exit 1 ;;
esac
[ ${#FAILURES[@]} -gt 0 ] && exit 1
exit 0
