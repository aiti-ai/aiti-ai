#!/usr/bin/env bash
# 40-asr-setup.sh —— ASR venv + 默认引擎模型预下载（aiti-docker-image-plan §2.2.2）
# 体积大头（~2GB）：构建期固化进镜像，避免用户首转卡住；modelscope 国内直连。
set -euo pipefail
VENV=/opt/aiti-asr/.venv
# ⚠ 首跑校准（2026-09-09）：ubuntu 26.04 系统python=3.14，numpy1.26/torch 生态无 cp314
# 轮子（源码编译缺 ABI）——用 uv 托管独立 CPython 3.12 建 venv（自包含，不依赖 apt 源）。
pip3 install --break-system-packages --quiet uv
# uv 默认把托管 Python 装进 /root（venv 符号链接后 aiti 无法穿越→Permission denied）——
# 挪到 /opt/aiti-asr/python 并放开读权限（首跑冒烟实证）
export UV_PYTHON_INSTALL_DIR=/opt/aiti-asr/python
uv venv --python 3.12 "$VENV"

# 依赖对齐 server/requirements.txt：fastapi 服务面 + funasr 体系 + pypinyin（热词拼音模糊匹配）
# torch 先从 CPU 官方源装（pypi linux 轮捆绑 CUDA 全家桶 ~5GB，容器无 GPU 用不上）
# （2026-09-09 对齐：撤 faster-whisper——服务端已不用；whisper 离线引擎是 openai-whisper
#   包的可选 family，requirements.txt 不含，镜像不预装。）
uv pip install --python "$VENV/bin/python" \
  --index-url "${TORCH_CPU_INDEX:-https://download.pytorch.org/whl/cpu}" \
  torch torchaudio
uv pip install --python "$VENV/bin/python" \
  --index-url "${PIP_MIRROR:-https://pypi.org/simple}" \
  fastapi "uvicorn[standard]" python-multipart websockets \
  funasr modelscope pypinyin

# 模型预下载：与 voice-asr-stream.py 内置默认引擎同源（TODO 回填已完成 2026-09-09）——
#   流式 paraformer-zh-streaming / 2-pass seaco paraformer / quick SenseVoiceSmall / VAD fsmn-vad，
#   全部 funasr AutoModel hub="ms"（modelscope 国内直连）。同调用同参数 = 同别名解析，运行时零重下。
# 缓存位置 MODELSCOPE_CACHE=/opt/aiti-asr/models：镜像层固化且不受 /home/aiti/.cache 可选卷遮蔽；
# Dockerfile.full 同名 ENV 让运行时读同一目录（按 asr-config.json 换模型时增量下载也落这里）。
export MODELSCOPE_CACHE=/opt/aiti-asr/models
mkdir -p "$MODELSCOPE_CACHE"
"$VENV/bin/python" - <<'EOF'
from funasr import AutoModel

for model_id in (
    "paraformer-zh-streaming",                                    # STREAM_MODEL_ID 默认（WS 实时出字）
    "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",  # OFFLINE_MODEL_ID 默认（2-pass 精修）
    "iic/SenseVoiceSmall",                                        # SENSE_MODEL_ID（quick 快速识别）
    "fsmn-vad",                                                   # VAD（动态流式 VAD）
):
    print(f"[40-asr] pre-download {model_id} ...", flush=True)
    AutoModel(model=model_id, device="cpu", disable_update=True, hub="ms")
print("[40-asr] funasr default models cached")
EOF
echo "[40-asr] venv + models -> $VENV / $MODELSCOPE_CACHE"
# aiti 可读（运行时加载）可写（运行时增量下载新模型落同目录）
chown -R aiti:aiti "$MODELSCOPE_CACHE" 2>/dev/null || true
chmod -R a+rX /opt/aiti-asr 2>/dev/null || true
