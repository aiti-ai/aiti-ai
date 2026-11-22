#!/usr/bin/env python3
"""
GLM-ASR **完整** ASR 服务（监听 8767，自管全套）

按你的架构：GLM 自己监听 8767、自己加载、自己处理——没有"8767 父进程"。
- /health          （含模型状态/热词统计）
- /ws/vad          （fsmn-vad 分段 + SenseVoice 快速 + GLM 精修——完整协议）
- /voice/transcribe（离线转写）
- /voice/quick     （SenseVoice 快识）
- /hotwords        （热词表）

依赖：glm-venv（transformers 5.x + torch TheRock + fastapi/uvicorn/websockets + librosa + funasr(VAD/SenseVoice)）
启动器（asr-start）：检查 config.offline_model 是否 GLM → 是则 spawn 本进程（监听 8767）→ 闪一边。

⚠ 配置/热词/SenseVoice/VAD/文本音频工具/WS /ws/vad 会话骨架已上移共享层 server/asr_common.py
  （与 voice-asr-stream.py 共用，协议唯一实现）——本文件只保留 GLM 引擎差异：
  GLM 加载（transformers 5.x）+ 官方热词句式精修 + 端点装配。
  历史 bug 备案：复制版骨架曾有 `time.time() - 0 > MAX_SECONDS`（恒真 → 首个 PCM 帧即断）、
  缺尾段兜底/等待在途识别/空段剔除——均随共享层骨架一并修复。
"""
import asyncio
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse

# ---- ASR 共享层（server/asr_common.py） ----
# 本脚本由启动器直接 `python glm_asr_service.py` 运行（sys.path[0] = server/glm/），手动补 server 根。
_SERVER_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVER_ROOT not in sys.path:
    sys.path.insert(0, _SERVER_ROOT)
from asr_common import (  # noqa: E402
    HotwordStore, ModelHolder,
    arr_to_wav_tmp, is_noise_text, strip_sense_tags,
    load_asr_config, make_dynamic_vad, run_vad_ws_session,
)

app = FastAPI(title="aiti-ai-input ASR (GLM)")

# ---- 配置（同 voice-asr-stream.py 语义：ASR_CONFIG_PATH > env > 默认） ----
# ⚠ load_asr_config 会把 config.env 灌入 os.environ——必须先于任何 import torch/funasr
_CONFIG_PATH = os.getenv("ASR_CONFIG_PATH") or os.path.join(_SERVER_ROOT, "asr-config.json")
_cfg = load_asr_config(_CONFIG_PATH)

OFFLINE_MODEL_ID = str(_cfg.get("offline_model") or "zai-org/GLM-ASR-Nano-2512")
STREAM_MODEL_ID = str(_cfg.get("stream_model") or "paraformer-zh-streaming")
_DEVICE = os.getenv("AITI_ASR_DEVICE", "cuda:0")
MAX_SECONDS = int(_cfg.get("max_seconds") or os.getenv("ASR_MAX_SECONDS", "60"))
MODEL_HOTWORDS_MAX = int(_cfg.get("model_hotwords_max") or os.getenv("ASR_MODEL_HOTWORDS_MAX", "8"))

SENSE_MODEL_ID = "iic/SenseVoiceSmall"
_hotwords = HotwordStore()

# smoke 开关：AITI_ASR_STUB_ENGINE=1 → 识别引擎换桩（不加载任何模型，仅验 WS 协议/分段链路；VAD 仍为真）
_STUB = os.getenv("AITI_ASR_STUB_ENGINE") == "1"

# ---- GLM 模型加载（transformers 5.x；进程内直接加载——GLM server 就是 GLM 进程） ----
_model = None          # (model, processor)
_glm_lock = threading.Lock()   # GLM 推理串行（骨架段间已顺序；防多会话并发挤爆显存）

def _load_glm():
    global _model
    if _model is not None:
        return
    print("[glm-srv] 加载 GLM 模型…", flush=True)
    import torch
    from transformers import AutoConfig, AutoProcessor, GlmAsrForConditionalGeneration
    dev = "cuda" if _DEVICE.startswith("cuda") and torch.cuda.is_available() else "cpu"
    proc = AutoProcessor.from_pretrained(OFFLINE_MODEL_ID, trust_remote_code=True)
    cfg = AutoConfig.from_pretrained(OFFLINE_MODEL_ID, trust_remote_code=True)
    model = GlmAsrForConditionalGeneration.from_pretrained(
        OFFLINE_MODEL_ID, config=cfg, torch_dtype=torch.bfloat16, trust_remote_code=True).to(dev)
    model.eval()
    _model = (model, proc)
    print(f"[glm-srv] GLM 就绪 device={dev}", flush=True)

def _glm_transcribe_wav(tmp: str, hotwords: str) -> str:
    """GLM 转写（官方热词句式：术语前缀 → 「这段音频可能包含以下词语：…。请转录这段音频」）。"""
    if _model is None:
        _load_glm()
    model, proc = _model
    context = hotwords or ""
    if context.startswith("术语有："):
        terms = context[len("术语有："):].rstrip("。")
        text = f"这段音频可能包含以下词语：{terms}。请转录这段音频"
    else:
        text = context if context else "Please transcribe this audio into text"
    import torch
    messages = [{"role": "user", "content": [
        {"type": "audio", "url": tmp},
        {"type": "text", "text": text},
    ]}]
    inputs = proc.apply_chat_template(
        messages, tokenize=True, add_generation_prompt=True,
        return_dict=True, return_tensors="pt",
        # ⚠ 音频解码后端必须钉 librosa：TheRock torch 与 torchcodec 的 .so 不兼容
        # （load_audio auto 后端探测 is_torchcodec_available() 误判可用 → import 即炸）。
        # 正确传法是 processor_kwargs 顶层 load_audio_backend（transformers processing_utils），
        # 嵌在 audio_kwargs 里的 backend 不会透传到 load_audio（曾踩坑：GLM 精修静默失败兑底 quick）。
        processor_kwargs={"load_audio_backend": "librosa"},
    )
    dev = next(model.parameters()).device
    inputs = {k: (v.to(dev, dtype=torch.bfloat16) if hasattr(v, "to") and v.is_floating_point() else (v.to(dev) if hasattr(v, "to") else v)) for k, v in inputs.items()}
    with torch.inference_mode():
        gen = model.generate(**inputs, max_new_tokens=256, do_sample=False)
    out_ids = gen[0, inputs["input_ids"].shape[1]:]
    return proc.tokenizer.decode(out_ids, skip_special_tokens=True).strip()

# ---- 段识别引擎（注入 /ws/vad 骨架）：quick = SenseVoice，refined = GLM 精修 ----
def _load_sense_model():
    from funasr import AutoModel
    return AutoModel(model=SENSE_MODEL_ID, device=_DEVICE, disable_update=True, trust_remote_code=True, hub="ms")

_sense = ModelHolder("sensevoice", _load_sense_model)
_sense_lock = threading.Lock()   # SenseVoice 推理串行

def _load_vad_model():
    print("[glm-srv] 加载 fsmn-vad…", flush=True)
    from funasr import AutoModel
    return AutoModel(model="fsmn-vad", device=_DEVICE, disable_update=True, hub="ms")

_vad = ModelHolder("fsmn-vad", _load_vad_model)

def _seg_quick(seg: np.ndarray, hw: str) -> str:
    """SenseVoice 快识（funasr 直接吃 numpy 数组，免临时文件；噪声过滤）。"""
    try:
        sense = _sense.get(30.0)
        if sense is None:
            return ""
        with _sense_lock:
            r = sense.generate(input=seg, language="auto")
        text = strip_sense_tags("".join(str(s.get("text", "")) for s in (r or []) if isinstance(s, dict))).strip()
        return "" if is_noise_text(text) else text
    except Exception as e:
        print(f"[glm-srv] seg_quick fail: {e}", flush=True)
        return ""

def _seg_refined(seg: np.ndarray, hw: str, quick: str) -> str:
    """GLM 精修（官方热词句式）；失败/噪声 → quick 兜底。"""
    tmp = ""
    try:
        tmp = arr_to_wav_tmp(seg)
        with _glm_lock:
            refined = _glm_transcribe_wav(tmp, hw)
        if is_noise_text(refined):
            print(f"[glm-srv] seg_refined 原始={refined[:60]!r} → 噪声丢弃", flush=True)
            refined = ""
        else:
            print(f"[glm-srv] seg_refined 原始={refined[:60]!r}", flush=True)
        return refined or quick or ""
    except Exception as e:
        print(f"[glm-srv] seg_refined fail: {e}", flush=True)
        return quick or ""
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass

def _stub_quick(seg: np.ndarray, hw: str) -> str:
    return "测试语音识别文本"

def _stub_refined(seg: np.ndarray, hw: str, quick: str) -> str:
    return "精修|" + (quick or "")

# ---- 端点 ----
_STARTED_AT = time.time()  # 进程启动时刻（health.uptime：扩展端自愈判定用，外部拉起也计时准确）
@app.get("/health")
async def health():
    hw_total, hw_ws = _hotwords.stats()
    return {
        "ok": True,
        "stream_model": STREAM_MODEL_ID,
        "offline_model": OFFLINE_MODEL_ID,
        "quick_model": SENSE_MODEL_ID,
        "stream_loaded": _vad.model is not None,
        "quick_loaded": _sense.model is not None,
        "offline_loaded": _model is not None,   # GLM 加载完成 = 就绪（协议诚实）
        "uptime": round(time.time() - _STARTED_AT, 1),
        "hotwords": hw_total,
        "hotwordWorkspaces": hw_ws,
    }

@app.post("/hotwords")
async def set_hotwords(payload: dict):
    raw = payload.get("hotwords") or []
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="hotwords 必须是字符串数组")
    words = [str(w).strip() for w in raw if str(w).strip()]
    ws = str(payload.get("ws") or "__default__")
    n = _hotwords.set(ws, words)   # 去重保序 + 上限（asr_common.HotwordStore.set）
    return {"ok": True, "ws": ws, "hotwords": n}

@app.get("/hotwords")
async def get_hotwords(ws: str | None = None):
    w = _hotwords.get(ws)
    return {"ok": True, "ws": ws or "__default__", "count": len(w), "words": w}

# ---- WS /ws/vad（分段 + 快识 + GLM 精修——骨架唯一实现在 asr_common.run_vad_ws_session） ----
@app.websocket("/ws/vad")
async def ws_vad(ws: WebSocket):
    """协议与 voice-asr-stream.py /ws/vad 完全一致；本服务注入 quick=SenseVoice / refined=GLM。"""
    quick_fn, refined_fn = (_stub_quick, _stub_refined) if _STUB else (_seg_quick, _seg_refined)
    await run_vad_ws_session(
        ws,
        quick_fn=quick_fn,
        refined_fn=refined_fn,
        load_vad=_vad.load_blocking,
        hotwords=_hotwords,
        model_hotwords_max=MODEL_HOTWORDS_MAX,
        max_seconds=MAX_SECONDS,
        save_recordings_config_path=_CONFIG_PATH,
        log="glm-srv",
    )

def _decode_container_f32(data: bytes, target_sr: int = 16000) -> np.ndarray:
    """webm/opus/mp4 容器字节 → 16k mono float32。三级策略（均非硬依赖）：
    ① av 包（pip wheel 自带 FFmpeg 解码库——无外部二进制，BytesIO 直读）
    ② 系统 ffmpeg（检测到 PATH 才用）
    ③ 都无 → HTTPException 引导安装（主链 /ws/vad 走 PCM，不触发此处）
    """
    import io
    try:
        import av
    except ImportError:
        av = None
    if av is not None:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=target_sr)
        out = []
        with av.open(io.BytesIO(data)) as container:
            for packet in container.demux(audio=0):
                for frame in packet.decode():
                    for rf in resampler.resample(frame):
                        out.append(rf.to_ndarray().reshape(-1))
        if not out:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(out).astype(np.float32) / 32768.0
    # 降级：系统 ffmpeg（检测到才用）
    import shutil
    import subprocess
    import tempfile
    if shutil.which("ffmpeg") is None:
        raise HTTPException(
            status_code=400,
            detail="容器音频解码不可用：glm-venv 未装 av 包（pip install av）且系统无 ffmpeg。主链 /ws/vad 不受影响",
        )
    fd, wav_tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        r = subprocess.run(["ffmpeg", "-y", "-i", "pipe:0", "-ac", "1", "-ar", str(target_sr), wav_tmp],
                           input=data, capture_output=True, timeout=60)
        if r.returncode != 0:
            raise HTTPException(status_code=400, detail=f"ffmpeg 解码失败: {r.stderr[-200:]!r}")
        import wave as _w
        with _w.open(wav_tmp, "rb") as w:
            assert w.getframerate() == target_sr and w.getnchannels() == 1
            return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    finally:
        if os.path.exists(wav_tmp):
            try:
                os.unlink(wav_tmp)
            except OSError:
                pass

@app.post("/voice/transcribe")
async def transcribe(audio: UploadFile = File(...), request: Request = None):
    """离线转写（2-pass；GLM + 官方热词句式）。

    webm/opus/mp4 等容器格式（浏览器 MediaRecorder 兑底链上传）：librosa/soundfile 读不了，
    torchcodec 又与 TheRock 不兼容 → 解码三级策略（均非硬依赖，见 _decode_container_f32）。
    """
    data = await audio.read()
    suffix = Path(audio.filename or ".wav").suffix or ".wav"
    import tempfile
    fd, tmp = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    owned = [tmp]   # finally 清理（tmp 可能被替换为解码后的 wav 路径）
    try:
        if suffix.lower() in (".webm", ".opus", ".mp4", ".m4a", ".ogg"):
            arr = await asyncio.get_running_loop().run_in_executor(None, _decode_container_f32, data)
            if arr.size < 1600:
                raise HTTPException(status_code=400, detail="容器音频解码后为空/过短")
            tmp2 = arr_to_wav_tmp(arr)   # 解码结果 → 16k mono wav（/dev/shm）
            owned.append(tmp2)
            tmp = tmp2
        ws_key = (request.headers.get("x-aiti-ws") if request else "") or ""
        hw = _hotwords.prompt(ws_key, MODEL_HOTWORDS_MAX)
        text = await asyncio.get_running_loop().run_in_executor(None, _glm_transcribe_wav, tmp, hw)
        return {"ok": True, "text": text, "language": "auto", "pass": 2, "model": OFFLINE_MODEL_ID, "ms": 0}
    finally:
        for p in owned:
            if p and os.path.exists(p):
                try:
                    os.unlink(p)
                except OSError:
                    pass

@app.post("/voice/quick")
async def quick(audio: UploadFile = File(...)):
    """SenseVoice 快识（速度优先，不查热词）。"""
    import tempfile
    data = await audio.read()
    suffix = Path(audio.filename or ".wav").suffix or ".wav"
    fd, tmp = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    try:
        def _run():
            sense = _sense.get(120.0)
            if sense is None:
                return None
            with _sense_lock:
                r = sense.generate(input=[tmp], language="auto")
            return strip_sense_tags("".join(str(s.get("text", "")) for s in (r or []) if isinstance(s, dict))).strip()
        text = await asyncio.get_running_loop().run_in_executor(None, _run)
        if text is None:
            raise HTTPException(status_code=503, detail="SenseVoice 加载超时（首次需下载模型，请稍后重试）")
        return JSONResponse({"ok": True, "text": text, "quick": True, "model": SENSE_MODEL_ID})
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

@app.on_event("startup")
async def _startup():
    if _STUB:
        print("[glm-srv] STUB 引擎模式（AITI_ASR_STUB_ENGINE=1）：跳过模型预热", flush=True)
        return
    def _warm():
        try:
            _load_glm()
        except Exception as e:
            print(f"[glm-srv] GLM 预加载失败: {e}", flush=True)
        try:
            _vad.load_blocking()
        except Exception as e:
            print(f"[glm-srv] VAD 预加载失败: {e}", flush=True)
        # ⚠ SenseVoice 也必须预热：曾只预 warm GLM/VAD，首次 quick 调用才懒加载（funasr 装载
        #   占住 GIL/CPU 十秒级）→ uvicorn 事件循环冻结 → WS 收不到帧/中间层缓冲撑爆断连
        #   （现象：浏览器「卡在服务端精修中」→ 1006，录到的段全部丢失）。
        try:
            _sense.load_blocking()
        except Exception as e:
            print(f"[glm-srv] SenseVoice 预加载失败: {e}", flush=True)
    threading.Thread(target=_warm, daemon=True).start()

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("AITI_ASR_GLM_PORT", "8767"))   # GLM 自己监听 8767
    uvicorn.run(app, host="127.0.0.1", port=port)
