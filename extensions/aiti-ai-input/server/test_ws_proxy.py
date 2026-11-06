"""经 pi-web middleware 代理测 WS 流式：ws://<host>/dev/aiti-ai-input/asr/ws/stream"""
import asyncio, json, subprocess, tempfile, os, wave
import numpy as np

ZH = "/home/pi/.cache/modelscope/models/iic--SenseVoiceSmall/snapshots/master/example/zh.mp3"
_tmp = tempfile.mktemp(suffix=".wav")
subprocess.run(["ffmpeg", "-y", "-i", ZH, "-ar", "16000", "-ac", "1", "-f", "wav", _tmp], check=True, capture_output=True)
with wave.open(_tmp, "rb") as w:
    sr = w.getframerate()
    mono = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
os.unlink(_tmp)
pcm = (mono * 32767).astype(np.int16).tobytes()
print(f"audio {len(mono)/sr:.2f}s")

import websockets

async def main():
    # 1) 直连 8767（旁路）
    # 2) 经 pi-web dev middleware
    targets = [
        ("direct-8767", "ws://127.0.0.1:8767/ws/stream"),
        ("piweb-dev-proxy", "ws://127.0.0.1:3001/dev/aiti-ai-input/asr/ws/stream"),
        ("piweb-prod-proxy", "ws://127.0.0.1:3002/aiti-ai-input/asr/ws/stream"),
    ]
    for name, url in targets:
        print(f"\n=== {name}: {url} ===")
        try:
            async with websockets.connect(url, open_timeout=15, close_timeout=5, max_size=2_000_000) as ws:
                msgs = []
                try:
                    first = await asyncio.wait_for(ws.recv(), timeout=120)
                    msgs.append(first)
                except Exception as e:
                    print("  recv ready failed:", e); continue
                frame = 960 * 2  # 60ms int16 bytes
                for i in range(0, len(pcm), frame):
                    await ws.send(pcm[i:i + frame])
                await ws.send(json.dumps({"type": "stop"}))
                try:
                    while True:
                        m = await asyncio.wait_for(ws.recv(), timeout=20)
                        msgs.append(m)
                        try:
                            j = json.loads(m)
                            if j.get("type") == "final":
                                print("  partials:", [json.loads(x).get("text") for x in msgs if '"partial"' in x][:8])
                                print("  final:", j.get("text"))
                                break
                        except Exception:
                            pass
                except Exception as e:
                    print("  loop err:", e)
        except Exception as e:
            print("  CONNECT FAIL:", type(e).__name__, str(e)[:120])

asyncio.run(main())
