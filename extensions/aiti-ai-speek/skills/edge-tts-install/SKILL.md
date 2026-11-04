---
name: edge-tts-install
title: AI 帮我安装/验证 edge-tts 后端（各平台）
placeholder: 帮我在当前机器上安装 edge-tts，让跟读模式用更自然的语音…
summary: 各平台（Linux/macOS/Windows）安装 edge-tts + 验证 + 启用 + 排障，让 aiti-ai-speek 跟读模式用上服务端音质
---

# edge-tts-install · 给 aiti-ai-speek 安装后端语音引擎

你是 aiti-ai-speek（pi-web「跟读模式」扩展）的助手。edge-tts 是微软 Edge 的服务端语音合成
（GitHub `rany2/edge-tts`），音质比浏览器 Web Speech 更自然。本扩展用它做高音质档：已安装即
**默认优先**（引擎=自动），未装则回落浏览器本地朗读。

## 运行前必读：约定与判定

- 扩展服务端会**自动探测** edge-tts 可执行文件，路径判定顺序：
  1. feature `tts.edge.bin`（用户/你在设置面板或 extman 里填的路径，留空=自动）
  2. `~/.local/bin/edge-tts`（Linux/macOS 常用）
  3. `PATH` 里的 `edge-tts`（`which`/`where`）
  4. `~/.local/pipx/venvs/edge-tts/bin/edge-tts`（pipx 安装）
- 安装后**无需重启 pi-web**：`GET /api/extensions/aiti-ai-speek/voices` 会重新探测；你装完后调它验证即可。
- 首次探测到已装 → 扩展自动开启 `tts.edge` feature（只开一次，之后用户显式关掉不会被覆盖）。
- 改路径 feature 用：`POST /api/extensions/aiti-ai-speek/feature` `{ id: "tts.edge.bin", value: "<路径>" }`。

## 判定平台

用 `uname -s`（Linux=`Linux`、macOS=`Darwin`）或 `process.platform`（Windows=`win32`）。
先查有没有 Python/pip：`python3 --version`；优先用 pipx（隔离环境，最省心），其次 uv，最后 pip。

## 各平台安装

### Linux

```bash
# 推荐：pipx（隔离，入口落在 ~/.local/bin/edge-tts）
sudo apt-get install -y pipx 2>/dev/null || sudo dnf install -y pipx 2>/dev/null || true
pipx ensurepath && pipx install edge-tts

# 或 uv tool
uv tool install edge-tts   # 需先装 uv：curl -LsSf https://astral.sh/uv/install.sh | sh

# 或 pip（user 级，注意 PATH 需含 ~/.local/bin）
python3 -m pip install --user edge-tts
```

### macOS

```bash
brew install edge-tts          # 最省心（Homebrew 有包）
# 或
pipx install edge-tts          # 需先：brew install pipx && pipx ensurepath
```

### Windows

```bash
# PowerShell（任选其一）
pip install edge-tts           # 装到当前 Python 的 Scripts 目录
pipx install edge-tts          # 需先装 pipx：python -m pip install --user pipx
```

Windows 注意：Scripts 目录通常不在 `~/.local/bin`。装完后用 `where edge-tts` 拿到绝对路径，
若扩展探测不到，就把它写进 feature：

```bash
# 在 pi-web 会话里（或让扩展设置面板「edge-tts 路径」框填入）
POST /api/extensions/aiti-ai-speek/feature { "id": "tts.edge.bin", "value": "C:\\Users\\<你>\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\edge-tts.exe" }
```

## 验证（装完必做）

```bash
edge-tts --version          # 期望输出 edge-tts 7.x.x
edge-tts --list-voices | head -20   # 能看到 zh-CN 音色表
curl "http://127.0.0.1:<pi-web端口>/api/extensions/aiti-ai-speek/voices"   # installed:true 即生效
```

## 排障对照表

| 症状 | 原因 | 处理 |
|---|---|---|
| `edge-tts: command not found` | 未装 / PATH 未含安装目录 | 按上面对应平台装；`pipx ensurepath` 后重开 shell |
| 合成报网络/403/超时 | 机器不通微软 edge 端点，或需代理 | 浏览器本地朗读先兜底；配置代理环境变量后重试 |
| `GET /voices` 返回 `installed:false` 但 `edge-tts` 能跑 | 扩展探测不到该路径 | 把 `which edge-tts` 的绝对路径写入 feature `tts.edge.bin` |
| 合成慢/卡 | 首次合成要发网络请求 | 属正常，已加 SHA-256 缓存；重复句秒回 |

## 收尾

装好并验证后，告诉用户：跟读设置里「后端引擎」会显示「● 已安装」，引擎选「自动」即默认用它；
音色下拉每切一个都会试读一句「我是 xxx，期待为你服务」。