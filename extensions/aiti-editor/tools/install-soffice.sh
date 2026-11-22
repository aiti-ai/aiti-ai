#!/usr/bin/env bash
# install-soffice —— 服务器端一键安装 LibreOffice (soffice)（aiti-editor / aiti-sheet-univer 老格式转换依赖）
#
# 用法：  bash install-soffice.sh
# 权限：  root 直接装；sudo 免密自动提权；sudo 需要密码 → exit 32（把命令交给用户手动跑）
# 平台：  Linux 多发行版自适应（apt/dnf/yum/pacman/apk/zypper）；Windows/macOS 不适用（见 SKILL.md 手册）
# 内容：  LibreOffice 写算演三件套（writer/calc/impress + draw/core）+ 中文字体（Noto CJK，防 PDF 中文乱码）
# 验证：  装完跑 soffice --version，结尾输出机器可读行：
#         SOFFICE_INSTALL_RESULT ok|fail|already path=... version="..."
set -u

log() { echo "[install-soffice] $*"; }

# ---- 0) 已装则直接收工 -------------------------------------------------------
find_soffice() {
  command -v soffice 2>/dev/null || command -v libreoffice 2>/dev/null || \
  { [ -x /usr/bin/soffice ] && echo /usr/bin/soffice; } || \
  { [ -x /opt/libreoffice/program/soffice ] && echo /opt/libreoffice/program/soffice; }
  return 0
}

report() { # ok|already|fail
  local ver=""; ver="$(soffice --version 2>/dev/null | head -1 | tr -d '\r')"
  echo "SOFFICE_INSTALL_RESULT $1 path=$(find_soffice) version=\"${ver:-?}\""
}

if bin="$(find_soffice)" && [ -n "$bin" ]; then
  log "已安装：$($bin --version 2>/dev/null | head -1) · $bin"
  report already
  exit 0
fi

# ---- 1) 提权策略：root → 直接；sudo -n 免密 → sudo；否则放弃（AI 把命令交给用户） ----
SUDO=""
if [ "$(id -u)" = "0" ]; then
  SUDO=""
elif sudo -n true 2>/dev/null; then
  SUDO="sudo"
else
  log "需要 root 或 sudo 免密权限；请手动执行下方对应命令后重跑本脚本验证。"
  report fail
  exit 32
fi

# ---- 2) 发行版分发安装（--no-install-recommends 精简 + 中文字体必备） --------
install_deb() {
  $SUDO apt-get update -y || return 1
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y --no-install-recommends \
    libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw \
    fonts-noto-cjk fonts-dejavu-core
}
install_rpm() { # dnf / yum
  local pkg="$1"
  $SUDO $pkg install -y libreoffice-writer libreoffice-calc libreoffice-impress google-noto-sans-cjk-ttc-fonts dejavu-fonts-common || return 1
}
install_pacman() {
  $SUDO pacman -Sy --noconfirm --needed libreoffice-still noto-fonts-cjk
}
install_apk() {
  $SUDO apk add --no-cache libreoffice libreoffice-lang-zh_cn font-noto-cjk
}
install_zypper() {
  $SUDO zypper --non-interactive install libreoffice noto-sans-cjk-fonts
}

rc=1
if command -v apt-get >/dev/null 2>&1; then
  log "Debian/Ubuntu 系：apt 安装中（约 300-500MB，几分钟）…"
  install_deb; rc=$?
elif command -v dnf >/dev/null 2>&1; then
  log "Fedora/RHEL 系：dnf 安装中…"; install_rpm dnf; rc=$?
elif command -v yum >/dev/null 2>&1; then
  log "RHEL 系：yum 安装中…"; install_rpm yum; rc=$?
elif command -v pacman >/dev/null 2>&1; then
  log "Arch 系：pacman 安装中…"; install_pacman; rc=$?
elif command -v apk >/dev/null 2>&1; then
  log "Alpine：apk 安装中…"; install_apk; rc=$?
elif command -v zypper >/dev/null 2>&1; then
  log "openSUSE：zypper 安装中…"; install_zypper; rc=$?
else
  log "未识别的发行版：请手动安装 LibreOffice（https://www.libreoffice.org/download/download/ ）"
  report fail
  exit 30
fi

if [ $rc -ne 0 ] || ! bin="$(find_soffice)" || [ -z "$bin" ]; then
  log "安装失败（rc=$rc）。可重跑本脚本重试；或按发行版手动安装。"
  report fail
  exit 1
fi

# ---- 3) 验证 ----------------------------------------------------------------
log "安装完成 ✓"
report ok
exit 0
