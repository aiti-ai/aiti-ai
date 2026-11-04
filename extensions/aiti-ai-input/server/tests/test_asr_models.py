#!/usr/bin/env python3
"""
ASR 模型综合对比测试（aiti-ai-input）

用**真实语音录音** + **热词**，对比各 2-pass 模型识别效果：
  - Qwen3-ASR-0.6B / 1.7B（context 热词，LLM 系）
  - GLM-ASR-Nano-2512（context/提示词，transformers 原生）
  - Fun-ASR-Nano-2512（hotword= 热词，funasr 系）
  - SenseVoice-Small（quick 参照，无热词）

用法：
  cd server && asr-venv/bin/python tests/test_asr_models.py \
      [--recordings DIR] [--models qwen3-0.6b,qwen3-1.7b,nano,glm,sensevoice] \
      [--hotwords "aiti,devtools,pi,扩展"] [--limit N] [--out report.md]

输出：report（md 对比表）+ report.json（明细），默认 ./tests/report.md
"""
import argparse
import glob
import json
import os
import sys
import time
import wave
from pathlib import Path

# ---- 环境（与线上服务一致：config 读热词/设备）----
DEFAULT_CONFIG = os.path.expanduser("~/.pi/web/data/aiti-ai-input/asr-config.json")
DEFAULT_RECORDINGS = os.path.expanduser("~/.pi/web/data/aiti-ai-input/recordings")
os.environ.setdefault("ASR_CONFIG_PATH", DEFAULT_CONFIG)

# 热词 prompt 前缀（与线上 _hotwords 拼装同款简写）
PROMPT_PREFIX = "术语有："

# 复述检测（模型是否把提示词吐出来）
MARK_REPEAT = ("术语有", "Vocabulary", "以下术语")


def load_wav(path: str):
    """wav → float32 [-1,1] 16k 单声道"""
    with wave.open(path) as w:
        if w.getnchannels() > 1:
            import numpy as np
            return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32).reshape(-1, w.getnchannels()).mean(axis=1) / 32768.0
        return None  # 单声道走快速路径（调用方决定）


def read_wav_float(path: str):
    import numpy as np
    with wave.open(path) as w:
        arr = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        if w.getnchannels() > 1:
            arr = arr.reshape(-1, w.getnchannels()).mean(axis=1)
        return arr


def wav_to_b64_dataurl(arr):
    import base64, io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes((__import__("numpy").clip(arr, -1, 1) * 32767).astype(__import__("numpy").int16).tobytes())
    return "data:audio/wav;base64," + base64.b64encode(buf.getvalue()).decode()


def build_context(hotwords: list[str], prefix: bool = True) -> str:
    if prefix:
        return (PROMPT_PREFIX + "、".join(hotwords) + "。") if hotwords else ""
    return "、".join(hotwords)


def contains_repeat(text: str) -> bool:
    t = (text or "").lower()
    return any(m.lower() in t for m in MARK_REPEAT)


def hit_hotwords(text: str, hotwords: list[str]) -> list[str]:
    tl = (text or "").lower()
    return [w for w in hotwords if w.lower() in tl]


# ==================== 模型加载器（懒加载 + 缓存） ====================
_MODELS = {}


def get_qwen3(model_id: str):
    key = f"qwen3:{model_id}"
    if key not in _MODELS:
        import torch
        from qwen_asr import Qwen3ASRModel
        _MODELS[key] = Qwen3ASRModel.from_pretrained(
            model_id, dtype=torch.float16, device_map="cuda:0", max_new_tokens=256,
        )
    return _MODELS[key]


def get_glm(model_id: str):
    key = f"glm:{model_id}"
    if key not in _MODELS:
        import torch
        from transformers import AutoModel, AutoProcessor
        _MODELS[key] = AutoModel.from_pretrained(model_id, dtype=torch.float16, device_map="cuda:0", trust_remote_code=True)
        _MODELS[f"glm_proc:{model_id}"] = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
    return _MODELS[key], _MODELS[f"glm_proc:{model_id}"]


def get_funasr(model_id: str):
    key = f"funasr:{model_id}"
    if key not in _MODELS:
        from funasr import AutoModel
        _MODELS[key] = AutoModel(model=model_id, device="cuda:0", disable_update=True, trust_remote_code=True, hub="ms")
    return _MODELS[key]


def run_qwen3(model_id, arr, hotwords):
    m = get_qwen3(model_id)
    ctx = build_context(hotwords)
    res = m.transcribe(audio=wav_to_b64_dataurl(arr), language=None, context=ctx or None)
    text = ""
    for r in (res or []):
        if getattr(r, "text", None):
            text += str(r.text)
    return text.strip()


def run_glm(model_id, arr, hotwords):
    import torch
    import tempfile
    m, proc = get_glm(model_id)
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    with os.fdopen(fd, "wb") as f:
        import numpy as np, wave as _w
        with _w.open(f, "wb") as ww:
            ww.setnchannels(1); ww.setsampwidth(2); ww.setframerate(16000)
            ww.writeframes((np.clip(arr, -1, 1) * 32767).astype(np.int16).tobytes())
    try:
        inputs = proc(audio=tmp, text=build_context(hotwords), return_tensors="pt")
        inputs = {k: (v.to(m.device) if hasattr(v, "to") else v) for k, v in inputs.items()}
        with torch.inference_mode():
            gen = m.generate(**inputs, max_new_tokens=256)
        return proc.decode(gen[0], skip_special_tokens=True).strip()
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def run_funasr(nano_hotword, arr, hotwords, language="中文", raw=False):
    """funasr 系：SenseVoice(无热词) / Fun-ASR-Nano(hotword=)"""
    import numpy as np, tempfile
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    with os.fdopen(fd, "wb") as f:
        import wave as _w
        with _w.open(f, "wb") as ww:
            ww.setnchannels(1); ww.setsampwidth(2); ww.setframerate(16000)
            ww.writeframes((np.clip(arr, -1, 1) * 32767).astype(np.int16).tobytes())
    try:
        m = get_funasr(nano_hotword)
        args = {"input": [tmp], "language": language}
        if hotwords:
            args["hotword"] = " ".join(hotwords)
        res = m.generate(**args)
        text = ""
        for seg in (res or []):
            if isinstance(seg, dict) and seg.get("text"):
                text += str(seg["text"])
        if raw:
            return text
        # 剥 SenseVoice 标签（<|zh|> 等）
        import re
        return re.sub(r"<\|[^|]*\|>", "", text).strip()
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


# ==================== 主流程 ====================
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--recordings", default=DEFAULT_RECORDINGS)
    ap.add_argument("--models", default="qwen3-0.6b,qwen3-1.7b,nano,sensevoice")
    ap.add_argument("--hotwords", default="aiti,devtools,pi,扩展,认领,模型,改动,文本")
    ap.add_argument("--limit", type=int, default=0, help="只测前 N 段（0=全部）")
    ap.add_argument("--per-model", action="store_true", help="每模型独立进程（防 780M 多模型 HIP 崩溃）")
    ap.add_argument("--only", default="", help="只测单个模型（per-model 子进程用）")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "report.md"))
    args = ap.parse_args()

    recordings = sorted(glob.glob(os.path.join(args.recordings, "vad_*.wav")))
    if args.limit:
        recordings = recordings[:args.limit]
    hotwords = [w.strip() for w in args.hotwords.split(",") if w.strip()]
    print(f"录音 {len(recordings)} 段 | 热词 {hotwords} | 模型 {args.models}")

    model_ids = {
        "qwen3-0.6b": "Qwen/Qwen3-ASR-0.6B",
        "qwen3-1.7b": "Qwen/Qwen3-ASR-1.7B",
        "glm": "zai-org/GLM-ASR-Nano-2512",
        "nano": "FunAudioLLM/Fun-ASR-Nano-2512",
        "sensevoice": "iic/SenseVoiceSmall",
    }
    want = [m.strip() for m in args.models.split(",") if m.strip()]
    rows = []
    errors = {}

    # ⚠ 780M iGPU 同进程连续加载多模型会 HIP module unload 崩溃（hipModuleUnload failed）。
    #   采用「录音外层 × 模型内层」→ 每模型跑完全部录音后再换下一个模型，并在模型间**显式中断**
    #   （unload 由 gc/torch 处理）；若仍崩，用 --per-model 每模型独立进程（外层 os.execvp 循环）。
    per_model = args.per_model
    if per_model:
        # 每模型单独进程：父进程按模型循环 exec 子进程（--only <model>），结果写独立 json
        import subprocess
        for m in want:
            out_m = str(args.out) + f".{m}.json"
            cmd = [sys.executable, os.path.abspath(__file__),
                   "--recordings", args.recordings, "--hotwords", args.hotwords,
                   "--only", m, "--out", out_m, "--limit", str(args.limit)]
            print(f"== 子进程: {m} ==", flush=True)
            subprocess.run(cmd)
        print("完成（按模型分进程）")
        return

    for idx, path in enumerate(recordings):
        arr = read_wav_float(path)
        dur = len(arr) / 16000
        row = {"file": os.path.basename(path), "dur": round(dur, 2)}
        for name in want:
            key = model_ids.get(name)
            if not key:
                continue
            t0 = time.time()
            try:
                if name.startswith("qwen3"):
                    text = run_qwen3(key, arr, hotwords)
                elif name == "glm":
                    text = run_glm(key, arr, hotwords)
                elif name in ("nano", "sensevoice"):
                    text = run_funasr(key, arr, hotwords if name == "nano" else [], language="中文" if name == "nano" else "auto")
                else:
                    text = ""
            except Exception as e:
                text = ""
                errors[f"{name}:{idx}"] = str(e)[:120]
            row[name] = {
                "text": text,
                "ms": int((time.time() - t0) * 1000),
                "repeat": contains_repeat(text),
                "hit": hit_hotwords(text, hotwords),
            }
            print(f"  [{idx}] {name} {round(time.time()-t0,1)}s → {text[:60]!r}")
        rows.append(row)

    # ---- 写报告 ----
    lines = ["# ASR 模型对比测试报告", ""]
    lines.append(f"- 时间: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"- 录音: {len(recordings)} 段（目录 {args.recordings}）")
    lines.append(f"- 热词: {hotwords}")
    lines.append(f"- 模型: {want}")
    lines.append("")
    lines.append("| 文件 | 时长s | " + " | ".join(w + "（ms/命中/复述）" for w in want) + " |")
    lines.append("|" + "---|" * (2 + len(want)))
    for r in rows:
        cells = [r["file"], str(r["dur"])]
        for w in want:
            if w in r:
                d = r[w]
                text = (d["text"][:28] + "…") if len(d["text"]) > 28 else (d["text"] or "(空/失败)")
                flag = "❗复述" if d["repeat"] else ("✓" + "/".join(d["hit"][:3]) if d["hit"] else "✗不中")
                cells.append(f"{text}<br>{d['ms']}ms {flag}")
            else:
                cells.append("-")
        lines.append("| " + " | ".join(cells) + " |")
    lines.append("")
    if errors:
        lines.append("## 错误")
        for k, v in errors.items():
            lines.append(f"- {k}: {v}")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    Path(str(out) + ".json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n报告: {out} (+ .json)")


if __name__ == "__main__":
    main()
