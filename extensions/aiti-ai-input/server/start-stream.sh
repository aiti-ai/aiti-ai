#!/usr/bin/env bash
# =============================================================================
# aiti-ai-input · 流式 ASR 服务（8767）一键管理脚本（Linux / macOS 通用）
#
# 用法（默认 start）：
#   bash start-stream.sh          # 启动（幂等：已在运行则提示后退出 0）
#   bash start-stream.sh status   # 状态（运行/停止 + 最近日志尾部）
#   bash start-stream.sh stop     # 停止（按端口精确找 PID，绝不误杀）
#   bash start-stream.sh restart  # 重启
#
# 平台差异：仅端口检测——Linux 用 ss；macOS 无 ss，用 lsof -iTCP（kill/venv/uvicorn/tee 全兼容）。
#   Windows 对应物为 start-stream.ps1（任务树杀 + netstat/Get-NetTCPConnection）。
# 说明：服务按「同进退」模型运行——经 aiti-cmd 的 PTY 会话启动（node-pty 子进程），
#   pi-web 扩展进程停则会话消失；下次语音输入探测到端口不通会自动经 /asr/ensure 拉起。
#   不需要 systemd 托管，停掉就停掉，随用随起。
# 日志：所有输出同时进 PTY（⚡命令 面板可见）与 logs/stream.log（兜底排查）。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${ASR_STREAM_PORT:-8767}"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/stream.log"
CMD="${1:-start}"

mkdir -p "$LOG_DIR"

# 端口检测/取 PID：Linux=ss；macOS(Darwin)=lsof（无 ss）
is_up() {
  if [ "$(uname -s)" = "Darwin" ]; then
    lsof -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1
  else
    ss -tln 2>/dev/null | grep -qE "[:.]$PORT\s"
  fi
}

port_pids() {
  if [ "$(uname -s)" = "Darwin" ]; then
    lsof -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
  else
    # 精确取监听端口的 PID（ss -tlnp；本用户进程可见 pid=）
    ss -tlnp 2>/dev/null | grep "[:.]$PORT\s" | grep -oP 'pid=\K[0-9]+' | sort -u || true
  fi
}

status() {
  if is_up; then
    local pids
    pids="$(port_pids | tr '\n' ' ')"
    local _model_label="paraformer-zh-streaming + seaco"
    if grep -q 'GLM' "${ASR_CONFIG_PATH:-$SCRIPT_DIR/asr-config.json}" 2>/dev/null; then _model_label="GLM (offline ASR)"; fi
    echo "[asr] $PORT 运行中 (pid: ${pids:-?}) · 模型: $_model_label"
    echo "[asr] 直接访问: http://127.0.0.1:$PORT/health（经 pi-web: /aiti-ai-input/asr/* 代理）"
  else
    echo "[asr] $PORT 未运行"
    if [ -f "$LOG_FILE" ]; then
      echo "[asr] ── 日志尾部（logs/stream.log）──"
      tail -n 5 "$LOG_FILE" || true
    fi
    echo "[asr] 启动: bash $SCRIPT_DIR/start-stream.sh   （或让语音输入探测后自动拉起）"
  fi
}

start() {
  if is_up; then
    echo "[asr] $PORT 已在运行，跳过启动（幂等）。"
    status
    exit 0
  fi
  echo "[asr] 启动前检查：venv / 依赖…"
  # ⚠ 自包含布局：venv 放 web/data（扩展 dataDir/asr-venv）——源码随扩展部署，运行时环境独立。
  #   优先级：AITI_ASR_VENV_DIR 环境变量 > <ASR_CONFIG_PATH 所在目录>/asr-venv > server/asr-venv（旧兼容）> .venv（兜底）
  VENV_DIR="${AITI_ASR_VENV_DIR:-}"
  if [ -z "$VENV_DIR" ] && [ -n "${ASR_CONFIG_PATH:-}" ]; then
    # ASR_CONFIG_PATH=<dataDir>/asr-config.json → venv 约定 <dataDir>/asr-venv
    VENV_DIR="$(dirname "$ASR_CONFIG_PATH")/asr-venv"
  fi
  if [ -z "$VENV_DIR" ] && [ -d asr-venv ]; then
    VENV_DIR="$SCRIPT_DIR/asr-venv"   # 旧布局兼容（server/asr-venv）
  fi
  if [ -n "$VENV_DIR" ] && [ -d "$VENV_DIR" ] && [ -x "$VENV_DIR/bin/python" ]; then
    echo "[asr] 使用 venv: $VENV_DIR"
    . "$VENV_DIR/bin/activate"
    # 不自动 pip install——venv 由部署锁定（TheRock torch/ROCm torchaudio），
    # 自动装会从 PyPI 拉 CPU/CUDA 版覆盖（踩过：torchaudio 被覆盖 → libcudart 缺库崩溃）
  else
    echo "[asr] 使用 .venv（无专用 venv，兜底）"
    if [ ! -d .venv ]; then
      echo "[asr] 创建虚拟环境 .venv（首次）"
      python3 -m venv .venv
    fi
    . .venv/bin/activate
    pip install -q -r requirements.txt || echo "[asr] 警告: .venv 依赖安装失败"
  fi
  export ASR_STREAM_PORT="${ASR_STREAM_PORT:-8767}"
  # 模型默认（配置文件不存在时兜底；asr-config.json 存在则优先——voice-asr-stream.py 读配置>env>默认）
  export ASR_STREAM_MODEL="${ASR_STREAM_MODEL:-paraformer-zh-streaming}"
  export ASR_OFFLINE_MODEL="${ASR_OFFLINE_MODEL:-Qwen/Qwen3-ASR-0.6B}"
  export ASR_MAX_SECONDS="${ASR_MAX_SECONDS:-60}"
  # 配置路径注入（dataDir 下 asr-config.json，由扩展启动命令传入；不写程序目录）
  export ASR_CONFIG_PATH="${ASR_CONFIG_PATH:-}"
  echo "[asr] 启动 uvicorn voice-asr-stream:app @127.0.0.1:$PORT（日志: $LOG_FILE）"
  echo "[asr] 停止本服务: bash $SCRIPT_DIR/start-stream.sh stop"
  # 全部输出同步进 PTY + 日志文件；uvicorn 前台运行，退出码原样传递
  exec > >(tee -a "$LOG_FILE") 2>&1
  # ⚠ 用 venv 的 uvicorn 绝对路径（不依赖 activate/PATH 顺序——曾踩坑：激活后 PATH 被系统 ~/.local/bin 抢先）
  UVICORN_BIN="$(command -v uvicorn 2>/dev/null || true)"
  if [ -n "${VENV_DIR:-}" ] && [ -x "$VENV_DIR/bin/uvicorn" ]; then
    UVICORN_BIN="$VENV_DIR/bin/uvicorn"
  fi
  # GLM 分流：config.offline_model 含 GLM → GLM 服务自己监听 8767（完整协议），启动器只拉起+等就绪
  if grep -q 'GLM' "${ASR_CONFIG_PATH:-$SCRIPT_DIR/asr-config.json}" 2>/dev/null; then
    GLM_VENV="${AITI_ASR_GLM_VENV:-$(dirname "$ASR_CONFIG_PATH")/glm-venv}"
    GLM_PY="$GLM_VENV/bin/python"
    if [ -x "$GLM_PY" ]; then
      echo "[asr] GLM 模式：拉起 GLM 服务（glm_asr_service.py 监听 8767）并等待就绪…"
      exec "$GLM_PY" "$SCRIPT_DIR/glm/glm_asr_service.py"
    else
      echo "[asr] 警告: GLM venv 缺失（$GLM_VENV）——跑 glm/setup-glm-venv.sh；回退 uvicorn"
      exec "$UVICORN_BIN" voice-asr-stream:app --host 127.0.0.1 --port "$PORT"
    fi
  fi
  exec "$UVICORN_BIN" voice-asr-stream:app --host 127.0.0.1 --port "$PORT"
}

stop() {
  if ! is_up; then
    echo "[asr] $PORT 未运行，无需停止。"
    exit 0
  fi
  local pids
  pids="$(port_pids)"
  if [ -z "$pids" ]; then
    echo "[asr] 未取到监听 PID（可能权限不足），跳过。" >&2
    exit 1
  fi
  echo "[asr] 停止 $PORT → kill TERM: $pids"
  for pid in $pids; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  # 最多等 10s，未退则 KILL（按端口防自杀：只动上面取到的精确 pid）
  local waited=0
  while is_up && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if is_up; then
    echo "[asr] 未在 10s 内退出，KILL…"
    for pid in $pids; do
      kill -KILL "$pid" 2>/dev/null || true
    done
  fi
  echo "[asr] 已停止（pid: $pids）"
}

case "$CMD" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  restart) stop; start ;;
  *)
    echo "用法: bash $0 [start|status|stop|restart]（默认 start）" >&2
    exit 2
    ;;
esac
