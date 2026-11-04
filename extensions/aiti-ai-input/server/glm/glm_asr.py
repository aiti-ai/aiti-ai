#!/usr/bin/env python3
"""
GLM-ASR-Nano 独立转写脚本（aiti-ai-input 服务端子进程模式）

用法：glm-venv/bin/python glm_asr.py --audio <wav> [--context "术语有：..."] [--max-new-tokens 256]
输出：识别文本（stdout 一行）

依赖独立 venv（setup-glm-venv.sh）：transformers>=5.0 源码 + torch(TheRock) + torchaudio + librosa + accelerate + soundfile
（transformers 5.x 内置 GlmAsrProcessor/GlmAsrForConditionalGeneration——不再依赖官方旧 inference.py 的手工拼 token）
"""
import argparse
import sys

import torch
from transformers import (
    AutoConfig,
    AutoProcessor,
    GlmAsrForConditionalGeneration,
)

_checkpoint = "zai-org/GLM-ASR-Nano-2512"
_model = None
_proc = None


def load():
    global _model, _proc
    if _model is not None:
        return
    device = "cuda" if torch.cuda.is_available() else "cpu"
    _proc = AutoProcessor.from_pretrained(_checkpoint, trust_remote_code=True)
    cfg = AutoConfig.from_pretrained(_checkpoint, trust_remote_code=True)
    _model = GlmAsrForConditionalGeneration.from_pretrained(
        _checkpoint, config=cfg, torch_dtype=torch.bfloat16, trust_remote_code=True,
    ).to(device)
    _model.eval()


def transcribe(audio_path: str, context: str = "", max_new_tokens: int = 256) -> str:
    load()
    device = next(_model.parameters()).device
    # context 热词——官方格式（维护者 Starrylyn #21 回复）：
    #   "这段音频可能包含以下词语：{热词}。请转录这段音频"（提示在前 + 明确"请转录"收尾）
    #   反例（复述）："术语有：… 请优先使用"（无转写指令，模型当输出）
    # 入参 context 若是"术语有：…"前缀 → 转官方句式
    if context and context.startswith("术语有："):
        terms = context[len("术语有："):].rstrip("。")
        text = f"这段音频可能包含以下词语：{terms}。请转录这段音频"
    else:
        text = context if context else "Please transcribe this audio into text"
    # 官方 chat template 用法：messages（audio url + text）→ apply_chat_template
    # （audio 令牌由模板/processor 自动插入；audio_kwargs.backend=librosa 绕开 torchcodec）
    messages = [{"role": "user", "content": [
        {"type": "audio", "url": audio_path},
        {"type": "text", "text": text},
    ]}]
    inputs = _proc.apply_chat_template(
        messages, tokenize=True, add_generation_prompt=True,
        return_dict=True, return_tensors="pt",
        audio_kwargs={"backend": "librosa"},
    )
    inputs = {k: (v.to(device, dtype=torch.bfloat16) if hasattr(v, "to") and v.is_floating_point() else (v.to(device) if hasattr(v, "to") else v)) for k, v in inputs.items()}
    with torch.inference_mode():
        gen = _model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
    out_ids = gen[0, inputs["input_ids"].shape[1]:]
    return _proc.tokenizer.decode(out_ids, skip_special_tokens=True).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--context", default="")
    ap.add_argument("--max-new-tokens", type=int, default=256)
    args = ap.parse_args()
    text = transcribe(args.audio, args.context, args.max_new_tokens)
    print(text)


if __name__ == "__main__":
    main()
