---
name: asr-server
title: ASR 语音识别服务器（8767）运维
placeholder: ASR 服务器有问题或要配置/重启，帮我检查修复（自动识别 Linux/macOS/Windows）…
outputs:
  format: text
---

# asr-server · 语音识别服务器（8767）运维手册

aiti-ai-input 的实时 ASR：`voice-asr-stream.py`（FastAPI）@127.0.0.1:8767——
`WS /ws/stream`（paraformer-zh-streaming 流式）+ `POST /voice/transcribe`（**Qwen3-ASR-0.6B** 2-pass 精修 + `context=` 模型级热词偏置）。
运行环境：**`asr-venv`**（独立 Python venv，含 Qwen3-ASR + CPU torch + funasr；`start-stream.sh` 优先用它，无则回退 `.venv`）。
与 pi-web 「同进退」：经 aiti-cmd PTY 会话启动（日志在 ⚡命令 面板）；停掉就停掉，下次语音输入
探测（`/asr/ensure`）自动拉起。

## 1. 平台与脚本

| 平台 | 启停脚本（server/ 目录） | 端口检测 | 停止方式 |
|---|---|---|---|
| Linux | `start-stream.sh`（bash） | `ss -tlnp` | `kill -TERM` |
| macOS | `start-stream.sh`（同一个文件，`uname` 分支） | `lsof -iTCP:8767 -sTCP:LISTEN -t` | `kill -TERM` |
| Windows | `start-stream.ps1`（powershell） | `Get-NetTCPConnection`（PS7）/ `netstat -ano` | `taskkill /PID <pid> /T /F` |

扩展端自动按 `process.platform` 选择（win32 → .ps1，其余 → .sh），无需人工切换。

## 2. 配置（配置文件优先，不用环境变量/命令行暴露模型）

`ASR_STREAM_PORT`(8767) · `ASR_MAX_SECONDS`(60)。**模型统一走配置文件**
`~/.pi/web/data/aiti-ai-input/asr-config.json`（ext dataDir）：`{ stream_model, offline_model, max_seconds, model_hotwords_max }`，
服务启动按 `ASR_CONFIG_PATH` 读取（**配置 > env > 默认**）。模型切换走弹窗下拉（写配置+重启）。

**2-pass 可选模型**：`Qwen/Qwen3-ASR-0.6B`（默认 · `context=` 热词）· `FunAudioLLM/Fun-ASR-Nano-2512`（`hotword=`）·
`iic/speech_seaco_paraformer_...`（旧）。Qwen3 用 `context=`，其余用 `hotword=`（`OFFLINE_IS_QWEN3` 自动判别）。
**2-pass 用 `asr-venv` 运行**（`start-stream.sh` 自动选；含 Qwen3-ASR + CPU torch，首次加载 ~15-50s）。
扩展侧：`AITI_ASR_STREAM_BASE`(http://127.0.0.1:8767) · `AITI_ASR_SERVER_DIR`(脚本目录，必指到含 asr-venv 的源码 server/) ·
`AITI_ASR_START_CMD`(自定义启动命令，缺省平台默认)。
依赖：funasr/qwen-asr/pypinyin/rapidfuzz/modelscope/torch CPU；非 wav 音频需 ffmpeg 在 PATH。
模型缓存：Linux/macOS `~/.cache/modelscope/models/`；Windows `%USERPROFILE%\.cache\modelscope\models\`。

## 3. 运行方法

```bash
# 一键（幂等；default=start）
bash <server>/start-stream.sh             # Linux/macOS
powershell -File <server>\start-stream.ps1  # Windows：start|status|stop|restart
# 或经扩展 API（http://<pi-web>/api/extensions/aiti-ai-input/asr/control POST {action: start|stop|restart})
# 自愈：每次按 🎤 探测，未运行自动拉起（aiti-cmd PTY，⚡命令 面板可看实时日志）
```

## 4. 状态检查

```bash
curl -s http://127.0.0.1:8767/health    # ok / stream_loaded / offline_loaded / hotwords / hotwordWorkspaces
# 经扩展：GET /api/extensions/aiti-ai-input/asr/info（含 running/starting/lastError）
#        GET /api/extensions/aiti-ai-input/asr/effective-hotwords（header x-aiti-cwd: <cwd> → 当前 ws 实际生效热词）
```

## 5. 常见问题与解决

| 症状 | 原因 | 处理 |
|---|---|---|
| 语音输入走兑底（不实时出字） | 8767 未运行 | 一键修复 A（启动 + 等健康） |
| health 200 但 `stream_loaded/offline_loaded` false | 模型预热中（首次/重启后 20-60s） | 等待；超 3 分钟查日志（下载中/磁盘满） |
| `hotwords: 0`（热词不生效） | 服务重启后未补推 / feature 关闭 | 一键修复 B（ensure 触发补推）；确认 extman `asr.hotwords.count` > 0 |
| 识别文本前出现乱码前缀（如 extensionsextensions） | 旧版文本级替换 bug（已根除） | 确认 voice-asr-stream.py 是当前版并重启；**不要**恢复 funasr `postprocess_hotwords`（pypinyin 空串 bug） |
| 端口被占 / reload 后孤儿进程 | 会话丢失但进程残留 | `start-stream.sh stop`（按端口精确杀）；或 `/asr/control {action:stop}` |
| 服务起不来 | venv 损坏 / 依赖缺失 / 模型下载失败 | 删 `.venv` 重建（脚本自动 pip install）；日志看 `logs/stream.log` 尾部 |
| 双 workspace 热词串了 | 旧版全局单热词表 | 已是 ws 哈希分套；重启服务 + ensure 补推即恢复 |
| 想看重启后日志 | — | `bash start-stream.sh status` 尾部 5 行；或 ⚡命令 面板该会话流 |

## 6. 一键修复（AI 直接按序执行）

**修复 A（服务未运行 → 拉起并确认健康）**：
1. `bash <ASR_SERVER_DIR>/start-stream.sh status`（或 ps1 status；观察 8767 是否监听）
2. 未监听 → `/asr/control {action:"start"}`（或直接跑脚本 start）
3. 轮询（不要用死循环，用 2s 间隔最多 30 次）`/health`：`ok:true` 且 `stream_loaded:true`；继续等 `offline_loaded:true`
4. 仍失败 → 看 `server/logs/stream.log` 尾部定位（模型下载/内存/端口冲突）→ 修复根因后重复 2-3

**修复 B（热词丢失 → 触发补推并验证）**：
1. `GET /asr/info` → 确认 `hotwordWorkspaces` > 0 且服务 running
2. `POST /asr/ensure`（body `{"cwd":"<目标工作区>"}`，或 header `x-aiti-cwd`）→ 服务端拉取+推送（热词为 0 时无视防抖立即补）
3. 3-5s 后 `GET /asr/effective-hotwords`（同 cwd header）→ count > 0 且用户词在前
4. 仍为 0 → 查 extman `asr.hotwords.count`（0=关闭）；查 session-manager 是否加载（`services.hotwords` 出口，缺席降级空）

**修复 C（更新模型/升级代码后）**：`/asr/control {action:"restart"}` → 修复 A 的 3-4 步验证。

## 7. 验证判据（OK 标准）

- `/health`：`ok:true`、`stream_loaded:true`、`offline_loaded:true`
- 热词开启时：`hotwords` > 0、`hotwordWorkspaces` ≥ 1
- 真机：按住 🎤 出现候选词面板，松手 0.6s 后精修文本上屏且无乱码前缀
