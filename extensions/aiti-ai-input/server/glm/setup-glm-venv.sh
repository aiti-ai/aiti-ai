#!/usr/bin/env bash
# GLM-ASR 独立 venv 初始化（一键）
#   用法：bash setup-glm-venv.sh            # 创建/安装（幂等）
#   产物：<dataDir>/glm-venv（transformers 5.0 源码 + TheRock torch + torchaudio + librosa + accelerate）
#   注意：与 asr-venv 隔离——qwen_asr pin transformers==4.57.6，GLM 需 5.0+，二者不可同环境。
set -euo pipefail

VENV_DIR="${AITI_ASR_GLM_VENV:-$(dirname "$0")/../../../../../.pi/web/data/aiti-ai-input/glm-venv}"
# 上面相对路径不可靠——固定 dataDir
VENV_DIR="${AITI_ASR_GLM_VENV:-$HOME/.pi/web/data/aiti-ai-input/glm-venv}"
echo "[glm] venv: $VENV_DIR"

if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "[glm] 创建 venv…"
  python3 -m venv "$VENV_DIR"
fi

P="$VENV_DIR/bin/pip"
echo "[glm] 升级 pip…"
$P install --upgrade pip -q

echo "[glm] 安装 transformers 5.0+（源码版，GLM-ASR 必需）…"
$P install -q 'git+https://github.com/huggingface/transformers.git'
echo "[glm] 安装 torch（TheRock ROCm gfx110X）…"
$P install -q torch==2.11.0a0+rocm7.11.0a20260121 --index-url https://rocm.nightlies.amd.com/v2/gfx110X-all/ --pre
echo "[glm] 安装 torchaudio + librosa + soundfile + accelerate…"
$P install -q torchaudio==2.11.0a0+rocm7.11.0a20260121 --index-url https://rocm.nightlies.amd.com/v2/gfx110X-all/ --pre
$P install -q librosa soundfile accelerate
# 可选：av（pip wheel 自带 FFmpeg 解码库，无外部二进制）——/voice/transcribe 容器格式（webm 等）
# 兑底链解码用；网络不通装不上也不影响主链（服务端降级系统 ffmpeg 或报引导提示）
$P install -q av || echo "[glm] av 安装失败（可选依赖，不影响主链）"
# ⚠ 防御性卸载 torchcodec：transformers 安装可能把它作为依赖带回，但其 .so 与 TheRock torch 不兼容
#   （import 即炸 "Could not load libtorchcodec_image.so"），且 transformers load_audio auto 后端
#   探测 is_torchcodec_available() 误判可用 → 选 torchcodec → GLM 精修静默失败。音频解码统一 librosa。
$P uninstall -y -q torchcodec 2>/dev/null || true
echo "[glm] 校验…"
$VENV_DIR/bin/python -c 'import torch, transformers, librosa, accelerate, torchaudio; print("torch", torch.__version__, "| transformers", transformers.__version__, "| OK")'
echo "[glm] 完成 ✓（权重首次调用自动下载 ~5.5G 至 HF 缓存，或放 glm/checkpoint/）"
