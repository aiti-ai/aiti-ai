#!/usr/bin/env python3
"""
GLM-ASR 常驻服务（供 aiti-ai-input 主服务 8767 调用）

- 启动时加载模型（一次），监听 127.0.0.1:<PORT>（默认 8768）
- POST /transcribe  body: {"audio": "<base64 wav 或 data:url>", "context": "术语有：..."}
  → {"ok": true, "text": "..."}  （或 {"ok": false, "error": "..."}）
- GET /health → {"ok": true, "ready": true/false}
- 自管全套：模型加载/热词句式转换/请求处理；父进程只负责拉起与 HTTP 调用

用法：glm-venv/bin/python glm_server.py [--port 8768]
"""
import argparse
import base64
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ---- 模型加载（同 glm_asr.py 的官方流程）----
import torch
from transformers import AutoConfig, AutoProcessor, GlmAsrForConditionalGeneration

_checkpoint = os.getenv("AITI_ASR_GLM_MODEL", "zai-org/GLM-ASR-Nano-2512")
_model = None
_proc = None
_device = None
_ready = False


def load_model():
    global _model, _proc, _device, _ready
    if _ready:
        return
    print("[glm-server] 加载模型…", flush=True)
    _device = "cuda" if torch.cuda.is_available() else "cpu"
    _proc = AutoProcessor.from_pretrained(_checkpoint, trust_remote_code=True)
    cfg = AutoConfig.from_pretrained(_checkpoint, trust_remote_code=True)
    _model = GlmAsrForConditionalGeneration.from_pretrained(
        _checkpoint, config=cfg, torch_dtype=torch.bfloat16, trust_remote_code=True,
    ).to(_device)
    _model.eval()
    _ready = True
    print(f"[glm-server] 就绪 device={_device}", flush=True)


def to_official_context(context: str) -> str:
    """『术语有：…』→ 官方热词句式（提示在前 + 请转录收尾）"""
    if context and context.startswith("术语有："):
        terms = context[len("术语有："):].rstrip("。")
        return f"这段音频可能包含以下词语：{terms}。请转录这段音频"
    return context if context else "Please transcribe this audio into text"


def transcribe_bytes(wav_bytes: bytes, context: str = "") -> str:
    global _ready
    load_model()
    import tempfile
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    with os.fdopen(fd, "wb") as f:
        f.write(wav_bytes)
    try:
        text = to_official_context(context)
        messages = [{"role": "user", "content": [
            {"type": "audio", "url": tmp},
            {"type": "text", "text": text},
        ]}]
        inputs = _proc.apply_chat_template(
            messages, tokenize=True, add_generation_prompt=True,
            return_dict=True, return_tensors="pt",
            processor_kwargs={"audio_kwargs": {"backend": "librosa"}},
        )
        dev = _device or "cpu"
        inputs = {k: (v.to(dev, dtype=torch.bfloat16) if hasattr(v, "to") and v.is_floating_point() else (v.to(dev) if hasattr(v, "to") else v)) for k, v in inputs.items()}
        with torch.inference_mode():
            gen = _model.generate(**inputs, max_new_tokens=256, do_sample=False)
        out_ids = gen[0, inputs["input_ids"].shape[1]:]
        return _proc.tokenizer.decode(out_ids, skip_special_tokens=True).strip()
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 安静
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "ready": _ready})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            self._json(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            audio = data.get("audio", "")
            ctx = data.get("context", "")
            if audio.startswith("data:"):
                audio = audio.split(",", 1)[-1]
            wav = base64.b64decode(audio)
            t0 = time.time()
            text = transcribe_bytes(wav, ctx)
            self._json(200, {"ok": True, "text": text, "ms": int((time.time() - t0) * 1000)})
        except Exception as e:
            self._json(500, {"ok": False, "error": str(e)[:200]})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.getenv("AITI_ASR_GLM_PORT", "8768")))
    args = ap.parse_args()
    # 预启动加载（启动即就绪，父进程 health 等它）
    try:
        load_model()
    except Exception as e:
        print(f"[glm-server] 预加载失败（仍服务，/transcribe 会再试）: {e}", flush=True)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[glm-server] 监听 127.0.0.1:{args.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
