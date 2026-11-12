#!/usr/bin/env python3
"""aiti-ai-input · offline 模型 E2E 横评（前端同路径）。

用法（asr-venv）：
  python tests/run_model_matrix.py "<offline 模型 id>" [加载超时秒]
  例：python tests/run_model_matrix.py "Qwen/Qwen3-ASR-0.6B" 240

流程（与界面切模型完全同路径）：
  模拟面板 POST /asr/set-feature（asr.model.offline）→ 自动 restart →
  等 8767 端口 pid 更替 + /health offline_loaded=true（⚠ 必须等 pid 更替：
  模型未变时旧进程 health 恒 true 会假通过）→
  WSS /aiti-ai-input/asr/ws/vad 用 recordings 主录音逐个 init→PCM→stop→收 done。
结果：每模型一行 JSON（各录音 refined 文本/段数/耗时）。
注意：Qwen3-1.7B 在 TheRock ROCm 上首推理后 HIP crash（算子不兼容，非显存）。
"""
import asyncio, glob, json, sys, time, urllib.request
import numpy as np
import websockets

PORT_BASE = "http://127.0.0.1:3002/api/extensions/aiti-ai-input"
WSS = "wss://pi.example.com:8443/aiti-ai-input/asr/ws/vad"
CWD = "/home/pi/workspace/pi-work"
WAVS = [
    "/home/pi/.pi/web/data/aiti-ai-input/recordings/vad_20260905_161442.wav",  # 5.3s
    "/home/pi/.pi/web/data/aiti-ai-input/recordings/vad_20260905_211933.wav",  # 4.4s 热词素材
    "/home/pi/.pi/web/data/aiti-ai-input/recordings/vad_20260905_213910.wav",  # 5.6s
]
SSL_CTX = __import__("ssl").create_default_context()


def http_json(path, body=None, method=None, timeout=30):
    url = PORT_BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"),
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def pcm_frames(path):
    import wave
    with wave.open(path, "rb") as w:
        arr = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    b = arr.tobytes()
    return [b[i:i + 1365 * 2] for i in range(0, len(b), 1365 * 2)]


def wait_ready(model, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            h = http_json("/asr/info", timeout=3)
            d = h.get("data") or (h if h.get("offline_model") else {})
            if d.get("offline_model") == model and d.get("offline_loaded") is True:
                return time.time() - t0
        except Exception:
            pass
        time.sleep(2)
    return None


def port_pid():
    import subprocess
    out = subprocess.run(["ss", "-tlnp"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if ":8767" in line and "pid=" in line:
            return int(line.split("pid=")[1].split(",")[0])
    return None


def wait_new_process(old_pid, model, timeout):
    """等 restart 真正发生：端口 pid 更替 + 新进程模型加载完成。"""
    t0 = time.time()
    while time.time() - t0 < min(30, timeout):
        pid = port_pid()
        if pid and pid != old_pid:
            break
        time.sleep(1)
    else:
        return None  # 30s 内 pid 没变（服务可能没起）
    dt = wait_ready(model, timeout - (time.time() - t0))
    return dt


async def one_wav(wav):
    frames = pcm_frames(wav)
    segs, done = [], None
    t0 = time.time()
    async with websockets.connect(WSS, ssl=SSL_CTX, max_size=10 * 1024 * 1024) as ws:
        await asyncio.wait_for(ws.recv(), timeout=30)          # ready
        await ws.send(json.dumps({"type": "init", "ws": CWD}))
        for f in frames:
            await ws.send(f)
            await asyncio.sleep(0.085)
        await ws.send(json.dumps({"type": "stop"}))
        while True:
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout=120))
            if m.get("type") in ("seg_quick", "seg_refined"):
                segs.append(m)
            elif m.get("type") == "done":
                done = m
                break
            elif m.get("type") == "error":
                return {"error": m.get("message", "")[:80], "t": round(time.time() - t0, 1)}
    out = []
    for s in sorted(done.get("segments", []), key=lambda x: x.get("idx", 0)):
        out.append((s.get("refined") or s.get("quick") or "").strip())
    return {"text": " / ".join(x for x in out if x), "segs": len(segs), "t": round(time.time() - t0, 1)}


def main():
    model = sys.argv[1]
    load_timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 240
    res = {"model": model, "wavs": {}}

    # ① 模拟界面切模型（自动触发 restart）
    old_pid = port_pid()
    r = http_json("/asr/set-feature", {"featureId": "asr.model.offline", "value": model})
    assert r.get("ok"), f"set-feature 失败: {r}"

    # ② 等重启（pid 更替）+ 模型加载
    dt = wait_new_process(old_pid, model, load_timeout)
    if dt is None:
        res["status"] = "LOAD_TIMEOUT"
        print(json.dumps(res, ensure_ascii=False), flush=True)
        return
    res["load_s"] = round(dt, 1)

    # ③ 前端同路径 WSS × 3 录音
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for wav in WAVS:
        tag = wav.split("_")[-1].replace(".wav", "")
        try:
            res["wavs"][tag] = loop.run_until_complete(one_wav(wav))
        except Exception as e:
            res["wavs"][tag] = {"error": f"{type(e).__name__}: {str(e)[:80]}"}
    res["status"] = "OK"
    print(json.dumps(res, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
