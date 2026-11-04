"""voice-asr-stream.py 功能测试：离线 2-pass + WS 流式（用 SenseVoice 自带的 zh.mp3）。"""
import io
import json
import os
import subprocess
import tempfile
import wave
import numpy as np

ZH = "/home/wind/.cache/modelscope/models/iic--SenseVoiceSmall/snapshots/master/example/zh.mp3"

# 1) 载入 zh.mp3 → 16k mono PCM（torchaudio 缺 torchcodec，改用 ffmpeg 解码）
_tmp_wav = tempfile.mktemp(suffix=".wav")
subprocess.run(["ffmpeg", "-y", "-i", ZH, "-ar", "16000", "-ac", "1", "-f", "wav", _tmp_wav], check=True, capture_output=True)
with wave.open(_tmp_wav, "rb") as w:
    sr = w.getframerate()
    mono = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
os.unlink(_tmp_wav)
print(f"audio: {mono.shape[0]/sr:.2f}s @ {sr}Hz")

# 转 wav bytes（给离线 POST）
buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes((mono * 32767).astype(np.int16).tobytes())
wav_bytes = buf.getvalue()

from fastapi.testclient import TestClient
import importlib.util
_spec = importlib.util.spec_from_file_location("vas", os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice-asr-stream.py"))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
app = _mod.app

client = TestClient(app)

print("\n=== /health ===")
r = client.get("/health")
print(r.json())

print("\n=== offline POST /voice/transcribe ===")
r = client.post("/voice/transcribe", files={"audio": ("zh.wav", wav_bytes, "audio/wav")})
print(r.json())

print("\n=== WS /ws/stream (60ms 帧) ===")
pcm = (mono * 32767).astype(np.int16).tobytes()
frame = 960  # 60ms 样本数
with client.websocket_connect("/ws/stream") as ws:
    first = ws.receive_json()
    print("first:", first)
    for i in range(0, len(pcm), frame * 2):  # int16 = 2 bytes/样本
        ws.send_bytes(pcm[i:i + frame * 2])
    ws.send_text(json.dumps({"type": "stop"}))
    for _ in range(2000):
        try:
            msg = ws.receive_json()
        except Exception:
            break
        print("msg:", msg)
        if msg.get("type") in ("final", "error"):
            break
print("\nDONE")