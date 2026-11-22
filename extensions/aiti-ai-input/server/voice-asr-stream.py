"""
L2 ASR 服务（aiti-ai-input 语音输入）—— 实时流式识别 + 离线二次识别（2-pass）。

设计依据：FunASR 流式 Paraformer 分块(chunk)+缓存(cache)解码，600ms 级低延迟「边说边出字」
（https://www.funasr.com/blog/funasr-realtime-streaming-asr.html）。

- WS   /ws/stream          实时流式识别（第一遍，实时出候选词；paraformer-zh-streaming）
- POST /voice/transcribe   离线二次识别（第二遍，Qwen3-ASR/Fun-ASR-Nano/seaco 精修最终文本，配置可选）
- GET  /health             健康检查

模型/限额从配置文件读（ASR_CONFIG_PATH → ext dataDir/asr-config.json；配置 > env > 默认），
不在命令行/环境变量暴露模型。

WS 协议（二进制 = 16kHz 单声道 PCM int16 小端；文本 = JSON 控制）：
  客户端 → 服务端：
    binary 帧：音频块（任意大小，模型内部 carry-over，无需对齐 600ms）
    文本 {"type":"stop"}  句末，触发 is_final 收尾解码，返回 final 并复位 cache
    文本 {"type":"reset"} 丢弃当前句（重置 cache 与累计文本，不返回）
  服务端 → 客户端（文本）：
    {"type":"ready","chunkMs":600}           模型就绪
    {"type":"partial","text":"累计到当前的全部候选"}  每个 600ms chunk 出一次
    {"type":"final","text":"最终全句"}         stop 后收尾
    {"type":"error","message":"..."}
"""
from __future__ import annotations  # PEP 604 注解（threading.Lock | None）在 py<3.14 需惰性求值

import asyncio
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

# ---- ASR 共享层（配置/热词/SenseVoice·VAD 加载器/工具/WS /ws/vad 会话骨架） ----
# 实现在同目录 asr_common.py——与 glm/glm_asr_service.py 共享（协议/分段唯一实现）。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # 兜底：非 server/ cwd 启动也能 import
from asr_common import (  # noqa: E402
    DEFAULT_WS, HotwordStore, ModelHolder,
    arr_to_wav_tmp, decode_pcm, is_noise_text, join_cjk_spaces,
    load_asr_config, make_dynamic_vad, run_vad_ws_session, save_raw_wav, strip_sense_tags,
)

app = FastAPI(title="aiti-ai-input ASR (streaming + offline)")

# ---- 配置文件优先（安全：模型不在命令行/环境变量，避免进程列表泄漏） ----
# 配置文件路径由扩展启动时注入（ASR_CONFIG_PATH → 扩展 dataDir，如 ~/.pi/web/data/aiti-ai-input/asr-config.json），
# 不写在程序目录 —— 配置随用户数据走，代码目录无状态。
# 结构：{ stream_model, offline_model, max_seconds, model_hotwords_max }
# 优先级：配置文件 > 环境变量 > 内置默认。扩展写此文件（模型 feature 变化时），服务启动读取。
_CONFIG_PATH = os.getenv("ASR_CONFIG_PATH") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "asr-config.json")

# ---- config.env → os.environ（全部加载；config 显式写出的 env 优先生效，无则不覆盖） ----
# ⚠ 必须在任何 import torch / funasr 之前（HSA/HIP 初始化读环境变量）——asr_common.load_asr_config
_cfg = load_asr_config(_CONFIG_PATH)

STREAM_MODEL_ID = str(_cfg.get("stream_model") or os.getenv("ASR_STREAM_MODEL", "paraformer-zh-streaming"))
OFFLINE_MODEL_ID = str(_cfg.get("offline_model") or os.getenv("ASR_OFFLINE_MODEL", "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"))
# 推理设备/精度：config.env > 进程 env > 默认为空（CPU 回退由各调用处自处理）
_DEVICE = os.getenv("AITI_ASR_DEVICE", "cpu")
_DTYPE = os.getenv("AITI_ASR_COMPUTE_DTYPE")
# 2-pass 离线模型是否 Qwen3-ASR（LLM 系）：是 → 用 context= 模型级热词 + 原生标点/大小写/语种；
# 否（seaco/contextual paraformer）→ 用 hotword= 偏置。Qwen3 context 覆盖 52 语种+22 中文方言，
# 术语纠偏（React Hook/WebSocket/npm 大小写）显著优于 seaco（实测）。
OFFLINE_IS_QWEN3 = "Qwen3-ASR" in OFFLINE_MODEL_ID or OFFLINE_MODEL_ID.lower().startswith("qwen")
# 2-pass 模型是否为 GLM-ASR（transformers 原生，非 qwen_asr/funasr 体系
OFFLINE_IS_GLM = "GLM-ASR" in OFFLINE_MODEL_ID or OFFLINE_MODEL_ID.lower().startswith("glm")
# 2-pass 为 Whisper（openai-whisper torch 版，AMD GPU 可跑；99 语言兜底，无热词）
OFFLINE_IS_WHISPER = "whisper" in OFFLINE_MODEL_ID.lower()
# 「直出」模式：实时引擎与 2-pass 用同一模型（如 stream=offline=Qwen3-0.6B）
# → quick 直接用 offline 实例（带 context，一次识别即候选=精修），跳过 SenseVoice 与二次 refine。
#   规则：仅当 stream_model == offline_model 且为 Qwen3 系（context 热词收益最大）。
QUICK_USE_OFFLINE = (STREAM_MODEL_ID == OFFLINE_MODEL_ID) and OFFLINE_IS_QWEN3
# 2-pass 为 parakeet（NVIDIA NeMo 系；25 欧语/英文极准，中文不行）
OFFLINE_IS_PARAKEET = "parakeet" in OFFLINE_MODEL_ID.lower()
# 2-pass 模型级热词：seaco（contextual paraformer，官方 hotword 方案）；SenseVoiceSmall 无模型级支持。
# 配套：ASR_MODEL_HOTWORDS_MAX（热词上限，官方每词 decode 时 embed，过多稀释效果/变慢）
CHUNK_SIZE = [0, 10, 5]       # [左看, 中心, 右看] 单位 60ms；中心 10 → 600ms（延迟/精度平衡点）
ENCODER_LOOK_BACK = 4
DECODER_LOOK_BACK = 1
MAX_SECONDS = int(_cfg.get("max_seconds") or os.getenv("ASR_MAX_SECONDS", "60"))
ALLOWED_EXTENSIONS = {".webm", ".opus", ".wav", ".mp3", ".m4a", ".ogg", ".pcm"}

# ---- 全局模型实例（懒加载 + 后台预热 + 锁串行化 CPU 推理） ----
_stream_model = None
_stream_ready = threading.Event()
_offline_model = None
_offline_ready = threading.Event()
_model_lock = threading.Lock()   # CPU 推理全局串行（同一时刻一个模型调用，避免线程竞争缓存/显存抖动）

# ---- GPU 看门狗（进程内自愈：检测到 HIP/GPU 异常 → 连续超限 → 主动退出，由上层拉起复位） ----
# 原理：GPU 崩（HIP error / module unload fail / hang）时进程仍活着（health 200），
#       只有推理会炸。每轮推理前跑轻量探针（小 matmul），失败及捕获到的 HIP 异常累计；
#       连续 GPU 异常 >=3 次 → os._exit(70)（自愿死亡 → systemd/PTY 会话自动拉起新进程，GPU 复位）。
# 探针本身在 GPU 崩时也可能 hang——加超时保护（python 线程无法强杀，用信号/轮询：这里用 try 快速探测，
#      若 hang 则后续推理自然超时，依赖上层 /asr/ensure 自愈兜底）。
_GPU_FAULT_COUNT = [0]   # 连续 GPU 异常计数
_GPU_FAULT_LIMIT = 5     # 重载无效的累计上限（重载不计数——只在重载后仍失败时递增）
_GPU_READY_FLAG = [True]
_GPU_RELOADED = [0]      # 已尝试"进程内重载"次数（上限 2 次，超过才自杀）

def _gpu_probe() -> bool:
    """轻量 GPU 健康探针：cuda 小 matmul；异常/hang → False。"""
    try:
        if not _GPU_READY_FLAG[0]:
            return False
        import torch
        if not torch.cuda.is_available():
            return False
        a = torch.randn(64, 64, device="cuda")
        b = torch.randn(64, 64, device="cuda")
        _ = (a @ b)
        torch.cuda.synchronize()
        return True
    except Exception:
        return False

def _gpu_fault(msg: str = "") -> bool:
    """GPU 异常处理——分层自愈（先不自杀）：
       ① 累计异常（含重载后） 
       ② 达到阈值且未重载过 → 进程内重载（释放显存 + 清模型句柄 → 下次懒加载新 context）
       ③ 重载过仍异常 → 才自杀（上层拉起，彻底复位）
    """
    _GPU_FAULT_COUNT[0] += 1
    try: print(f"[ASR] GPU 异常 #{_GPU_FAULT_COUNT[0]}: {msg}", flush=True)
    except Exception: pass
    # 重载后仍失败才累计到自杀阈值
    if _GPU_RELOADED[0] > 0 and _GPU_FAULT_COUNT[0] >= _GPU_FAULT_LIMIT:
        try: print(f"[ASR] GPU 重载 {_GPU_RELOADED[0]} 次后仍异常 {_GPU_FAULT_COUNT[0]} 次 → 主动退出（上层拉起）", flush=True)
        except Exception: pass
        import os
        os._exit(70)
    return False

def _gpu_reinit(msg: str = "") -> bool:
    """进程内 GPU 重新初始化（不自杀）：
       释放模型句柄 + 清显存 + 清计数 → 下次推理走懒加载重建（HIP 新 context）。
       ⚠ 注意：模型句柄置空后，正在跑推理的线程可能拿到旧引用——由 _model_lock 串行保证安全。
    """
    try: print(f"[ASR] GPU 进程内重载…（{msg}）", flush=True)
    except Exception: pass
    global _offline_model, _stream_model
    _offline_model = None
    _stream_model = None
    for _ev in (_offline_ready, _stream_ready):
        try: _ev.clear()
        except Exception: pass
    _sense.invalidate()   # SenseVoice（funasr）→ 置空懒加载（asr_common.ModelHolder）
    _vad.invalidate()     # fsmn-vad（funasr）→ 同上
    try:
        import torch
        torch.cuda.empty_cache()
    except Exception: pass
    _GPU_RELOADED[0] += 1
    _GPU_FAULT_COUNT[0] = 0      # 重载后从零计（重载本身算治疗，不算失败）
    return True

def _gpu_probe_or_fault() -> bool:
    """推理前调用：探针失败 → 先进程内重载（≤2 次），仍失败再累计（超限自杀）。"""
    ok = _gpu_probe()
    if ok:
        _GPU_FAULT_COUNT[0] = 0
        return True
    if _GPU_RELOADED[0] < 2:
        _gpu_reinit("probe failed")
        return False   # 本次返回失败（调用方返回空），下次推理已凭新模型恢复
    _gpu_fault("probe failed (重载后仍 HIP/GPU 不可用)")
    return False

# ---- 热词（模型级：Qwen3 context / Fun-ASR-Nano·seaco hotword；/hotwords 端点动态更新） ----
# ⚠ 不用 funasr 文本级 postprocess_hotwords（实测其 fuzzy 匹配把静音输出替换成 4 个
#   "extensions"、把 "extensin" 拆成 "aitiaiti"——pypinyin 对纯英文片段返回空串导致
#   ratio("","")=1.0 完美匹配 + 滑动窗口无词边界跨词误替换）。官方热词方案 = 模型级
#   hotword（contextual paraformer/seaco）或 context（Qwen3），解码偏置，不产生词外文本。
# 热词按 workspace 粒度存储（多 workspace 并行不冲突）：ws key = cwd/关注路径的 sha1 12 位哈希（不透明，不见路径）；
#  "__default__" 为不带 ws 的兑底档。/hotwords {ws, hotwords} 更新；/voice/transcribe 经 x-aiti-ws header 取用。
# 热词表（workspace 粒度存储 + 「术语有：…」prompt 组装 + ws_key_of sha1 12 位）——实现在 asr_common.HotwordStore
_hotwords = HotwordStore()
# 模型级偏置热词上限（⚠ 实测：40 个全量喂 0.6B 小模型 = 噪声（偏置稀释 + 可能把热词当输出）；
#   官方建议少量精挑。默认 8（用户词 3-4 最优先 + 高频自动词），config 可覆盖 model_hotwords_max）
MODEL_HOTWORDS_MAX = int(_cfg.get("model_hotwords_max") or os.getenv("ASR_MODEL_HOTWORDS_MAX", "8"))
# 上传上限（防护：60s×16kHz×2B ≈ 1.9MB 语音，放宽 10× + wav/webm 容器余量；也与配置文件 max_seconds 联动）
MAX_UPLOAD_BYTES = int(_cfg.get("max_upload_bytes") or os.getenv("ASR_MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)))

def _load_stream():
    global _stream_model
    if _stream_model is not None:
        _stream_ready.set()
        return _stream_model
    with _model_lock:
        if _stream_model is not None:
            _stream_ready.set()
            return _stream_model
        from funasr import AutoModel
        _stream_model = AutoModel(
            model=STREAM_MODEL_ID, device=_DEVICE, disable_update=True, hub="ms",
        )
        _stream_ready.set()
        return _stream_model


def _load_offline():
    global _offline_model
    if _offline_model is not None:
        _offline_ready.set()
        return _offline_model
    with _model_lock:
        if _offline_model is not None:
            _offline_ready.set()
            return _offline_model
        print(f"[ASR] _load_offline: 加载 offline（QWEN3={OFFLINE_IS_QWEN3} GLM={OFFLINE_IS_GLM} ...）", flush=True)
        if OFFLINE_IS_QWEN3:
            try:
                # Qwen3-ASR（LLM 系）：qwen_asr 库，CPU+bfloat16；加载较慢（~50s），后台预热尽早
                import torch
                from qwen_asr import Qwen3ASRModel
                _offline_model = Qwen3ASRModel.from_pretrained(
                    OFFLINE_MODEL_ID,
                    dtype=torch.bfloat16 if not _DTYPE else getattr(torch, _DTYPE, torch.bfloat16),
                    device_map="cuda:0" if not _DEVICE or _DEVICE.startswith("cuda") else _DEVICE,
                    max_new_tokens=256,
                )
            except Exception as e:
                # Qwen3 环境缺失/加载失败（如服务在 .venv 跑、qwen_asr 未安装）→ 降级 funasr，不崩
                try: print(f"[ASR] Qwen3 加载失败，降级 funasr: {e}", flush=True)
                except Exception: pass
                _offline_model = None
        # GLM-ASR 不走同进程（需独立 venv：transformers>=5.0 源码 —— 与 qwen_asr 的 4.57.6 pin 冲突）；
        # _run_segment_refined 里子进程调用（见 _run_segment_glm）。
        if _offline_model is None and OFFLINE_IS_WHISPER:
            try:
                # openai-whisper（torch 版，AMD ROCm GPU 可跑；无 context 热词）
                import whisper
                _offline_model = whisper.load_model(
                    OFFLINE_MODEL_ID.split("/")[-1].replace("whisper-", "").replace("large-v3", "large-v3"),
                )
            except Exception as e:
                try: print(f"[ASR] Whisper 加载失败: {e}", flush=True)
                except Exception: pass
                _offline_model = None
        if _offline_model is None and OFFLINE_IS_PARAKEET:
            try:
                # NVIDIA parakeet（NeMo 系）——需 nemo_toolkit[asr]；25 欧语/英文极准
                from nemo.collections.asr.models import ASRModel
                _offline_model = ASRModel.from_pretrained(OFFLINE_MODEL_ID)
            except Exception as e:
                try: print(f"[ASR] parakeet 加载失败: {e}", flush=True)
                except Exception: pass
                _offline_model = None
        if _offline_model is None and not (OFFLINE_IS_GLM or OFFLINE_IS_WHISPER or OFFLINE_IS_PARAKEET):
            # funasr AutoModel（seaco / Fun-ASR-Nano / 其他）——GLM/Whisper/parakeet 不走 funasr（各自子进程/加载器）
            from funasr import AutoModel
            _offline_model = AutoModel(
                model=OFFLINE_MODEL_ID, device=_DEVICE, disable_update=True,
                trust_remote_code=True, hub="ms",
            )
        _offline_ready.set()
        # GLM/Whisper/parakeet 无同进程实例（子进程/懒加载）——offline_loaded 由 _GLM_READY 反映
        return _offline_model


def get_stream_model(timeout: float | None = None):
    """取流式模型；未加载时在后台线程里加载（不阻塞事件循环），等待就绪或超时。"""
    if _stream_model is None and not getattr(_load_stream, "_started", False):
        setattr(_load_stream, "_started", True)
        threading.Thread(target=_load_stream, daemon=True).start()
    if timeout is None:
        _stream_ready.wait()          # 阻塞等待（在 run_in_executor 里调，不阻塞事件循环）
    elif not _stream_ready.wait(timeout):
        return None
    return _stream_model


def _run_stream_generate(model, arr: np.ndarray, cache: dict, is_final: bool) -> str:
    """调流式模型，返回本块新增文本（已 strip）。注：流式路径当前不应用热词
    （模型级 hotword 仅 2-pass /voice/transcribe 生效——与方案/README 一致）。

    ⚠ 78f51864 共享层抽取时本函数被误删（调用点残留），WS /ws/stream 一进音频即
    NameError——2026-09-10 docker 审核冒烟实证后从历史原样恢复。"""
    with _model_lock:
        res = model.generate(
            input=arr, cache=cache, is_final=is_final,
            chunk_size=CHUNK_SIZE,
            encoder_chunk_look_back=ENCODER_LOOK_BACK,
            decoder_chunk_look_back=DECODER_LOOK_BACK,
        )
    text = ""
    for seg in (res or []):
        if isinstance(seg, dict) and seg.get("text"):
            text += str(seg["text"])
    return text.strip()


def get_offline_model(timeout: float | None = None):
    if _offline_model is None and not getattr(_load_offline, "_started", False):
        setattr(_load_offline, "_started", True)
        threading.Thread(target=_load_offline, daemon=True).start()
    if timeout is None:
        _offline_ready.wait()
    elif not _offline_ready.wait(timeout):
        return None
    return _offline_model


# ---- SenseVoice 快速模型（伪实时切句识别：VAD 停顿→整句秒出；固定 SenseVoiceSmall） ----
SENSE_MODEL_ID = "iic/SenseVoiceSmall"

def _load_sense_model():
    from funasr import AutoModel
    return AutoModel(
        model=SENSE_MODEL_ID, device=_DEVICE, disable_update=True,
        trust_remote_code=True, hub="ms",
    )

# 懒加载 + 后台预热 + GPU 自愈 invalidate——实现在 asr_common.ModelHolder（共享 _model_lock 推理串行）
_sense = ModelHolder("sensevoice", _load_sense_model, lock=_model_lock)

def get_sense_model(timeout: float | None = None):
    """取 SenseVoice 快速模型（伪实时切句用）；懒加载 + 后台预热。"""
    return _sense.get(timeout)

# ---- 服务端 VAD（fsmn-vad：真实语音端点检测，流式逐段；分段依据不用客户端能量阈值） ----
def _load_vad_model():
    print("[ASR] 加载 fsmn-vad（服务端语音端点检测）…", flush=True)
    from funasr import AutoModel
    model = AutoModel(model="fsmn-vad", device=_DEVICE, disable_update=True, hub="ms")
    print("[ASR] fsmn-vad 就绪", flush=True)
    return model

_vad = ModelHolder("fsmn-vad", _load_vad_model)
# 逐句识别（SenseVoice 快速 + Qwen3 分句精修）：服务端内完成，客户端只收段结果
# 输入：float32 [-1,1] 16k 整段残句 → 输出 {quick, refined}
# float32 [-1,1] 16k 残句 → 临时 wav 文件路径（调用方 finally 负责删除）
# float32 [-1,1] 16k → 内存 wav → base64 字符串（qwen_asr load_audio_any 的 base64 分支：
# 无 / \ 且 len>256 → sf.read(BytesIO) 内存读，**不写磁盘文件、不依赖 librosa/audioread/ffmpeg**
# ——彻底绕开 NoBackendError + 跨平台（Windows 同样免文件））
def _arr_to_wav_b64(arr):
    import io, wave, base64 as _b64
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        int16 = (np.clip(arr, -1, 1) * 32767).astype(np.int16)
        w.writeframes(int16.tobytes())
    # ⚠ 必须加 "data:audio/wav;base64," 前缀——裸 base64 含 "/" 字符，
    #   qwen_asr is_probably_base64 判定（无 / \ 且 len>256）会失败 → 当文件名开 → File name too long！
    #   data:url 前缀走第一分支必定命中（官方支持格式 "base64 data url"）
    return "data:audio/wav;base64," + _b64.b64encode(buf.getvalue()).decode("ascii")

# （_arr_to_wav_tmp / _is_noise_text / _save_raw_wav 已上移共享层 asr_common——arr_to_wav_tmp / is_noise_text / save_raw_wav）

# ① SenseVoice 快速识别（伪实时候选，独立调用——不阻塞精修）
# ⚠ 免临时文件：funasr generate 直接接受 numpy 数组（16k float32），纯内存推理
def _run_segment_quick(arr: np.ndarray, hotwords: str = "") -> str:
    if _DEVICE.startswith("cuda"):        # GPU 模式：先探针（崩则累计自愈）
        _gpu_probe_or_fault()
    # 「直出」模式：quick 直接复用 offline（Qwen3 + 会话热词）——段一次识别即带标点准文本
    if QUICK_USE_OFFLINE:
        try:
            return _run_segment_refined(arr, hotwords)   # 必须传会话热词（context），否则空 ctx 识别质量掉
        except Exception as e:
            try: print(f"[ASR] seg_quick(直出) fail: {e}", flush=True)
            except Exception: pass
            return ""
    try:
        sense = get_sense_model(30.0)
        if sense is None:
            return ""
        with _model_lock:
            res = sense.generate(input=arr, language="auto")
        quick = ""
        for seg in (res or []):
            if isinstance(seg, dict) and seg.get("text"):
                quick += str(seg["text"])
        quick = strip_sense_tags(quick).strip()
        if is_noise_text(quick):
            return ""   # 噪声误识别（韩文乱码/符号）→ 丢弃
        return quick
    except Exception as e:
        if _DEVICE.startswith("cuda") and any(k in str(e).lower() for k in ("hip", "launch failure", "device function", "unload")):
            _gpu_fault(str(e)[:80])
        try: print(f"[ASR] seg_quick fail: {e}", flush=True)
        except Exception: pass
        return ""

# GLM-ASR 子进程转写（独立 venv：server/glm/setup-glm-venv.sh 初始化 ~/.pi/web/data/aiti-ai-input/glm-venv）
# 每次调用起子进程（GPU 加载 ~30s 首次；模型常驻 flask 无法跨进程——子进程一次性，成本换隔离）
_GLM_SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "glm", "glm_server.py")
_GLM_VENV = os.getenv("AITI_ASR_GLM_VENV") or os.path.join(os.path.dirname(_CONFIG_PATH or ""), "glm-venv")
# GLM 常驻服务端口（GLM server 自己监听；默认占 8767——由它顶替 ASR 服务？不——8767 由本进程监听，
# GLM server 用旁路端口避免冲突（AITI_ASR_GLM_PORT）；若用户要 GLM 监听 8767，需让 GLM server 完全替代 →
# 此处用一个独立端口 + 本进程做/health 聚合与 WS 代理即可）
_GLM_PORT = int(os.getenv("AITI_ASR_GLM_PORT", "8769"))
_GLM_BASE = f"http://127.0.0.1:{_GLM_PORT}"
_GLM_PROC = None
# GLM 子进程模式加载状态：首次成功返回 → True；启动/失败 → False（health.offline_loaded 语义）
_GLM_READY = [False]

def _ensure_glm_server() -> bool:
    """确保 GLM 常驻服务在跑（启动时检查 config → 拉起子进程；之后它自管）。"""
    global _GLM_PROC
    import urllib.request
    # 已拉起且健康 → OK
    try:
        with urllib.request.urlopen(f"{_GLM_BASE}/health", timeout=2) as rr:
            if rr.status == 200:
                return True
    except Exception:
        pass
    # 拉起（子进程常驻，GLM server 自管监听/加载）
    py = os.path.join(_GLM_VENV, "bin", "python")
    if not os.path.exists(py):
        try: print(f"[ASR] GLM venv 不存在（{_GLM_VENV}）——请跑 server/glm/setup-glm-venv.sh", flush=True)
        except Exception: pass
        return False
    try:
        import subprocess
        _GLM_PROC = subprocess.Popen(
            [py, _GLM_SERVER, "--port", str(_GLM_PORT)],
            stdout=None, stderr=None,   # 继承（日志进 ⚡命令 面板）
        )
        try: print(f"[ASR] GLM 服务已拉起（pid={_GLM_PROC.pid} port={_GLM_PORT}）", flush=True)
        except Exception: pass
        # 等就绪（最多 180s——模型加载）
        for _i in range(180):
            try:
                with urllib.request.urlopen(f"{_GLM_BASE}/health", timeout=2) as rr:
                    j = json.loads(rr.read().decode()) if False else None
                    _GLM_READY[0] = True
                    return True
            except Exception:
                time.sleep(1)
        try: print(f"[ASR] GLM 服务等待就绪超时", flush=True)
        except Exception: pass
        return False
    except Exception as ee:
        try: print(f"[ASR] GLM 服务拉起失败: {ee}", flush=True)
        except Exception: pass
        return False


def _run_segment_glm(arr: np.ndarray, hotwords: str) -> str:
    """GLM 常驻服务调用（HTTP；服务由启动时拉起/自管）。"""
    import base64 as _b64, io, urllib.request, json as _json, wave as _wave
    if not _ensure_glm_server():
        return ""
    try:
        buf = io.BytesIO()
        with _wave.open(buf, "wb") as wv:
            wv.setnchannels(1); wv.setsampwidth(2); wv.setframerate(16000)
            wv.writeframes((np.clip(arr, -1, 1) * 32767).astype(np.int16).tobytes())
        b64 = _b64.b64encode(buf.getvalue()).decode()
        req = urllib.request.Request(
            f"{_GLM_BASE}/transcribe",
            data=_json.dumps({"audio": b64, "context": hotwords}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=180) as rr:
            resp = _json.loads(rr.read().decode())
        text = (resp.get("text") or "").strip()
        if text:
            _GLM_READY[0] = True
        try: print(f"[ASR] GLM 服务返回: {text[:50]!r} ms={resp.get('ms')}", flush=True)
        except Exception: pass
        return text
    except Exception as e:
        try: print(f"[ASR] GLM 服务调用失败: {e}", flush=True)
        except Exception: pass
        return ""

# ② 2-pass 精修（离线模型：Qwen3 context / 其余 hotword，独立调用）
# qwen_asr 只接收文件路径（不支持数组/file-like）→ 临时 wav 落 /dev/shm（tmpfs 内存盘）：
# 磁盘无 IO，且避开 audioread 后端探测的 tempfile 竞态
def _run_segment_refined(arr: np.ndarray, hotwords: str) -> str:
    if _DEVICE.startswith("cuda"):        # GPU 模式：先探针（崩则累计自愈）
        _gpu_probe_or_fault()
    try: print(f"[ASR] refine: offline={OFFLINE_MODEL_ID} | QWEN3={OFFLINE_IS_QWEN3} GLM={OFFLINE_IS_GLM}", flush=True)
    except Exception: pass
    # 免文件：base64 内存传入（qwen_asr load_audio_any → sf.read(BytesIO)）
    try:
        audio_b64 = _arr_to_wav_b64(arr)
    except Exception as e:
        if _DEVICE.startswith("cuda"):
            _gpu_fault(str(e)[:80])
        try: print(f"[ASR] seg_refined b64 fail: {e}", flush=True)
        except Exception: pass
        return ""
    try:
        # GLM 等子进程模型不需要同进程 offline（get_offline_model 会返回 None 拦掉）——跳过
        # ⚠ 仅 GLM 是子进程模型无需同进程实例；whisper/parakeet 是同进程懒加载实例，
        #   曾被误列入排除名单 → offline=None → transcribe 炸 → 静默兜底 quick（两分支从未真正工作过）
        _need_instance = not OFFLINE_IS_GLM
        offline = get_offline_model(60.0) if _need_instance else None
        if _need_instance and offline is None:
            return ""
        if OFFLINE_IS_QWEN3:
            with _model_lock:
                res = offline.transcribe(audio=audio_b64, language=None, context=hotwords or None)
            refined = ""
            for r in (res or []):
                if getattr(r, "text", None):
                    refined += str(r.text)
                elif isinstance(r, dict) and r.get("text"):
                    refined += str(r["text"])
        elif OFFLINE_IS_GLM:
            # GLM-ASR：独立 venv 子进程（transformers>=5.0 源码 + TheRock torch；与主进程 qwen_asr 隔离）
            refined = _run_segment_glm(arr, hotwords)
        elif OFFLINE_IS_WHISPER:
            # openai-whisper（torch 版）：无 context 热词；transcribe(语言 auto) 出结果
            import tempfile
            fd, tmp = tempfile.mkstemp(suffix=".wav")
            with os.fdopen(fd, "wb") as f:
                import base64 as _b64mod
                f.write(_b64mod.b64decode(audio_b64.split(",", 1)[-1]))
            try:
                with _model_lock:
                    _r = offline.transcribe(tmp, language=None, fp16=not _DTYPE or _DTYPE.startswith("float"))
                refined = (_r.get("text") or "").strip()
            finally:
                if tmp and os.path.exists(tmp):
                    try: os.unlink(tmp)
                    except OSError: pass
        elif OFFLINE_IS_PARAKEET:
            # NVIDIA parakeet（NeMo 系）：transcribe 临时 wav；无热词（英文极准）
            import tempfile
            fd, tmp = tempfile.mkstemp(suffix=".wav")
            with os.fdopen(fd, "wb") as f:
                import base64 as _b64mod
                f.write(_b64mod.b64decode(audio_b64.split(",", 1)[-1]))
            try:
                with _model_lock:
                    _r = offline.transcribe([tmp])
                # NeMo 2.x 返回 List[Hypothesis]（带 .text）；旧版可能返回 List[str]
                if isinstance(_r, list):
                    refined = "".join(getattr(h, "text", None) or (h if isinstance(h, str) else "") for h in _r).strip()
                else:
                    refined = str(_r or "").strip()
            finally:
                if tmp and os.path.exists(tmp):
                    try: os.unlink(tmp)
                    except OSError: pass
        else:
            args = {"hotword": hotwords} if hotwords else {}
            with _model_lock:
                res = offline.generate(input=[arr], language="auto", **args)
            refined = ""
            for seg in (res or []):
                if isinstance(seg, dict) and seg.get("text"):
                    refined += str(seg["text"])
            refined = join_cjk_spaces(strip_sense_tags(refined))
        refined = refined.strip()
        if is_noise_text(refined):
            return ""   # 噪声误识别 → 丢弃（调用方用 quick 兑底）
        return refined
    except Exception as e:
        try: print(f"[ASR] seg_refined fail: {e}", flush=True)
        except Exception: pass
        return ""




# （_strip_sense_tags / _join_cjk_spaces / _decode_pcm 已上移共享层 asr_common——strip_sense_tags / join_cjk_spaces / decode_pcm）

_STARTED_AT = time.time()  # 进程启动时刻（health.uptime：扩展端自愈判定用，外部拉起也计时准确）

@app.get("/health")
async def health():
    return {
        "ok": True,
        "stream_model": STREAM_MODEL_ID,
        "offline_model": OFFLINE_MODEL_ID,
        "quick_model": SENSE_MODEL_ID,
        "stream_loaded": _stream_model is not None,
        "offline_loaded": _offline_model is not None or (OFFLINE_IS_GLM and _GLM_READY[0]),
        "quick_loaded": _sense.model is not None,
        "uptime": round(time.time() - _STARTED_AT, 1),
        "hotwords": _hotwords.stats()[0],
        "hotwordWorkspaces": _hotwords.stats()[1],
    }


@app.post("/hotwords")
async def set_hotwords(payload: dict):
    """按 workspace 设置热词列表（模型级 hotword 偏置，2-pass 即时生效）。

    请求：{"ws": "<workspace 哈希 key，缺省 __default__>", "hotwords": [...]}；空/缺省 = 清空该 ws。
    """
    raw = payload.get("hotwords") or []
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="hotwords 必须是字符串数组")
    words = [str(w).strip() for w in raw if str(w).strip()]
    # 去重保序（小写归一）+ 上限（数量由调用方控制，4 档×count 最多 400）——asr_common.HotwordStore.set
    ws = str(payload.get("ws") or DEFAULT_WS)
    n = _hotwords.set(ws, words)
    return {"ok": True, "ws": ws, "hotwords": n, "workspaces": _hotwords.stats()[1]}


@app.get("/hotwords")
async def get_hotwords(ws: str | None = None):
    """读回某 workspace 实际生效的热词（管理面板/诊断用；ws 缺省 __default__）。"""
    words = _hotwords.get(ws)
    return {"ok": True, "ws": ws or DEFAULT_WS, "count": len(words), "words": words}


@app.websocket("/ws/stream")
async def ws_stream(ws: WebSocket):
    await ws.accept()
    loop = asyncio.get_running_loop()
    # 模型加载放线程池里阻塞等待，不卡事件循环；浏览器会在 ready 前静默等待
    model = await loop.run_in_executor(None, get_stream_model, 120.0)
    if model is None:
        await ws.send_json({"type": "error", "message": "流式模型加载超时（首次需下载模型，请稍后重试）"})
        await ws.close()
        return
    await ws.send_json({"type": "ready", "chunkMs": CHUNK_SIZE[1] * 60})

    cache = {}
    accum = ""
    start = time.time()

    async def feed(buf: bytes):
        nonlocal accum
        arr = decode_pcm(buf)
        if arr.size == 0:
            return None
        if time.time() - start > MAX_SECONDS:
            # 超长：自动当 stop 处理，避免无限录音烧 CPU
            return await flush_final("")
        text = await loop.run_in_executor(None, _run_stream_generate, model, arr, cache, False)
        if text:
            accum += text
            await ws.send_json({"type": "partial", "text": accum})
        return text

    async def flush_final(extra_pcm: str | bytes):
        nonlocal accum, cache
        arr = decode_pcm(extra_pcm) if isinstance(extra_pcm, (bytes, bytearray)) else np.zeros(0, dtype=np.float32)
        # is_final=True 收尾：把 cache 里 carry-over 的余量解码完，随后自动复位
        text = await loop.run_in_executor(None, _run_stream_generate, model, arr, cache, True)
        if text:
            accum += text
        final = accum.strip()
        accum = ""
        cache = {}
        await ws.send_json({"type": "final", "text": final})
        return final

    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                await feed(msg["bytes"])
            elif msg.get("text") is not None:
                import json
                try:
                    ctl = json.loads(msg["text"])
                except Exception:
                    continue
                kind = ctl.get("type")
                if kind == "stop":
                    await flush_final("")
                elif kind == "reset":
                    accum = ""
                    cache = {}
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass


@app.websocket("/ws/vad")
async def ws_vad(ws: WebSocket):
    """服务级 VAD 分段语音识别（客户端只发 PCM 流，分段/识别/精修全在服务端）。

    协议（init/stop/reset、ready/seg_quick/seg_refined/done）唯一实现在共享层
    asr_common.run_vad_ws_session（与 glm/glm_asr_service.py 共用）；本服务注入
    quick=SenseVoice（QUICK_USE_OFFLINE 时直出）+ refined=多模型 2-pass。
    """
    if os.getenv("AITI_ASR_STUB_ENGINE") == "1":
        # smoke 测试桩（不加载任何识别模型，仅验 WS 协议/分段链路；VAD 仍为真 fsmn-vad）
        quick_fn = lambda seg, hw: "测试语音识别文本"  # noqa: E731
        refined_fn = lambda seg, hw, q: "精修|" + (q or "")  # noqa: E731
    else:
        quick_fn = _run_segment_quick
        refined_fn = lambda seg, hw, q: _run_segment_refined(seg, hw)  # noqa: E731
    await run_vad_ws_session(
        ws,
        quick_fn=quick_fn,
        refined_fn=refined_fn,
        load_vad=_vad.load_blocking,
        hotwords=_hotwords,
        model_hotwords_max=MODEL_HOTWORDS_MAX,
        max_seconds=MAX_SECONDS,
        direct_quick=QUICK_USE_OFFLINE,
        save_recordings_config_path=_CONFIG_PATH,
        log="ASR",
    )


@app.post("/voice/quick")
async def quick_transcribe(audio: UploadFile = File(...)):
    """伪实时切句识别（VAD 停顿→整句秒出）：固定 SenseVoiceSmall（CPU ~0.1-0.3s/句）。
    不查热词、不走配置模型——纯速度优先，前端按住 🎤 分句上屏用。
    """
    start = time.time()
    suffix = Path(audio.filename or "").suffix or ".wav"
    if suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"不支持的音频格式: {suffix}")
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="空的音频数据")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"音频过大（上限 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB）")
    loop = asyncio.get_running_loop()
    model = await loop.run_in_executor(None, get_sense_model, 120.0)
    if model is None:
        raise HTTPException(status_code=503, detail="SenseVoice 加载超时（首次需下载模型，请稍后重试）")

    def _quick():
        # 免临时文件：wav bytes → numpy（funasr 直接渲染数组）——与 /ws/vad quick 同路径，零磁盘 IO
        try:
            import io
            buf = io.BytesIO(data)
            try:
                import wave as _wavmod
                with _wavmod.open(buf) as w:
                    sr = w.getframerate()
                    ch = w.getnchannels()
                    arr = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
                    if ch > 1:
                        arr = arr.reshape(-1, ch).mean(axis=1)
            except Exception:
                import soundfile as _sf
                buf.seek(0)
                arr, sr = _sf.read(buf, dtype="float32", always_2d=False)
            with _model_lock:
                res = model.generate(input=arr, language="auto")
        except Exception as _e:
            try: print(f"[ASR] quick 解码失败: {_e}", flush=True)
            except Exception: pass
            return ""
        text = ""
        for seg in (res or []):
            if isinstance(seg, dict) and seg.get("text"):
                text += str(seg["text"])
        # SenseVoice 标签剥除（<|zh|> <|NEUTRAL|> 等）
        return strip_sense_tags(text).strip()

    text = await loop.run_in_executor(None, _quick)
    return JSONResponse({"ok": True, "text": text, "language": "auto", "quick": True, "model": SENSE_MODEL_ID, "ms": int((time.time() - start) * 1000)})


@app.post("/voice/transcribe")
async def transcribe(audio: UploadFile = File(...), request: Request = None):
    """离线二次识别（2-pass 第二遍）。接受 webm/wav/raw PCM；Qwen3/Fun-ASR-Nano/seaco 精修出最终文本（模型级热词偏置，按 x-aiti-ws 取热词表，Qwen3 用 context / 其余用 hotword）。"""
    start = time.time()
    suffix = Path(audio.filename or "").suffix or ".wav"
    if suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"不支持的音频格式: {suffix}")
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="空的音频数据")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"音频过大（上限 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB）")

    loop = asyncio.get_running_loop()
    model = await loop.run_in_executor(None, get_offline_model, 120.0)
    if model is None:
        raise HTTPException(status_code=503, detail="离线模型加载超时（首次需下载模型，请稍后重试）")

    def _transcribe():
        with _model_lock:
            ws = (request.headers.get("x-aiti-ws") if request is not None else "") or ""
            # 同 /ws/vad：free-form prompt 简写（"术语有：…"）——组装在 asr_common.HotwordStore.prompt
            hw = _hotwords.prompt(ws, MODEL_HOTWORDS_MAX)
            import tempfile
            fd, tmp = tempfile.mkstemp(suffix=suffix)
            try:
                if OFFLINE_IS_QWEN3:
                    # Qwen3-ASR：context= 模型级热词（术语纠偏，实测优于 seaco hotword）；
                    # qwen_asr.transcribe 接受文件路径（webm 需先落盘解码）
                    with os.fdopen(fd, "wb") as f:
                        f.write(data)
                    res = model.transcribe(audio=tmp, language=None, context=hw or None)
                    text = ""
                    for r in (res or []):
                        if getattr(r, "text", None):
                            text += str(r.text)
                        elif isinstance(r, dict) and r.get("text"):
                            text += str(r["text"])
                    return text.strip()
                else:
                    with os.fdopen(fd, "wb") as f:
                        f.write(data)
                    args = {"hotword": hw} if hw else {}
                    res = model.generate(input=[tmp], language="auto", **args)
                    text = ""
                    for seg in (res or []):
                        if isinstance(seg, dict) and seg.get("text"):
                            text += str(seg["text"])
                    return join_cjk_spaces(strip_sense_tags(text))
            finally:
                if tmp and os.path.exists(tmp):
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
        return text

    text = await loop.run_in_executor(None, _transcribe)
    return JSONResponse({
        "ok": True,
        "text": text,
        "language": "auto",
        "pass": 2,
        "model": OFFLINE_MODEL_ID,
        "ms": int((time.time() - start) * 1000),
    })


@app.on_event("startup")
async def _warm_models_at_startup():
    # uvicorn 以 voice-asr-stream:app 方式导入时 __main__ 不执行，这里兜底预热三模型
    threading.Thread(target=_load_stream, daemon=True).start()
    threading.Thread(target=_load_offline, daemon=True).start()
    threading.Thread(target=_sense.load_blocking, daemon=True).start()


if __name__ == "__main__":
    import uvicorn
    # 启动即后台预热三个模型（流式 + 离线 + SenseVoice 快速），首个用户连接尽快 ready
    threading.Thread(target=_load_stream, daemon=True).start()
    threading.Thread(target=_load_offline, daemon=True).start()
    threading.Thread(target=_sense.load_blocking, daemon=True).start()
    port = int(os.getenv("ASR_STREAM_PORT", "8767"))
    uvicorn.run(app, host="127.0.0.1", port=port)

__all__ = ["app", "get_stream_model", "get_offline_model"]


# ---- 启动判定汇总（每个进程启动必打——一眼定位模型/分支/设备/热词配置） ----
try:
    print(f"[ASR] 启动: stream={STREAM_MODEL_ID} | offline={OFFLINE_MODEL_ID} | device={_DEVICE} | dtype={_DTYPE}", flush=True)
    print(f"[ASR] 判定: QWEN3={OFFLINE_IS_QWEN3} GLM={OFFLINE_IS_GLM} WHISPER={OFFLINE_IS_WHISPER} PARAKEET={OFFLINE_IS_PARAKEET} QUICK_USE_OFFLINE={QUICK_USE_OFFLINE}", flush=True)
    # 热词提示句式与 asr_common.HotwordStore.prompt 一致（「术语有：…。」）
    print(f"[ASR] 热词: max={MODEL_HOTWORDS_MAX} | 提示句式=术语有：…。 | save_rec={os.getenv('AITI_ASR_SAVE_RECORDINGS','')!r}", flush=True)
    print(f"[ASR] 看门狗: fault_limit={_GPU_FAULT_LIMIT} reload_limit=2 | GLM脚本={_GLM_SERVER} venv={_GLM_VENV}", flush=True)
except Exception:
    pass

# ---- 启动时：config=GLM → 拉起 GLM 常驻服务（子进程自管；父进程只拉起不监听） ----
if OFFLINE_IS_GLM:
    try:
        _ensure_glm_server()
    except Exception:
        pass

# ==================== qwen_asr 兼容补丁（对齐 HF 官方格式） ====================
# 官方向（Qwen3-ASR-0.6B-hf 模型卡 Chat template 节）system content 为数组：
#   {"role": "system", "content": [{"type": "text", "text": "Vocabulary: ..."}]}
# qwen_asr 0.0.6 的 _build_messages 用纯字符串 content——0.6B 小模型对纯字符串 system
# 易把提示词当输出复述（实测：吐 "术语有：..." 全文）。monkey-patch 为数组格式，行为与官方一致。
def _patch_qwen_asr_messages():
    try:
        import qwen_asr.inference.qwen3_asr as _qm
        if getattr(_qm.Qwen3ASRModel, "_aiti_patched", False):
            return
        _orig = _qm.Qwen3ASRModel._build_messages
        def _patched(self, context, audio_payload):
            msgs = [
                {"role": "system", "content": [{"type": "text", "text": context or ""}]},
                {"role": "user", "content": [{"type": "audio", "audio": audio_payload}]},
            ]
            return msgs
        _qm.Qwen3ASRModel._build_messages = _patched
        _qm.Qwen3ASRModel._aiti_patched = True
        try: print("[ASR] qwen_asr _build_messages 已补丁为官方数组格式", flush=True)
        except Exception: pass
    except Exception as _e:
        try: print(f"[ASR] qwen_asr patch skip: {_e}", flush=True)
        except Exception: pass
_patch_qwen_asr_messages()

