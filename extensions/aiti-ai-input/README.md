# AI input（aiti-ai-input）

AI 聊天输入框的输入增强扩展（**长期保留，非临时测试**）。

## 当前能力（语音来源标记 + 自动补全 + 收藏联想 + L2 ASR + 热词系统）

### 自动补全（L0 本地秒出 → L1 AI）

打字静止 700ms 且光标在末尾 → 灰字显示下一句（Tab/→ 接受，Esc/继续打字取消）。**两层**：

- **L0 本地层（零模型秒出）**：输入静止后**先查本地**——收藏 prompt + 会话历史输入，服务端
  `POST /complete` 的 `mode=local` 做**前缀匹配**（输入尾段最长后缀 vs 候选 name/text 前缀）。
  命中即灰字直出 + **↦收藏/↦历史 角标**，**不请求 AI**——本地先上，不等 AI 结果一起。
- **L1 AI 层**：仅 L0 未命中才请求同款模型小请求（0.4–2s 后出灰字，在途时灰字先空着）。
- 治理走 extman 功能管理：`autocomplete.enabled` 总开关 · `autocomplete.localOnly`（只跑 L0，0 出网）·
  `autocomplete.minChars` 最小字符数（默认 3）· ctx 三档上下文预算。

### 语音输入（系统输入法听写检测 + L2 ASR）

1. **检测语音输入与高速输入**（系统输入法听写 / 连续快速粘贴式整句上屏）——
   纯浏览器事件特征（`beforeinput` inputType + `getTargetRanges` + 节奏），零服务端依赖；
2. 检测到 → 输入框上方（`chatInputTop`）显示「🎤 识别到快速大量输入 · 正在帮你检查修复转写错误」标记条，**用户可 ✕ 删除**；
3. 保留 → 发送/上屏时对输入做**拼写修复**（语音或高速输入产生的错字/音译词/重复词，AI 修复后仅当有歧义才给替换建议）；
4. **L2 ASR 保底路径**：浏览器录音（webm/opus，≤60s）→ `/voice/transcribe` → 服务端转写 → 文本回填；
5. **实时流式识别 + 候选词 + 2-pass 精修（🎤 主路径，v0.4.0 起）**：按住 🎤 说话 → 浏览器实时采 PCM 经
   WebSocket 发 `voice-asr-stream.py`（paraformer-zh-streaming 流式，600ms 级低延迟）。**实时出字默认关**
   （`asr.streaming=false`——CPU 流式模型质量差）+ **2-pass 精修无延迟上屏**（`PASS2_DELAY_MS=0`）：
   录音结束即调离线 2-pass 模型（**Qwen3-ASR-0.6B / Fun-ASR-Nano / seaco** 可选，弹窗下拉切换）精修后
   立即写入输入框，不等 0.6s；兑底链：WS 不可用 → 整段 webm 直发 8767 Qwen3-ASR（voice-asr2，同样 GPU 加速）。
   - **上屏格式**：录入结束自动补句号（随界面语言——中文 `。` / 英文等 `.`，已带句末标点不重复）；不自动换行，**在光标处插入**（有选区则替换选区），插入完光标落到新文本后面；未聚焦且无可靠光标位时退到文末追加。
   - 治理：extman features `asr.streaming`（默认关）· `asr.pass2`（默认开）· `asr.model.stream` · `asr.model.offline`。
   - **入口总闸（顶级，不分组）**：`voice.enabled`（🎤 语音输入按钮是否挂载，未测好默认关）·
     `toolbar.enabled`（顶部工具条 🎙️ 管理弹窗入口，默认关；旧 `asr.hotwords.panel` 已改名并自动迁移）。

### 语音识别引擎可切换（v0.5.0+ · 自建 8767 只是其中一种）

引擎层 `asr-providers.ts`（`docs/aiti-ai-input-asr-provider-plan.md`）四引擎同为一等公民：

| 引擎 id | 说明 | 实测时延（4s 中文） | 状态 |
|---|---|---|---|
| `builtin` | 自建 8767（FunASR/Qwen3/GLM）：真流式 + 模型级热词 + 2-pass | 本机 GPU 秒级 | ✅ 有本地算力时最优 |
| `xfyun` | 讯飞听写 iat —— **真流式**（客户端 WS → 本地桥 `xfyun-bridge.mjs`:8768 → 讯飞 WSS；松手走一次性提交兜底） | **0.3–2.6s**（流式 5.0s 出首句） | ✅ **当前默认** |
| `baidu` | 百度短语音识别 REST（token 30 天缓存） | 0.3–0.7s | ✅ 已可用（曾报 3305 缺额度，现已解除） |
| `siliconflow` | 硅基流动 SenseVoiceSmall | 27–82s | ❌ 排队太慢，仅兜底 |
| `openai` | 任意 OpenAI 兼容端点（自建/代理/其它云，填 `baseUrl`+`model`，自动补 `/audio/transcriptions`） | 取决于端点 | ✅ 已实施 |

云引擎下 WS/热词/启停自动门控（`/asr/control` 拒绝、热词面板显示「当前引擎不支持」），客户端链路不变
（本地 VAD 切句 → `/voice-quick` 逐句 → `/voice-asr2` 精修）。兑底音源已改 WAV（云引擎不吃 webm）。

- **语音流量统计报表**（`client/src/usage-report.tsx`，形态对齐 aiti-ai-usage：零依赖手写 SVG）
  - 入口：面板用量卡里「📊 详细报表」按钮 · 左栏 dock 区块「语音流量」· 右栏 tab · extman 的 `aiti-asr-usage-report` 弹窗
  - 内容：**KPI 卡**（今日 / 近 7 天 / 累计的 请求数·音频分钟·估算费用）· **近 30 天堆叠柱**（按引擎分色、图例可切显隐、悬浮显数值）·
    **按引擎明细**（累计/今日/错误 + 单价元/分钟 + 估算费用）· **按链路模式**（quick 分句快识 / final 整段精修 / vad 真流式会话）
  - 数据：`GET /asr/usage/series?days=30` 一次拉全（不分块多请求）；**本地日**口径（与 aiti-ai-usage 一致），
    只保留 90 天；存 `stateDir/asr-usage.json`（不可再生 → state 层）
  - 单测：`asr-usage.test.mjs`（6 例）——本地日/模式聚合/旧格式迁移/90 天滚动/单价/reset

**接入方式**
- **Groq**：https://console.groq.com 注册 → API Keys → Create（`gsk_...`）→ 用 `openai` 引擎填
  端点 `https://api.groq.com/openai/v1` + 该 key + 模型 `whisper-large-v3-turbo`（免费额度，无需改代码）。
- **Azure**：https://portal.azure.com 建 **Speech** 资源（Free F0，5 小时/月；区域 eastasia/southeastasia）
  → 「密钥和终结点」取 **密钥 1** 与 **区域** → 用 `azure` 引擎填密钥/区域/`zh-CN`。
  ⚠ 本机实测 `*.stc.speech.microsoft.com` **连不通**（curl 返回 000），需能直连 Azure 的网络环境。

> **e2e 实测**：五引擎逐个跑真音频（日常句 + 中英 IT 术语混说 × quick/asr2 两入口）**全部真识别出文本**，
> 逐条结果见 `docs/aiti-ai-input-asr-provider-plan.md` §十。
> **讯飞真流式**：宿主扩展不能自己终止 WebSocket（只有 middleware rewrite），所以扩展在**自己进程内**
> 起一个 WS 服务（`xfyun-bridge.ts`，`node:http` + upgrade，零依赖），监听 127.0.0.1:8768，
> middleware 把 `/aiti-ai-input/asr/ws/vad` rewrite 过去；桥只做 HMAC 签名 + PCM 转发，不做推理、不起子进程。
> `POST /asr/ensure` 幂等（已在跑就复用），server 挂 `globalThis.__aitiXfBridge` → 扩展 reload 后复用旧监听器；
> 凭据每条会话现读，改 key 即时生效。协议与自建 8767 的 /ws/vad 一致 → 客户端零改动。
> **端口随机**（`listen(0)`）：每个 pi-web 实例各起各的桥，同机 dev/prod 不可能抢端口（早期固定 8768
> 导致第二个实例报「端口被占用」已修）；实际端口可从 `/asr/ensure` 或 `/asr/info` 的 `bridgePort` 看到，
> 调试要固定端口就设 env `AITI_XF_BRIDGE_PORT`。

> builtin 必须走扩展自愈/`/asr/control` 启动（带 `AITI_ASR_VENV_DIR=cache/asr-venv`）；
> 手工 `bash start-stream.sh` 会落到源码目录 `.venv`（缺 `qwen-asr` → 2-pass 加载失败）。

配置（M2 管理面板落地前走接口；写盘即时生效，无需重启）：

```bash
# 读（key 脱敏：只回 configured + 尾 4 位）
curl -s http://127.0.0.1:3001/dev/api/extensions/aiti-ai-input/asr/config
# 写：配 key 并切引擎（空串 = 删除该项）
curl -s -X POST http://127.0.0.1:3001/dev/api/extensions/aiti-ai-input/asr/config \
  -H 'content-type: application/json' \
  -d '{"provider":"siliconflow","providers":{"siliconflow":{"apiKey":"sk-...","model":"FunAudioLLM/SenseVoiceSmall"}}}'
```

### 热词系统（v0.4.2+）

- **自动热词**：session-manager 从 All Sessions 索引提取（关注路径中文/英文 + 全局中文/英文，**四档 ×
  `asr.hotwords.count`（默认 100，每档数量，总上限约 400）**，按序去重）——**用户热词最优先** → 关注路径 →
  全局；异步分块提取（每 4000 条让出事件循环，不阻塞请求）；时间加权 + 10min 缓存。
- **workspace 粒度**：8767 服务按 **workspace 哈希 key**（cwd/关注路径 sha1 前 12 位）分套存储热词——
  多 workspace 并行互不冲突；2-pass 模型级热词：**Qwen3 走 `context=`**、**Fun-ASR-Nano/seaco 走 `hotword=`**
  （非文本级替换——后者有 pypinyin 空串 bug 已弃用）；全链不见文件路径（cwd 走 header/body，日志干净）。
- **用户热词**：`GET/PUT /api/extensions/aiti-ai-input/asr/user-hotwords`（上限 500，用户词与自动词合并、最优先）。
- **管理弹窗「语音识别引擎管理」**（工具条 🎙️，顶级开关 `toolbar.enabled` 默认关——extman 打开后出现；
  旧 id `asr.hotwords.panel` 已退役，startup 自动迁移旧设置）——**三段式**：
  1. **引擎切换**：四引擎卡片（label + 能力标签「真流式/热词/2-pass」+ 是否已配置），点即切（`POST /asr/config {provider}`）；
  2. **引擎配置**：当前引擎的参数表单（字段由后端 `fields` 元信息驱动，secret 只回显尾 4 位、留空=不改）
     + **🩺 测试连接**（`POST /asr/test`——服务端发 1s 静音音频走一遍引擎，不说话也能验 key/网络/耗时）；
     builtin 时此处显示 8767 状态/启停（`POST /asr/control`）/模型下拉/热词统计/用户热词编辑·导入·导出
     （`GET /asr/effective-hotwords`）——热词与用户热词卡在云引擎下标「不生效」；
  3. **用量统计**：按天记录每引擎的 **请求数 / 音频时长 / 错误数 / 最近使用**（报表见下），可填「单价（元/分钟）」自动估算费用，
     可清空（`GET|POST /asr/usage`；数据落 `stateDir/asr-usage.json`，属不可再生数据）。
     口径：`voice-quick`/`voice-asr2` 每次请求计 1 次；真流式会话结束计 1 次；时长按 16k/16bit 折算（估算）
  4. **通用配置**：与引擎无关的链路开关（`asr.streaming`/`asr.vad`/`asr.split`/`asr.pass2`）+ 环境变量入口。
  弹窗按 aiti-float 契约（拖拽/缩放/持久化 + 小屏全屏 + 自动高度）。
- **AI 运维**：skills `asr-server`（分平台配置/运行/排障/一键修复，ai-helper 聚合）。

与 `[发自: pageId · url]` 来源标注并列、各自幂等清理，互不干扰。

## 设计 / 方案文档

- 语音完整方案（流式 + 2-pass + 自愈 + 热词 + 跨平台）：`docs/aiti-voice-input-realtime-asr-plan.md`
- 热词提取与消费（session-manager + 8767 + 弹窗）：`docs/session-manager-hotwords-api.md`
- 完整版设计（🎤 按钮 + Web Speech API / L2 ASR + 三级纠错管线 + diff 确认 UI）：
  `docs/aiti-voice-input-plan.md`

## 部署

```bash
node tools/deploy.mjs              # 拷贝 index.ts + client + skills → ~/.pi/web{,-dev}/extensions/aiti-ai-input/
# 生效：POST /api/extensions/reload；client no-store 刷新页面即新
```

### 实时流式 ASR 服务（8767）· 一键脚本 + 自愈（主路径）

```bash
cd pi-web-ext/aiti-ai-input/server
bash start-stream.sh          # 默认 start：幂等（已在运行则跳过）；Linux/macOS 通用（uname 分支：macOS 用 lsof）
powershell -File start-stream.ps1  # Windows 对应（status/stop/restart 同语义）
bash start-stream.sh status / stop / restart
```

环境变量：`ASR_STREAM_PORT`(8767) · `ASR_MAX_SECONDS`(60)。**模型不在环境变量/命令行**——统一走配置文件
`~/.pi/web/data/aiti-ai-input/asr-config.json`（ext dataDir）：`{ stream_model, offline_model, max_seconds, model_hotwords_max }`，
服务启动按 `ASR_CONFIG_PATH` 读取（配置 > env > 默认），避免进程列表泄漏模型。**2-pass 在 `asr-venv`**
（独立 Python 环境，含 Qwen3-ASR + CPU torch + funasr）运行——`start-stream.sh` 优先用 `asr-venv`，无则回退 `.venv`。

**2-pass 模型（弹窗下拉可切，切换写配置+重启生效）**：
- `Qwen/Qwen3-ASR-0.6B`（默认 · 52 语种+22 中文方言 · 标点/术语大写 · `context=` 热词）
- `FunAudioLLM/Fun-ASR-Nano-2512`（中英日+方言 · 术语合成好 · `hotword=` · 更快）
- `iic/speech_seaco_paraformer_...`（旧 · 无标点 · 仅保留）
流式 1-pass 始终 paraformer-zh-streaming（实时出字不变；`asr.streaming` 默认关）。

扩展侧：`AITI_ASR_STREAM_BASE` · `AITI_ASR_SERVER_DIR` · `AITI_ASR_START_CMD`（按 `process.platform` 自动选 .sh/.ps1）。

**自愈（同进退模型）**：每次按 🎤 经 `/asr/ensure` 探测 8767，不通时经 aiti-cmd PTY 自动拉起
（日志在 ⚡命令 面板）；停掉就停掉，下次语音自动再拉起；不做 systemd 托管。
管理端点：`POST /asr/control {action: start|stop|restart}`（stop 优先按平台脚本杀端口，兜底会话 kill；
覆盖 reload 后孤儿进程）。

验证：`bash -c 'asr-venv/bin/python test_asr_stream.py && asr-venv/bin/python test_ws_proxy.py'`

## 验证（手机浏览器）

1. 手机访问 pi.example.com:8443（或 /dev/）→ 打开任意会话；
2. 按住 🎤 说话 → 松手即精修（无延迟）+ 标点/术语大小写正确（Qwen3/Fun-ASR-Nano）；
   （🎤 按钮由顶级开关 `voice.enabled` 控制，未测好默认关——extman 打开后输入框上才出现按钮）
3. extman 打开「语音识别服务器管理」（顶级 `toolbar.enabled`）→ 工具条 🎙️ → 弹窗内
   状态/启停/**模型下拉切换**/热词统计/用户热词增删改；启动后状态自动刷新到运行中；
4. 多 workspace 切换（如 pi-work ↔ pi-prod）→ 弹窗「最终生效（当前 workspace）」随当前会话变化。

## 手动测试（浏览器 console）

```js
fetch('/api/extensions/aiti-ai-input/voice-asr2', {method:'POST', body: new FormData().append('audio', file)}).then(r=>r.json()).then(console.log)
window.__aitiVoiceInputL2?.start() / .stop() / .recording()
```
