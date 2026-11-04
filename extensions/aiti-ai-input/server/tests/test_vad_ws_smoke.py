#!/usr/bin/env python3
"""WS /ws/vad smoke 测试（共享层 asr_common.run_vad_ws_session，两服务共用）。

用法（asr-venv 或任意有 fastapi/numpy/websockets/funasr 的环境）：
  cd server
  python tests/test_vad_ws_smoke.py voice   # 测 voice-asr-stream.py
  python tests/test_vad_ws_smoke.py glm     # 测 glm/glm_asr_service.py
  python tests/test_vad_ws_smoke.py all

方式：子进程起目标服务（AITI_ASR_STUB_ENGINE=1 桩识别引擎 + 真 fsmn-vad + CPU），
用真实语音 wav（dataDir/recordings/vad_*.wav，可 AITI_ASR_SMOKE_WAV 覆盖）逐帧喂 WS，
断言：
  ① ready 收到
  ② 发完全部 binary 帧后连接仍开着（⚠ GLM 版 bug 回归点：修前 `time.time()-0>MAX_SECONDS`
     恒真 → 首个 PCM 帧即收 done 断连）
  ③ stop 后收到 seg_quick/seg_refined（VAD 检出真实语音）与 done
  ④ done.segments 非空且 quick/refined 为桩文本
退出码 0=通过 1=失败（有段检出时才算全绿；仅协议通过打印 WARN）。
"""
import asyncio
import glob
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import wave

import numpy as np

PORT = int(os.getenv("AITI_ASR_SMOKE_PORT", "8799"))
BASE = f"ws://127.0.0.1:{PORT}/ws/vad"
SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def find_sample_wav() -> str | None:
    """真实语音素材：env 指定 > dataDir/recordings > server/recordings；要求 ≥3s（过短无停顿 VAD 切不出段）。"""
    cand = os.getenv("AITI_ASR_SMOKE_WAV", "")
    if cand and os.path.exists(cand):
        return cand
    for base in (
        os.path.expanduser("~/.pi/web/data/aiti-ai-input/recordings"),
        os.path.join(SERVER_DIR, "recordings"),
    ):
        for path in sorted(glob.glob(os.path.join(base, "vad_*.wav")) + glob.glob(os.path.join(base, "*.wav")), reverse=True):
            try:
                import wave as _w
                with _w.open(path, "rb") as w:
                    sr, n = w.getframerate(), w.getnframes()
                    if n / max(sr, 1) < 3.0:
                        continue
                    arr = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
                # 要求有真实语音能量（空按纯底噪文件 VAD 切不出段）
                if float(np.sqrt(np.mean(arr ** 2))) >= 0.005:
                    return path
            except Exception:
                continue
    return None


def load_pcm(path: str | None, fallback_seconds: float = 3.0) -> bytes:
    """wav → 16k mono int16 bytes；无素材则合成 440Hz 断续正弦（VAD 可能不检出，仅协议验证）。"""
    if path:
        with wave.open(path, "rb") as w:
            sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
            raw = w.readframes(n)
        arr = np.frombuffer(raw, dtype=np.int16)
        if ch > 1:
            arr = arr.reshape(-1, ch).mean(axis=1).astype(np.int16)
        if sr != 16000:
            x = np.arange(0, len(arr), sr / 16000).astype(int)
            arr = arr[x[: int(len(arr) * 16000 / sr)]]
        print(f"[smoke] 素材: {path} ({len(arr) / 16000:.1f}s)")
        return arr.astype(np.int16).tobytes()
    print(f"[smoke] WARN 无真实素材，合成正弦（VAD 可能不检出段）")
    t = np.arange(int(fallback_seconds * 16000)) / 16000
    tone = (np.sin(2 * np.pi * 440 * t) * 0.4 * 32767).astype(np.int16)
    gate = ((t % 0.8) < 0.5).astype(np.int16)   # 0.5s 有声 / 0.3s 静音
    return (tone * gate).tobytes()


async def wait_health(timeout: float = 120.0) -> dict:
    import urllib.request
    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{PORT}/health"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                return json.loads(r.read().decode())
        except Exception:
            await asyncio.sleep(0.5)
    raise TimeoutError(f"health 不通: {url}")


async def run_case(pcm: bytes, real: bool = False) -> bool:
    import websockets
    seg_quick = seg_refined = None
    done = None
    async with websockets.connect(BASE, max_size=10 * 1024 * 1024) as ws:
        # ① ready
        first = json.loads(await ws.recv())
        ok1 = first.get("type") == "ready"
        print(f"[smoke] ① ready: {ok1} ({first})")
        # init + 逐帧 binary
        await ws.send(json.dumps({"type": "init", "ws": "/tmp/smoke-ws"}))
        frame = 3200 * 2   # 200ms int16
        for i in range(0, len(pcm), frame):
            await ws.send(pcm[i : i + frame])
            await asyncio.sleep(0.01)
        # ② 关键回归点：发完 binary 后连接仍开着（做一次收-超时探测）
        survived = True
        try:
            extra = await asyncio.wait_for(ws.recv(), timeout=1.0)
            # 收到帧不算失败（可能是已切出段的 seg_*）——只有连接关闭才算回归
            print(f"[smoke] ② binary 后仍有推送: {str(extra)[:60]}")
        except asyncio.TimeoutError:
            pass
        except Exception as e:
            survived = False
            print(f"[smoke] ② binary 后连接异常关闭（回归!）: {e}")
        print(f"[smoke] ② 发完全部 binary 帧连接存活: {survived}")
        # ③ stop → seg_* → done
        await ws.send(json.dumps({"type": "stop"}))
        try:
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
                if msg.get("type") == "seg_quick":
                    seg_quick = msg
                elif msg.get("type") == "seg_refined":
                    seg_refined = msg
                elif msg.get("type") == "done":
                    done = msg
                    break
                elif msg.get("type") == "error":
                    print(f"[smoke] ③ 服务端 error: {msg}")
                    break
        except asyncio.TimeoutError:
            print("[smoke] ③ 等 done 超时")
        except Exception as e:
            print(f"[smoke] ③ 连接关闭: {e}")
        ok3 = done is not None
        print(f"[smoke] ③ stop 后收到 done: {ok3} (seg_quick={seg_quick} seg_refined={seg_refined})")
        # ④ done.segments
        ok4 = bool(done and done.get("segments"))
        print(f"[smoke] ④ done.segments 非空: {ok4} ({[ (s.get('idx'), s.get('quick'), s.get('refined')) for s in (done or {}).get('segments', []) ]})")
        ok = ok1 and survived and ok3 and ok4
        if ok and real:
            texts = [s.get("quick", "") for s in done.get("segments", [])]
            ok = any(t and t != "测试语音识别文本" for t in texts)
            print(f"[smoke] ⑤ 真引擎文本非桩: {ok} ({texts})")
        return ok


async def main(target: str) -> int:
    cfg = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
    real = os.getenv("AITI_ASR_SMOKE_REAL") == "1"   # 真引擎（加载 SenseVoice；慢）——验证注入路径
    offline = "iic/SenseVoiceSmall" if real else "stub"   # real：offline 走 funasr generate 分支（本地已缓存）
    json.dump({"stream_model": "paraformer-zh-streaming", "offline_model": offline}, cfg)
    cfg.close()
    env = dict(os.environ,
               AITI_ASR_DEVICE="cpu",
               ASR_CONFIG_PATH=cfg.name,
               HF_HUB_OFFLINE="1",
               **({"AITI_ASR_GLM_PORT": str(PORT)} if target == "glm" else {}))
    if not real:
        env["AITI_ASR_STUB_ENGINE"] = "1"
    if target == "glm":
        cmd = [sys.executable, os.path.join(SERVER_DIR, "glm", "glm_asr_service.py")]
    else:
        cmd = [os.path.join(SERVER_DIR, os.getenv("ASR_SMOKE_PY", ".venv/bin/python")) and sys.executable or sys.executable,
               "-m", "uvicorn", "voice-asr-stream:app", "--host", "127.0.0.1", "--port", str(PORT)]
    print(f"[smoke] 起 {target} 服务 @:{PORT}: {' '.join(cmd)}")
    proc = subprocess.Popen(cmd, cwd=SERVER_DIR, env=env,
                            stdout=open(f"/tmp/asr-smoke-{target}.log", "w"), stderr=subprocess.STDOUT)
    ok = False
    try:
        h = await wait_health()
        print(f"[smoke] health: {h}")
        pcm = load_pcm(find_sample_wav())
        ok = await run_case(pcm, real)
    finally:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        os.unlink(cfg.name)
    print(f"[smoke] {target}: {'PASS ✅' if ok else 'FAIL ❌'}")
    return 0 if ok else 1


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "voice"
    if target == "all":
        rc = asyncio.run(main("voice")) | asyncio.run(main("glm"))
    else:
        rc = asyncio.run(main(target))
    sys.exit(rc)
