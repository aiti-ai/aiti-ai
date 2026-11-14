# @aiti-ai/aiti-ai-input

> AI 聊天输入框输入增强：两层自动补全（本地秒出 → AI 兜底）、语音输入检测 + 拼写修复、流式 ASR + 2-pass 精修、可切换识别引擎（自建 / 讯飞 / 百度 / 硅基流动 / 任意 OpenAI 兼容端点）、热词系统、用量报表。

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

## 功能

### 自动补全（L0 本地秒出 → L1 AI）

打字静止 700ms 且光标在末尾 → 灰字显示下一句（Tab/→ 接受，Esc/继续打字取消）。两层：

- **L0 本地层（零模型秒出）**：输入静止后先查本地——收藏 prompt + 会话历史输入，服务端前缀匹配（`POST /complete` `mode=local`）。命中即灰字直出 + **↦收藏/↦历史 角标**，不请求 AI。
- **L1 AI 层**：仅 L0 未命中才请求同款模型小请求。
- 治理走 extman 功能管理：`autocomplete.enabled` 总开关 · `autocomplete.localOnly`（只跑 L0，零出网）· `autocomplete.minChars` · 上下文预算。

### 语音输入（听写检测 + 拼写修复 + L2 ASR）

1. **检测语音输入与高速输入**（系统输入法听写 / 连续快速粘贴式整句上屏）——纯浏览器事件特征（`beforeinput` inputType + `getTargetRanges` + 节奏），零服务端依赖；
2. 检测到 → 输入框上方显示「🎤 识别到快速大量输入 · 正在帮你检查修复转写错误」标记条（可 ✕ 删除）；
3. 发送时对输入做**拼写修复**（语音/高速输入产生的错字/音译词/重复词，AI 修复后仅当有歧义才给替换建议）；
4. **L2 ASR 保底**：浏览器录音（webm/opus，≤60s）→ `/voice/transcribe` → 服务端转写 → 文本回填；
5. **实时流式识别 + 2-pass 精修（🎤 主路径）**：按住 🎤 说话 → PCM 经 WebSocket 发自建流式服务（paraformer-zh-streaming，600ms 级低延迟）。实时出字默认关（流式模型质量考虑）；录音结束即调离线 2-pass 模型（Qwen3-ASR-0.6B / Fun-ASR-Nano / seaco，弹窗下拉切换）精修后立即写入输入框。
   - 上屏格式：录入结束自动补句号（随界面语言）；在光标处插入（有选区则替换），光标落到新文本后。
   - 入口总闸：`voice.enabled`（🎤 按钮，默认关）· `toolbar.enabled`（工具条 🎙️ 管理弹窗入口，默认关）。

### 语音识别引擎可切换

| 引擎 id | 说明 | 实测时延（4s 中文） |
|---|---|---|
| `builtin` | 自建（FunASR/Qwen3/GLM）：真流式 + 模型级热词 + 2-pass | 本机 GPU 秒级——有本地算力时最优 |
| `xfyun` | 讯飞听写 iat——真流式（客户端 WS → 本地桥 → 讯飞 WSS；松手一次性提交兜底） | 0.3–2.6s |
| `baidu` | 百度短语音识别 REST（token 30 天缓存） | 0.3–0.7s |
| `siliconflow` | 硅基流动 SenseVoiceSmall | 27–82s（排队慢，仅兜底） |
| `openai` | 任意 OpenAI 兼容端点（填 `baseUrl`+`model`，自动补 `/audio/transcriptions`）——如 Groq `whisper-large-v3-turbo` | 取决于端点 |

Groq：console.groq.com 注册建 key，用 `openai` 引擎填 `https://api.groq.com/openai/v1` + `whisper-large-v3-turbo`（免费额度，无需改代码）。Azure：建 Speech 资源（Free F0），密钥+区域走 `azure` 引擎。

云引擎下 WS/热词/启停自动门控，客户端链路不变（本地 VAD 切句 → 逐句快识 → 整段精修）。

### 热词系统

- **自动热词**：session-manager 从 All Sessions 索引提取（关注路径 + 全局术语，四档 × `asr.hotwords.count`，用户热词最优先），时间加权 + 缓存。
- **workspace 粒度**：ASR 服务按 workspace 哈希分套存储热词——多 workspace 并行互不冲突；模型级热词（Qwen3 走 `context=`、Fun-ASR-Nano/seaco 走 `hotword=`）。
- **用户热词**：`GET/PUT /api/extensions/aiti-ai-input/asr/user-hotwords`（上限 500，与自动词合并、最优先）。

### 管理弹窗与用量报表

工具条 🎙️ 打开「语音识别引擎管理」（三段式）：引擎切换卡片、引擎配置（字段由后端元信息驱动，secret 只回显尾 4 位；🩺 测试连接发 1s 静音走一遍引擎验证 key/网络）、按天用量统计（请求数/音频时长/错误数/估算费用）。SVG 详细报表（📊）含 KPI 卡、近 30 天按引擎堆叠柱、按引擎/链路明细（数据保留 90 天）。

## 自建流式 ASR 服务

```bash
cd server
bash start-stream.sh              # start（幂等）· status / stop / restart
powershell -File start-stream.ps1 # Windows 对应
```

- 环境变量：`ASR_STREAM_PORT`(8767) · `ASR_MAX_SECONDS`(60)。模型统一走配置文件 `~/.pi/web/data/aiti-ai-input/asr-config.json`（`stream_model`、`offline_model` 等），不走命令行。
- 2-pass 离线模型：`Qwen/Qwen3-ASR-0.6B`（默认 · 52 语种+22 中文方言 · 标点/术语大写 · `context=` 热词）、`FunAudioLLM/Fun-ASR-Nano-2512`（更快 · `hotword=`）、seaco paraformer（旧）。
- **自愈**：每次按 🎤 经 `/asr/ensure` 探测，不通时自动拉起（经 aiti-cmd PTY）；不做 systemd 托管。管理端点：`POST /asr/control {action: start|stop|restart}`。

配置（写盘即时生效，无需重启）：

```bash
# 读（key 脱敏：只回 configured + 尾 4 位）
curl -s http://127.0.0.1:3001/api/extensions/aiti-ai-input/asr/config
# 写：配 key 并切引擎（空串 = 删除该项）
curl -s -X POST http://127.0.0.1:3001/api/extensions/aiti-ai-input/asr/config \
  -H 'content-type: application/json' \
  -d '{"provider":"siliconflow","providers":{"siliconflow":{"apiKey":"sk-...","model":"FunAudioLLM/SenseVoiceSmall"}}}'
```

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-ai-input/` 后 reload。流式 ASR 服务（可选，`builtin` 引擎用）在本包 `server/` 目录。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-ai-input.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-ai-input.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
