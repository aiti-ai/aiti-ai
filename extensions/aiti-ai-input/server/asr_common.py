#!/usr/bin/env python3
"""
aiti-ai-input · ASR 共享层（voice-asr-stream.py 与 glm/glm_asr_service.py 公共部分）

来历：glm_asr_service.py 初期从 voice-asr-stream.py **复制**了配置加载/热词表/SenseVoice/
fsmn-vad/文本音频工具/WS /ws/vad 会话骨架（~250 行）——既有一份漂移风险，且复制版漏了
三块（尾段兜底 _cut_tail「松手即句末」、等待在途识别再发 done、空段剔除），还引入了
`time.time() - 0 > MAX_SECONDS` 超时误判 bug（Unix 时间戳恒 > 60 → 收到首个 PCM 帧即断）。
本模块把「引擎无关」的部分收敛到一处；两个服务各自只保留识别引擎差异：

  voice-asr-stream.py : quick=SenseVoice（直出可选）refined=Qwen3/GLM子进程/Whisper/parakeet/seaco
  glm_asr_service.py  : quick=SenseVoice             refined=GLM（transformers 5.x，官方热词句式）

WS /ws/vad 协议（唯一实现 = run_vad_ws_session，识别引擎经 quick_fn/refined_fn 注入）：
  客户端 → 服务端：
    binary 帧：16k mono PCM int16 小端（任意分块）
    {"type":"init","ws":"<workspace cwd>"}   会话热词（服务端算 ws key 取热词表）
    {"type":"stop"}          停止（残余兜底切尾段 → 等在途识别 → done）
    {"type":"reset"}         弃当前段（VAD 复位 + 会话状态清空）
  服务端 → 客户端：
    {"type":"ready","engine":"vad+quick+refined"}
    {"type":"seg_quick","idx":0,"quick":"..."}       VAD 检出句 → SenseVoice 秒出
    {"type":"seg_refined","idx":0,"refined":"..."}   该句精修完成
    {"type":"done","segments":[{"idx","quick","refined"}]}   按 idx 排序、剔空段

⚠ 本模块**严禁模块级 import torch / funasr / transformers**：
  两服务都是「先 load_asr_config()（config.env 灌入）再 import torch」——HSA/HIP 等
  GPU 初始化读环境变量，必须先灌 env。所有重 import 一律放函数内。
"""
from __future__ import annotations  # PEP 604 注解（threading.Lock | None）在 py<3.14 需惰性求值

import asyncio
import hashlib
import os
import re
import threading
import time

import numpy as np
from fastapi import WebSocket, WebSocketDisconnect


# ============================================================
# 配置加载（config > env > 默认；两服务同款语义）
# ============================================================

def config_path(default_dir: str | None = None) -> str:
    """配置文件路径：ASR_CONFIG_PATH env 优先，否则 <default_dir>/asr-config.json。"""
    return os.getenv("ASR_CONFIG_PATH") or os.path.join(default_dir or os.getcwd(), "asr-config.json")


def load_asr_config(path: str | None = None) -> dict:
    """读配置文件并把 config.env 灌入 os.environ。

    ⚠ 调用时机必须早于任何 import torch/funasr（HSA/HIP 初始化读环境变量）；
    config 显式写出的 env 优先生效，空值不覆盖现有环境。
    """
    p = path or config_path()
    cfg: dict = {}
    try:
        import json
        with open(p, "r", encoding="utf-8") as f:
            cfg = json.load(f) or {}
    except Exception:
        cfg = {}
    env_cfg = cfg.get("env")
    if isinstance(env_cfg, dict):
        for k, v in env_cfg.items():
            if v is not None and str(v) != "":
                os.environ[str(k)] = str(v)
    return cfg


# ============================================================
# 热词表（workspace 粒度 + 「术语有：…」prompt 组装）
# ============================================================

DEFAULT_WS = "__default__"


def ws_key_of(cwd: str) -> str:
    """与扩展 index.ts asrWsKey 对齐：sha1(cwd).hexdigest()[:12]（无 cwd → __default__）。"""
    raw = (cwd or "").strip()
    if not raw:
        return DEFAULT_WS
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


class HotwordStore:
    """workspace 粒度热词表（内存）。

    ws key = ws_key_of(cwd)（不透明哈希，不见路径）；DEFAULT_WS 为不带 ws 的兜底档。
    多 workspace 并行不冲突；/hotwords 端点动态更新，/ws/vad init 帧 / x-aiti-ws header 取用。
    """

    def __init__(self) -> None:
        self._by_ws: dict[str, list[str]] = {}

    def set(self, ws: str | None, words: list[str]) -> int:
        """设置/清空（空列表 = 清空该 ws）；strip + 去重保序（小写归一）+ 1000 上限。返回实际词数。"""
        words = [str(w).strip() for w in words if str(w).strip()]
        seen: set[str] = set()
        uniq = [w for w in words if not (w.lower() in seen or seen.add(w.lower()))][:1000]
        key = ws or DEFAULT_WS
        if uniq:
            self._by_ws[key] = uniq
        else:
            self._by_ws.pop(key, None)
        return len(uniq)

    def get(self, ws: str | None = None) -> list[str]:
        return self._by_ws.get(ws or DEFAULT_WS, [])

    def prompt(self, ws: str | None = None, max_words: int = 8) -> str:
        """「术语有：a、b。」——free-form 热词提示（Qwen3 context / GLM 官方句式源 / seaco hotword）。

        简写一行即达意（明确告诉模型这是词汇表而非转录内容），过长指令反而稀释。
        """
        sel = self.get(ws)[:max_words]
        return ("术语有：" + "、".join(sel) + "。") if sel else ""

    def stats(self) -> tuple[int, int]:
        """（总词数, workspace 数）——/health 用。"""
        return sum(len(v) for v in self._by_ws.values()), len(self._by_ws)


# ============================================================
# 模型懒加载器（funasr 系通用）
# ============================================================

class ModelHolder:
    """模型懒加载器：后台预热 + get(timeout) 阻塞等待 + invalidate（GPU 自愈用）。

    - start_background()：首次调用起 daemon 线程加载（不阻塞事件循环，浏览器在 ready 前静默等待）
    - get(timeout=None)：未加载则触发后台加载并等待；timeout 到 → None（调用方 503/报错）
    - load_blocking()：同步加载（WS 骨架在 run_in_executor 里调）；失败打印日志、ready 不置位
      （loader 抛异常 → get(timeout) 超时返回 None——与原 voice-asr-stream 行为一致）
    - invalidate()：置空 + 清 event（GPU 崩自愈 _gpu_reinit 用，下次 get 重新懒加载）
    """

    def __init__(self, name: str, loader, lock: threading.Lock | None = None) -> None:
        self.name = name
        self._loader = loader
        self._lock = lock
        self.model = None
        self.ready = threading.Event()
        self._started = False

    def start_background(self) -> None:
        if self.model is not None or self._started:
            return
        self._started = True
        threading.Thread(target=self.load_blocking, daemon=True).start()

    def load_blocking(self):
        if self.model is not None:
            self.ready.set()
            return self.model
        if self._lock is not None:
            with self._lock:
                if self.model is None:
                    self.model = self._loader()
        else:
            if self.model is None:
                self.model = self._loader()
        self.ready.set()
        return self.model

    def get(self, timeout: float | None = None):
        if self.model is None and not self._started:
            self.start_background()
        if timeout is None:
            self.ready.wait()
        elif not self.ready.wait(timeout):
            return None
        return self.model

    def invalidate(self) -> None:
        self.model = None
        self.ready.clear()
        self._started = False


# ============================================================
# 文本 / 音频工具
# ============================================================

_SENSE_TAG = r"<\|[^|]*\|>"


def strip_sense_tags(text: str) -> str:
    """SenseVoice 输出携带 <|zh|> <|NEUTRAL|> 等特殊 token，统一剥掉。"""
    return re.sub(_SENSE_TAG, "", text or "").strip()


def is_noise_text(t: str) -> bool:
    """识别结果噪声过滤：韩文/乱码/纯符号等无效输出丢弃。

    有效 = 含中文/日文假名，或 ≥2 连串拉丁字母/数字（ok/pi/v2）；
    纯韩文（그 类）无 CJK 且无英文 → 噪声。
    """
    t = (t or "").strip()
    if not t:
        return True
    if re.search(r"[\u4e00-\u9fff\u3040-\u30ff]", t):
        return False   # 含中/日文字符 → 有效
    if re.search(r"[a-z0-9]{2,}", t.lower()):
        return False   # ≥2 字母/数字连串（ok/pi/v2）→ 有效
    return True        # 其余（纯韩文/符号/单字符）→ 噪声


def join_cjk_spaces(text: str) -> str:
    """seaco 输出按字符空格分隔（"国 务 院"）——去掉中文单字之间的空格；英文词（多字符 token）保留。"""
    return re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", text or "").strip()


def decode_pcm(data: bytes) -> np.ndarray:
    """int16 小端 → float32 [-1,1]（16k mono PCM WS 二进制帧解码）。"""
    if not data:
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


# 临时 wav 目录：Linux/macOS 优先 /dev/shm（tmpfs 内存盘，无磁盘 IO）；
# Windows 没有 /dev/shm → tempfile 系统默认 Temp（跨平台安全回退，勿写死 Linux 路径）
_TMP_DIR = "/dev/shm" if (os.name == "posix" and os.path.isdir("/dev/shm")) else None


def arr_to_wav_tmp(arr: np.ndarray) -> str:
    """float32 [-1,1] 16k → 临时 wav 文件路径（GLM/qwen_asr 等只收文件路径的引擎用；
    调用方 finally 负责 unlink）。mkstemp 系统临时目录：Windows %TEMP%。"""
    import tempfile
    import wave
    fd, tmp = tempfile.mkstemp(suffix=".wav", dir=_TMP_DIR)
    with os.fdopen(fd, "wb") as f:
        wav = wave.open(f, "wb")
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        int16 = np.clip(arr, -1, 1) * 32767
        wav.writeframes(int16.astype(np.int16).tobytes())
        wav.close()
    return tmp


def save_raw_wav(raw: bytearray, config_path: str) -> str:
    """整段 PCM bytes（16k int16）落盘 wav——排查/测试素材（真实语音）。

    隐私优先：默认关。开启：config.env 或进程 env AITI_ASR_SAVE_RECORDINGS=1；
    目录：<config_path 所在目录>/recordings/（AITI_ASR_RECORDINGS_DIR 覆盖）。
    """
    try:
        if os.getenv("AITI_ASR_SAVE_RECORDINGS", "") != "1":
            return ""
        if not raw or len(raw) < 1600 * 2:   # <100ms 不存
            return ""
        import tempfile
        import wave
        out_dir = os.getenv("AITI_ASR_RECORDINGS_DIR") or os.path.join(os.path.dirname(config_path or ""), "recordings")
        try:
            os.makedirs(out_dir, exist_ok=True)
        except Exception:
            out_dir = tempfile.gettempdir()
        name = f"vad_{time.strftime('%Y%m%d_%H%M%S')}.wav"
        path = os.path.join(out_dir, name)
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(bytes(raw))
        print(f"[ASR] save recording: {path} ({len(raw) // 2 / 16000:.2f}s)", flush=True)
        return path
    except Exception as e:
        print(f"[ASR] save recording fail: {e}", flush=True)
        return ""


# ============================================================
# 服务端 VAD（fsmn-vad：真实语音端点检测，流式逐段；分段依据不用客户端能量阈值）
# ============================================================

# 切句节奏（DynamicStreamingVAD 动态静音阈值表 [句长上限ms, 静音切句ms]）：
# 短句停 1.2s 即切（默认表 2s 起太保守——说话停半秒切不出来会丢尾句感）；
# 越长句越宽松（长句 0.4s 停顿即切不堆积）。调大 → 更少切碎；调小 → 更跟手。
SILENCE_SCHEDULE = [
    (5000, 1200),     # 本句 ≤5s：停 1.2s 切（0.8s 实测碎句——同一句被切断且短段易乱码）
    (10000, 800),
    (15000, 600),
    (30000, 500),
    (45000, 400),
    (float("inf"), 300),
]


def make_dynamic_vad(vad_model):
    """fsmn-vad AutoModel → DynamicStreamingVAD（内部按 60ms chunk 流式喂入，动态静音阈值）。"""
    from funasr.models.fsmn_vad_streaming.dynamic_vad import DynamicStreamingVAD
    return DynamicStreamingVAD(vad_model, chunk_size_ms=60, silence_schedule=list(SILENCE_SCHEDULE))


# ============================================================
# WS /ws/vad 会话骨架（协议唯一实现；识别引擎注入）
# ============================================================

async def run_vad_ws_session(
    ws: WebSocket,
    *,
    quick_fn,                          # (seg: np.ndarray, hw: str) -> str  SenseVoice 快识
    refined_fn,                        # (seg: np.ndarray, hw: str, quick: str) -> str
    load_vad,                          # () -> fsmn-vad AutoModel（阻塞加载；骨架在 executor 调）
    hotwords: HotwordStore,
    model_hotwords_max: int = 8,
    max_seconds: float = 60,
    direct_quick: bool = False,        # 直出模式：quick 即 refined（QUICK_USE_OFFLINE）
    vad_factory=make_dynamic_vad,      # 可注入（测试桩）
    save_recordings_config_path: str = "",   # 非空 → stop 时按 env 开关落盘整段录音
    log: str = "ASR",
) -> None:
    """WS /ws/vad 会话骨架（accept → ready → receive 循环 → 等在途 → done）。

    引擎无关：quick_fn / refined_fn 由各服务注入（骨架内经 run_in_executor 调用，
    不阻塞事件循环）；会话热词经 init 帧（ws=cwd → ws_key_of → store.prompt）装配。
    """
    await ws.accept()
    loop = asyncio.get_running_loop()

    # VAD 模型加载放线程池里阻塞等待，不卡事件循环
    try:
        vad_model = await loop.run_in_executor(None, load_vad)
    except Exception as e:
        vad_model = None
        print(f"[{log}] fsmn-vad 加载异常: {e}", flush=True)
    if vad_model is None:
        try:
            await ws.send_json({"type": "error", "message": "fsmn-vad 加载失败"})
            await ws.close()
        except Exception:
            pass
        return
    vad = (vad_factory or make_dynamic_vad)(vad_model)
    await ws.send_json({"type": "ready", "engine": "vad+quick+refined"})

    # 会话状态
    pcm_buf = np.zeros(0, dtype=np.float32)     # 累计 PCM（截句后保留，供 done 拼接）
    raw_buf = bytearray()                        # 原始 PCM bytes（整段录音落盘用）
    seg_results: list[dict] = []                 # 已完成的段（done 时推送）
    seg_pending: list[dict] = []                 # 已检出未识别的段（在途）
    next_seg_idx = 0                             # 段序号
    last_cut_end_pt = 0                          # 最后已切段的终点（采样点；stop 时残余从此切起）
    hotwords_box = {"text": ""}                  # 会话热词（init 帧传入 cwd → 取 ws 热词；可变容器供闭包读）
    start = time.time()                          # ⚠ 会话起点（勿用裸 time.time() 判超时——Unix 时间戳恒超限）
    n_binary = 0                                 # 诊断：收到 binary 帧数（空识别排查一线证据）

    def _finish_segment(ref: dict) -> None:
        if ref["idx"] not in [s["idx"] for s in seg_results]:
            seg_results.append(ref)
        try:
            seg_pending.remove(ref)
        except ValueError:
            pass

    def _make_identify(seg: np.ndarray, idx: int, ref: dict) -> None:
        """对一段音频先 quick 再 refined，推送 seg_quick / seg_refined。"""
        async def _identify():
            try:
                q = await loop.run_in_executor(None, quick_fn, seg, hotwords_box["text"])
                if direct_quick and q:
                    # 直出：quick 已带标点+热词 → 直接作为 refined（跳过二次精修，单次识别）
                    ref["refined"] = q
                    try:
                        print(f"[{log}] → seg_refined[{idx}] (直出同文) {q[:60]!r}", flush=True)
                    except Exception:
                        pass
                    try:
                        await ws.send_json({"type": "seg_refined", "idx": idx, "refined": q})
                    except Exception as _se:
                        print(f"[{log}] ⚠ seg_refined[{idx}] 发送失败（连接已断？）: {_se}", flush=True)
                    _finish_segment(ref)
                    return
                ref["quick"] = q
                if q:
                    try:
                        print(f"[{log}] → seg_quick[{idx}] {q[:80]!r}", flush=True)
                    except Exception:
                        pass
                    try:
                        await ws.send_json({"type": "seg_quick", "idx": idx, "quick": q})
                    except Exception as _se:
                        print(f"[{log}] ⚠ seg_quick[{idx}] 发送失败（连接已断？）: {_se}", flush=True)
            except Exception as e:
                try:
                    print(f"[{log}] vad seg_quick fail: {e}", flush=True)
                except Exception:
                    pass
            try:
                r = await loop.run_in_executor(None, refined_fn, seg, hotwords_box["text"], ref.get("quick", ""))
                ref["refined"] = r or ref["quick"]
                if r:
                    try:
                        print(f"[{log}] → seg_refined[{idx}] {r[:80]!r}", flush=True)
                    except Exception:
                        pass
                    try:
                        await ws.send_json({"type": "seg_refined", "idx": idx, "refined": r})
                    except Exception as _se:
                        print(f"[{log}] ⚠ seg_refined[{idx}] 发送失败（连接已断？）: {_se}", flush=True)
            except Exception as e:
                try:
                    print(f"[{log}] vad seg_refined fail: {e}", flush=True)
                except Exception:
                    pass
            _finish_segment(ref)
        asyncio.ensure_future(_identify())

    def _cut_ms_segments(ms_segs) -> None:
        """DynamicStreamingVAD 输出 [start_ms, end_ms] → 转为 PCM 段并发识别。"""
        nonlocal next_seg_idx, last_cut_end_pt
        sr = 16000
        for start_ms, end_ms in ms_segs or []:
            s_pt = int(start_ms * sr / 1000)
            e_pt = int(end_ms * sr / 1000)
            if e_pt <= s_pt or e_pt > len(pcm_buf):
                continue
            seg = pcm_buf[s_pt:e_pt]
            # 极短段（<300ms）丢弃
            if seg.size < int(0.3 * sr):
                continue
            idx = next_seg_idx
            next_seg_idx += 1
            ref = {"idx": idx, "quick": "", "refined": ""}
            seg_pending.append(ref)
            _make_identify(seg, idx, ref)
            last_cut_end_pt = max(last_cut_end_pt, e_pt)
            try:
                print(f"[{log}] VAD 切段: idx={idx} {(e_pt - s_pt) / sr:.1f}s（累计切出 {next_seg_idx} 段）", flush=True)
            except Exception:
                pass

    def _cut_tail() -> None:
        """stop 收尾：把最后已切段之后的 PCM 作为尾段无条件提交。

        DynamicStreamingVAD.finalize 对说话中的段不闭合——说话到一半松手会丢尾句，
        这里按「松手即句末」兜底，无需 VAD 再判。
        """
        nonlocal next_seg_idx, last_cut_end_pt
        tail = pcm_buf[last_cut_end_pt:]
        tail_rms = -1.0
        try:
            tail_rms = float(np.sqrt(np.mean(tail * tail))) if tail.size else 0.0
        except Exception:
            pass
        if tail.size < int(0.2 * 16000):
            try:
                print(f"[{log}] 尾段丢弃: {tail.size / 16000:.2f}s < 0.2s（tail_rms={tail_rms:.4f}）", flush=True)
            except Exception:
                pass
            return
        # 防纯静音：只挡数字近零的环境底噪（正常语音 RMS 通常 ≥0.005）；
        # 噪声识别质量由 is_noise_text（识别文本过滤）负责，此处仅防「真空段」
        if tail_rms < 0.002:
            try:
                print(f"[{log}] 尾段丢弃: 静音（tail_rms={tail_rms:.5f} < 0.002）", flush=True)
            except Exception:
                pass
            return
        idx = next_seg_idx
        next_seg_idx += 1
        ref = {"idx": idx, "quick": "", "refined": ""}
        seg_pending.append(ref)
        _make_identify(tail, idx, ref)
        last_cut_end_pt = len(pcm_buf)
        try:
            print(f"[{log}] 尾段提交: idx={idx} {tail.size / 16000:.1f}s tail_rms={tail_rms:.4f}", flush=True)
        except Exception:
            pass

    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                n_binary += 1
                raw_buf.extend(msg["bytes"])
                arr = decode_pcm(msg["bytes"])
                if arr.size == 0:
                    continue
                pcm_buf = np.concatenate([pcm_buf, arr])
                if time.time() - start > max_seconds:
                    # 超长：强制收尾（残余兜底 + 松手即句末），避免无限录音烧 CPU
                    final = await loop.run_in_executor(None, vad.finalize)
                    _cut_ms_segments(final)
                    _cut_tail()
                    break
                # 流式 VAD（内部按 60ms chunk 喂入，动态静音阈值）
                import torch
                try:
                    ms_segs = await loop.run_in_executor(None, vad.feed, torch.from_numpy(arr).float(), False)
                    _cut_ms_segments(ms_segs)
                except Exception as e:
                    try:
                        print(f"[{log}] vad feed err: {e}", flush=True)
                    except Exception:
                        pass
            elif msg.get("text") is not None:
                import json
                try:
                    ctl = json.loads(msg["text"])
                except Exception:
                    continue
                kind = ctl.get("type")
                if kind == "init":
                    # 客户端上报 workspace cwd → 服务端算 ws key → 取该 workspace 热词（上限）
                    cwd = str(ctl.get("ws") or "").strip()
                    if cwd:
                        key = ws_key_of(cwd)
                        hotwords_box["text"] = hotwords.prompt(key, model_hotwords_max)
                        try:
                            print(f"[{log}] init ws={key} hotwords={len(hotwords.get(key))} ctx={hotwords_box['text'][:120]!r}", flush=True)
                        except Exception:
                            pass
                    else:
                        hotwords_box["text"] = ""
                elif kind == "stop":
                    # 强制结束当前段（finalize 返回最后一段——仅对已闭合的段有效）
                    final = await loop.run_in_executor(None, vad.finalize)
                    _cut_ms_segments(final)
                    _cut_tail()   # ⚠ 说话中松手：finalize 不闭合未完成段 → 残余兜底（松手即句末）
                    if save_recordings_config_path:
                        save_raw_wav(raw_buf, save_recordings_config_path)   # 整段落盘（受 env 开关，默认关）
                    break
                elif kind == "reset":
                    try:
                        vad.reset()
                    except Exception as e:
                        try:
                            print(f"[{log}] vad reset err: {e}", flush=True)
                        except Exception:
                            pass
                    pcm_buf = np.zeros(0, dtype=np.float32)
                    seg_results = []
                    seg_pending = []
                    next_seg_idx = 0
                    last_cut_end_pt = 0
                    hotwords_box["text"] = ""
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass

    # 等所有在途识别收尾（最多 30s）——否则 done 会漏掉尚在识别的段
    waited = 0
    while seg_pending and waited < 300:
        await asyncio.sleep(0.1)
        waited += 1
    try:
        dur = len(pcm_buf) / 16000
        hint = " ← 客户端没发音频！查浏览器侧（麦克风权限/采集/WS OPEN 前静默）" if (n_binary == 0 and dur == 0) else ""
        print(f"[{log}] 会话统计: binary帧={n_binary} pcm={dur:.1f}s 切段={next_seg_idx} 有效段={len(seg_results)} 耗时={time.time() - start:.1f}s{hint}", flush=True)
    except Exception:
        pass
    # 按 idx 排序推送 done；剔除 quick/refined 均为空的段（噪声段被过滤后的占位）
    seg_results.sort(key=lambda x: x["idx"])
    seg_results = [r for r in seg_results if (r.get("refined") or r.get("quick") or "").strip()]
    try:
        try:
            print(f"[{log}] → done segments={[(x.get('idx'), (x.get('refined') or x.get('quick') or '')[:30]) for x in seg_results]}", flush=True)
        except Exception:
            pass
        await ws.send_json({"type": "done", "segments": seg_results})
        print(f"[{log}] done 已发送", flush=True)
    except Exception as _se:
        print(f"[{log}] ⚠ done 发送失败（连接已断？）: {_se}", flush=True)
