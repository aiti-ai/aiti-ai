#!/usr/bin/env bash
# entrypoint.sh —— aiti 容器统一入口（aiti-docker-image-plan §3.3）
# root 启动做初始化（用户重建/chown/目录）→ gosu 降权 aiti 跑主服务。
# phases 语义与 Windows start.ps1 / Linux systemd 同一份（方案 §9.3 S5 验收口径）：
#   piweb | bridge | gui | asr | term —— AITI_PHASES 逗号分隔，缺省 piweb,bridge
# 无轮询无 sleep 等待循环：进程后台拉起 + wait；信号经 trap 转发（docker --init 兜底）。

set -e

# ⚠ 不能用 $UID/$GID——是 bash 只读内建变量（root 下恒 0），env 传不进来。
# 用 linuxserver.io 惯例 PUID/PGID（compose/README 同步），缺省 1000。
UID_HOST="${PUID:-1000}"
GID_HOST="${PGID:-1000}"
AITI_HOME="/home/aiti"

# ── 0. 身份与目录 ─────────────────────────────────────────────────────────────
# root 启动（默认路径）：PUID/PGID 对齐重建用户 + chown 可变目录 + gosu 降权。
# --user 直起（方案 §2.1.4 简化路径，docker run --user 1000:1000）：非 root 无 setuid
# 权限，gosu 必炸（冒烟实证 "failed switching to 'aiti'"）——跳过全部 root 初始化，
# as_aiti 退化为直接执行。
if [ "$(id -u)" = "0" ]; then
  # UID/GID 与宿主对齐时（linuxserver.io PUID/PGID 模式）重建同名用户
  if [ "$(id -u aiti 2>/dev/null)" != "$UID_HOST" ] || [ "$(id -g aiti 2>/dev/null)" != "$GID_HOST" ]; then
    userdel -r aiti 2>/dev/null || true
    groupadd -g "$GID_HOST" aiti 2>/dev/null || { groupmod -o -g "$GID_HOST" aiti 2>/dev/null || true; }
    useradd -m -u "$UID_HOST" -g "$GID_HOST" -s /bin/bash aiti
    echo "aiti ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/aiti
    chmod 0440 /etc/sudoers.d/aiti
  fi
  mkdir -p /workspace /opt/aiti/data /opt/aiti/agent
  # AITI_SKIP_CHOWN=1：用户以 docker --user 固定 uid 直起（方案 §2.1.4 简化路径）
  if [ "${AITI_SKIP_CHOWN:-0}" != "1" ]; then
    # 只 chown 可变目录（data/agent/workspace）——app/extensions 在镜像层内已是 aiti
    # 属主（首跑实证：全量 chown -R 数十万文件会卡住启动数分钟）
    chown -R aiti:aiti /opt/aiti/data /opt/aiti/agent /workspace 2>/dev/null || true
  fi
  as_aiti() { gosu aiti "$@"; }
else
  echo "[entrypoint] 非 root 直起（--user $(id -u):$(id -g)）——跳过 root 初始化与 gosu"
  mkdir -p /workspace /opt/aiti/data /opt/aiti/agent 2>/dev/null || true
  as_aiti() { "$@"; }
fi
# ── 0.5 pi 配置（settings 默认生成 + 可选继承宿主 ~/.pi，方案 §2.1.3）──────────
# settings.json 不再由镜像构建期预写（30-install-pi.sh 只装 CLI）——首启动在此生成默认
# （packages 六件）；若用户挂了 ~/.pi（compose 可选项）：
#   auth.json / models.json  缺失才采纳（种子语义，运行时文件不被覆盖）
#   settings.json            目标不存在→整体采纳；已存在→jq 合并（用户键优先 + packages 并集）
AGENT_DIR=/opt/aiti/agent
mkdir -p "$AGENT_DIR" 2>/dev/null || true
if [ ! -f "$AGENT_DIR/settings.json" ] && [ -f "$AITI_HOME/.pi/agent/settings.json" ]; then
  cp "$AITI_HOME/.pi/agent/settings.json" "$AGENT_DIR/settings.json"
  echo "[entrypoint] 配置继承：settings.json ← 宿主 ~/.pi/agent"
elif [ -f "$AITI_HOME/.pi/agent/settings.json" ] && command -v jq >/dev/null; then
  T=$(mktemp)
  # jq 对象合并右侧覆盖：$u=宿主用户文件 → 用户键优先；packages 取并集。
  # ⚠ 必须 `. as [$t,$u]` 先绑定——管道后 `.` 已是合并对象，再 `.[0]` 会 Cannot index object with number
  if jq -s '. as [$t, $u] | ($t * $u) | .packages = ((($t.packages // []) + ($u.packages // [])) | unique)' \
      "$AGENT_DIR/settings.json" "$AITI_HOME/.pi/agent/settings.json" > "$T" 2>/dev/null; then
    mv "$T" "$AGENT_DIR/settings.json"
    echo "[entrypoint] 配置继承：settings.json 已合并宿主配置（用户键优先 + packages 并集）"
  else
    rm -f "$T"
  fi
elif [ ! -f "$AGENT_DIR/settings.json" ]; then
  cat > "$AGENT_DIR/settings.json" <<'EOF'
{
  "packages": [
    "npm:pi-mcp-adapter",
    "npm:@aiti-ai/pi-subagents",
    "npm:@aiti-ai/pi-models-combo",
    "/opt/aiti/pi-plugins/pi-git-trace",
    "npm:pi-opencode-free",
    "npm:pi-freeflow"
  ]
}
EOF
  echo "[entrypoint] settings.json 默认生成（packages 六件）"
fi
for f in auth.json models.json; do
  if [ -f "$AITI_HOME/.pi/agent/$f" ] && [ ! -f "$AGENT_DIR/$f" ]; then
    cp "$AITI_HOME/.pi/agent/$f" "$AGENT_DIR/$f"
    echo "[entrypoint] 配置继承：$f ← 宿主 ~/.pi/agent"
  fi
done
if [ "$(id -u)" = "0" ]; then
  chown aiti:aiti "$AGENT_DIR/settings.json" "$AGENT_DIR/auth.json" "$AGENT_DIR/models.json" 2>/dev/null || true
fi
# AITI_NPM_REGISTRY（可选，临时）：测试期私包通道——pi 首启拉 settings.json 的 @aiti-ai/*
# 包时按 aiti 用户 npm 解析，写 ~/.npmrc scope 指向私仓；正式发布不传此 env = 公网 npm。
if [ -n "${AITI_NPM_REGISTRY:-}" ]; then
  printf '@aiti-ai:registry=%s\n' "$AITI_NPM_REGISTRY" > "$AITI_HOME/.npmrc"
  echo "[entrypoint] 私仓测试模式：@aiti-ai/* ← ${AITI_NPM_REGISTRY}（~/.npmrc）"
fi
cd /workspace

# 模式探测：full 层标记文件存在即 full（AITI_MODE 显式指定优先）
MODE="${AITI_MODE:-auto}"
if [ "$MODE" = "auto" ]; then
  [ -f /opt/aiti/.aiti-full ] && MODE=full || MODE=core
fi

PHASES="${AITI_PHASES:-piweb,bridge}"
want() { case ",$PHASES," in *",$1,"*) return 0;; *) return 1;; esac; }

# as_aiti 已按 root/非 root 在上方分别定义（gosu 降权 / 直接执行）

# ── phase: bridge（aiti-bridge 8777，方案 §3.3 core 分支 1）───────────────────
start_bridge() {
  as_aiti env AITI_BRIDGE_DATA_DIR="${AITI_BRIDGE_DATA_DIR:-/opt/aiti/data/aiti-bridge}" \
    node /opt/aiti/bridge/bin/aiti-bridge.mjs --host 0.0.0.0 --port "${AITI_BRIDGE_PORT:-8777}" &
  CHILD_PIDS+=("$!")
  echo "[entrypoint] bridge :${AITI_BRIDGE_PORT:-8777}"
}

# ── phase: piweb（standalone server.js 优先；AITI_DEV=1 挂源码走 next dev，R8）────
start_piweb() {
  if [ "${AITI_DEV:-0}" = "1" ]; then
    as_aiti bash -lc "cd /opt/aiti/app && npx next dev -H 0.0.0.0 -p ${AITI_PIWEB_PORT:-30142}" &
    CHILD_PIDS+=("$!")
    echo "[entrypoint] piweb :${AITI_PIWEB_PORT:-30142} dev=${AITI_DEV:-0}"
  elif [ -f /opt/aiti/app/.next/standalone/server.js ]; then
    # standalone：自含最小依赖树；PORT/HOSTNAME 由 server.js 自读
    as_aiti env PORT="${AITI_PIWEB_PORT:-30142}" HOSTNAME=0.0.0.0 \
      node /opt/aiti/app/.next/standalone/server.js &
    CHILD_PIDS+=("$!")
    echo "[entrypoint] piweb :${AITI_PIWEB_PORT:-30142} standalone"
  else
    as_aiti bash -lc "cd /opt/aiti/app && npx next start -H 0.0.0.0 -p ${AITI_PIWEB_PORT:-30142}" &
    CHILD_PIDS+=("$!")
    echo "[entrypoint] piweb :${AITI_PIWEB_PORT:-30142}"
  fi
}

# ── full 追加（AITI_PHASES 裁剪；GUI/CDP/VNC 端口默认回环，对外经隧道+TOTP 编排，R5）──
start_gui() {
  [ "$MODE" = "full" ] || { echo "[entrypoint] gui: 非 full 镜像，跳过"; return 0; }
  as_aiti /usr/local/bin/aiti-gui-start &
  CHILD_PIDS+=("$!")
  echo "[entrypoint] gui (xvfb+openbox+x11vnc+noVNC+cdp)"
}

start_asr() {
  # aiti-ai-input ASR 单服务（流式+离线合一，默认 8767）；venv=uv 托管 CPython 3.12
  [ "$MODE" = "full" ] || return 0
  as_aiti env ASR_STREAM_PORT=8767 /opt/aiti-asr/.venv/bin/python /opt/aiti-asr/app/voice-asr-stream.py &
  CHILD_PIDS+=("$!")
  echo "[entrypoint] asr :8767"
}

start_term() {
  [ "$MODE" = "full" ] || return 0
  as_aiti ttyd --port 7681 --writable bash &
  CHILD_PIDS+=("$!")
  echo "[entrypoint] ttyd :7681"
}

# ── 拉起 + 信号转发 ───────────────────────────────────────────────────────────
# trap 直接 kill 记录到的子 pid：docker --init（tini 为 PID1）时 entrypoint 不是进程组
# 组长，`kill -- -$$` 的组号不成立（首版实证收不到 TERM）——按 pid 逐个转发才可靠。
CHILD_PIDS=()
want bridge && start_bridge
want piweb  && start_piweb
want gui    && start_gui
want asr    && start_asr
want term   && start_term

on_term() {
  kill -TERM ${CHILD_PIDS[@]+"${CHILD_PIDS[@]}"} 2>/dev/null || true
}
trap on_term TERM INT
wait
