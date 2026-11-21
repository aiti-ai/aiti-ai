---
name: tts-local-install
title: 本地 TTS 服务：怎么开启、配置、排障
title.en: "Local TTS service: enable, configure, troubleshoot"
placeholder: 帮我把本地语音服务打开（或查一下为什么没声音），我只要能用就行…
placeholder.en: "Turn on the local voice service for me (or find out why there is no sound) — I just need it to work…"
summary: 跟读模式的本地语音引擎（Hojo-TTS-Light 40M/80M）怎么在设置面板一键开启、第一次要下什么、没声音/启动失败怎么修；用户零命令
summary.en: "How to enable the local voice engine (Hojo-TTS-Light 40M/80M) from the settings panel, what the first run downloads, and how to fix no-sound / start failures — zero commands for the user"
outputs:
  format: text
---

# tts-local-install · 本地 TTS 服务（跟读模式 aiti-ai-speek）

> **给用户的第一句话永远是：不用敲命令。** 设置面板里选中「本地」引擎，剩下的（Python 环境、
> 依赖、模型下载、启动）都由扩展自动完成；首次约 300MB，之后秒起，空闲 30 分钟自动退出。

## 0. 直接告诉用户怎么开（默认回答）

1. 打开 **跟读设置**（播放条的 ⚙，或工具栏 🔊 旁的设置入口）；
2. **引擎** 一行选「**本地**」；
3. 等状态徽标变成 **● 运行中**（首次会显示进度：Python 环境 → 依赖 → 模型下载 → 加载，约 300MB）；
4. **音色** 下拉里选择声音，点一下可试听。

想「装好就有声」→ 用 **Hojo 40M**（内置 17 个音色，中文 4 个，CPU 比实时快）。
想「像我自己的声音」→ 切 **Hojo 80M**，它**没有内置音色**，必须先在「音色管理」新建一个克隆音色
（3-30 秒录音 + 转录）。细节见 `tts-voice-setup` 技能。

如果服务起不来，面板里已经有失败原因、阶段进度、日志尾和一条可复现命令——先按 §3 排障，
不要把用户打发去命令行。

## 1. 我能替用户做的（AI 动作）

面板按钮的后端就是这几个接口（**当前实例** dev 30142 / prod 20341，经宿主 basePath）：

| 目的 | 调用 |
|---|---|
| 看状态（含准备阶段/端口/pid/RTF/RSS/日志尾） | `GET /api/extensions/aiti-ai-speek/tts/info[?log=1&sizes=1]` |
| 引擎可用性快照 | `GET /api/extensions/aiti-ai-speek/engine-status` |
| 探测 → 不通则自举并启动 | `POST /api/extensions/aiti-ai-speek/tts/ensure` `{}` |
| 启动 / 停止 / 重启（可指定 provider） | `POST .../tts/control` `{"action":"start"\|"stop"\|"restart","provider":"hojo-40m"}` |
| 准备进度（SSE，无轮询） | `GET .../tts/progress` |
| 直接合成一句（验证链路/试听） | `GET .../tts?engine=local&text=...&voice=...` |

`POST /tts/ensure` 返回 `{running:true}`（已就绪）或 `{starting:true}`（正在准备，进度看 SSE）。
自举可能需要几分钟（下载 240-458MB），期间不要重复点击、不要重启 pi-web。

## 2. provider 怎么选

| provider | 依赖 | 磁盘 | 音色 | 本机 CPU 实测 | 适合 |
|---|---|---|---|---|---|
| **hojo-40m**（默认） | onnxruntime（自动装） | ~240MB 模型 + ~1.3GB venv | 17 内置（中 4 / 英 13） | RTF ≈0.31-0.34（3s 音频约 1s） | 日常跟读，装好即用 |
| hojo-80m | + librosa/scipy | ~437MB + venv | **只有克隆** | RTF ≈1.05、RSS≈2.2GB | 想要自己的音色 |
| qwen3-0.6b / 1.7b | **需自装 torch + qwen-tts** | 2.5GB 权重（首次加载时下） | 克隆（CustomVoice） | 未验（建议 GPU） | GPU 机器上的质量档 |
| stub | 无 | 无 | 3 个测试音 | 即时 | 排障：确认播放/缓存链路 |

切换 provider 会自动重启服务（面板会提示）；音色 id 在不同 provider 间不通用，切完请重选音色。

## 3. 排障（症状 → 处理）

| 症状 | 处理 |
|---|---|
| 最小镜像（Docker/Alpine-like）没有 python3.12 或 uv | 不用管：bootstrap 会自动装 uv 并 `uv python install 3.12`（需要 curl 或 wget + 外网）；装了多个 Python 时优先用 venv 可用的那个 |
| 依赖安装很慢/卡住 | 会自动测速选 pip 镜像（官方 → 阿里云 → 清华，取最快）；也可 `AITI_TTS_PIP_INDEX=<url>` 指定 |
| 首次准备卡在 `download` | 网络/镜像问题。面板「重启」会断点续传；仍失败则让用户配代理或换源（见 §4），**不要手工下模型** |
| `status=error` / 启动失败 | 看 `tts/info?log=1`；模型文件损坏就删 `<cache>/tts-service/models` 后重启（会自动重下）；onnxruntime 版本不对也在这里暴露 |
| 面板一直「准备中」 | `prepare.json` 的 phase 就是当前阶段；超过 10 分钟先看日志尾，再决定重启 |
| 没有声音但显示 ● 运行中 | ① 先看音色是否为空（切到 80M 时会发生）→ 引导新建克隆音色；② 试听一句验证；③ 看 `tts/info.health.requests` 是否在涨 |
| 提示「本地语音未就绪」 | 服务被空闲退出或崩溃：点「检查/准备」或朗读一次即自动再起（扩展会 ensure 一次） |
| 端口 8768 被别的进程占用 | 启动脚本会自动顺延到 8769-8778，实际端口见 `tts/info.baseUrl` 与 `runtime.json` |
| 手机上没有 Web Speech | 扩展会自动改用服务端引擎（edge 或本地），不影响使用 |

## 4. 首次准备/网络（只在 AI 自己排查时用）

启动脚本 `server/tts-service/start-tts.sh start` 内部完成 venv → 依赖 → 模型（`snapshot_download`，
自动选源：显式 `--hf-endpoint` → `HF_ENDPOINT` → 探测 huggingface.co → 探测 hf-mirror）。
用户侧不需要这些命令；如确需手动验证：

```bash
cd <扩展目录>/server/tts-service
bash start-tts.sh status                 # 运行状态 + 日志尾
HTTPS_PROXY=http://127.0.0.1:7890 bash start-tts.sh start   # 有代理时
bash start-tts.sh start --hf-endpoint https://hf-mirror.com # 指定镜像
bash start-tts.sh stop
```

## 5. 环境与资源约束

| 项 | 说明 |
|---|---|
| Python | **3.10-3.12**（Hojo 不支持 3.13）；bootstrap 优先 `uv venv --python 3.12` |
| 端口 | 127.0.0.1:8768，只回环；占用则顺延 8769-8778 |
| 空闲退出 | 默认 1800 秒（面板可改，0 = 常驻）；退出后下次使用自动再起 |
| 内存 | 40M ≈0.95GB、80M ≈2.2GB（含 fp32 提升）；低配机器优先 40M |
| 磁盘 | 40M：模型 241MB + venv 0.98GB（含文本归一化 pynini ~0.7GB；面板关闭「文本归一化」后 **0.26GB**）+ uv/Python 0.11GB；再加 80M 约 +0.44GB（venv 共享） |
| 日志 | `<cache>/tts-service/logs/tts.log`（面板「查看日志」/ 经 aiti-cmd 启动时也在 ⚡命令 面板） |

## 6. 跨扩展接口（别的扩展要“临时说一句”）

```js
// 浏览器端：一次性播报（会在失败时自动弹设置面板）
const speak = ctx.getExtService("aiti-ai-speek.speak");
await speak.speak("构建完成了", { engine: "local" });
speak.follow(true);          // 临时开关跟读
speak.openSettings();        // 排障入口

// 服务端：合成到缓存（后端流水线）
const tts = ctx.services.get("aiti-ai-speek.tts");
await tts.ensure({});
const { items } = await tts.synthesize({ texts: ["第一句"] });
const file = await tts.readCached(items[0].key); // { buffer, ext, contentType }
```
