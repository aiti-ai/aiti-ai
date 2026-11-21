---
name: tts-local-install
title: AI 帮我准备/启动/排障本地 TTS 引擎
title.en: "AI: prepare/start/troubleshoot the local TTS engine"
placeholder: 帮我把本地 TTS 服务跑起来，让跟读模式用本机 CPU 合成语音…
placeholder.en: "Get the local TTS service running so follow-read synthesizes on this machine…"
summary: 本地 TTS 服务（Hojo-TTS-Light 40M/80M，OpenAI 兼容）的启动/自举/验证/排障——零手工安装，一条命令自动准备
summary.en: "Start/bootstrap/verify/troubleshoot the local TTS service (Hojo-TTS-Light, OpenAI-compatible) with zero manual installs"
---

# tts-local-install · 本地 TTS 引擎（跟读模式）

你是 aiti-ai-speek（pi-web「跟读模式」扩展）的助手。本地引擎 = 扩展内自带的 Python 服务
（`server/tts-service/`），对外是 **OpenAI 兼容** 的 `POST /v1/audio/speech`，默认监听
`127.0.0.1:8768`（被占用会自动顺延到 8769-8778，实际端口写在 `runtime.json`）。

**铁律：不要给用户“手工下载模型/手工建 venv”的步骤。** `start-tts.sh start` 内部已经
完成 venv → 依赖 → 模型下载 → 校验 → 启动，幂等可重入；只跑这一条。

## 快速路径（首选）

```bash
# 服务目录随扩展部署（源码仓路径：extensions/aiti-ai-speek/server/tts-service）
cd <扩展目录>/server/tts-service
bash start-tts.sh start            # hojo-40m（默认，CPU，17 内置音色）
bash start-tts.sh status
bash start-tts.sh stop
```

- 首次准备约 300MB（Python 3.12 依赖 + 240MB 模型），自动选源：显式 `--hf-endpoint`
  > `HF_ENDPOINT` > 探测 huggingface.co > 探测 hf-mirror.com > 报错并给出代理指引。
- 无外网直连时可用镜像/代理：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 bash start-tts.sh start
bash start-tts.sh start --hf-endpoint https://hf-mirror.com
```

## 通过扩展 API（面板等价路径）

```bash
# 探测 → 不通则自动拉起（含首次自举）
curl -s -X POST http://127.0.0.1:30142/api/extensions/aiti-ai-speek/tts/ensure -H 'content-type: application/json' -d '{}'
# 状态 / 准备阶段 / 日志尾
curl -s 'http://127.0.0.1:30142/api/extensions/aiti-ai-speek/tts/info?log=1'
# 启停
curl -s -X POST .../tts/control -H 'content-type: application/json' -d '{"action":"restart","provider":"hojo-40m"}'
# 音色表（服务未启动返回 []）
curl -s .../tts/voices
```

## 环境要求与已知约束

| 项 | 说明 |
|---|---|
| Python | **3.10-3.12**（Hojo 不支持 3.13）。bootstrap 优先 `uv venv --python 3.12`，其次 `python3.12/3.11/3.10`，都没有则提示装 uv |
| ONNX Runtime | `onnxruntime==1.21.1`（CPU）。GPU 用 `onnxruntime-gpu` 需自行替换，1.25 会破坏 80M decoder |
| 文本归一化 | `WeTextProcessing`（pynini）安装失败**不影响主链**：自动降级为不归一化（数字/单位直接交给模型） |
| 参考音频（克隆） | 3-30 秒、≤10MB；wav 直接收，webm/mp3 需系统 `ffmpeg` |
| 内存 | 40M 峰值 RSS 约 0.75-1.2GB；空闲 30 分钟自动退出（`--idle-timeout`） |
| 端口 | 127.0.0.1:8768（只回环，不对外）；冲突时自动 8769-8778 |

## 验证（改完/装完照做）

```bash
curl -s http://127.0.0.1:8768/health            # status=ready / model_loaded=true
curl -s http://127.0.0.1:8768/voices | head -c 400
curl -s -o /tmp/t.wav -X POST http://127.0.0.1:8768/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{"input":"今天天气不错。","voice":"hojo_zh_f_01","response_format":"wav"}'
# 扩展侧：面板设置 → 引擎=本地 → 状态徽标 ● 运行中；朗读一句应出现 /tts-cache/<sha>.wav
```

## 排障

| 现象 | 处理 |
|---|---|
| `python 3.12 not available` | 装 uv（`curl -LsSf https://astral.sh/uv/install.sh \| sh`）后重跑；或装系统 Python 3.12 |
| 卡在 `download` 阶段 | 查网络：`curl -I https://hf-mirror.com`；用 `--hf-endpoint` 或代理重跑（断点续传，重跑即续） |
| `status=error` / 模型加载失败 | 看 `tts/info?log=1`；常见：模型文件不全（删 `<cache>/tts-service/models` 重跑）、onnxruntime 版本不对 |
| 端口被占 | 脚本自动选 8769-8778；面板 `/tts/info.baseUrl` / `runtime.json` 可看实际端口 |
| 克隆音色报 400 | 需要 `hojo-80m` 或 `qwen3-*` provider（面板切换会自动重启服务）；参考文本必须与音频一致 |
| 面板一直「准备中」 | `prepare.json` 的 `phase` 就是当前阶段；日志尾见 `tts/info?log=1` |
| WebM 录音保存失败 | 系统没有 ffmpeg：`sudo apt install ffmpeg`（或改上传 wav） |
