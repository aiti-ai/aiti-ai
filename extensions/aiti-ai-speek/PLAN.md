# aiti-ai-speek — pi-web「跟读模式」扩展方案

> 一句话：用户不方便看屏幕时，开启「跟读模式」让 pi-web 把 AI 的主要输出顺序朗读出来——可切音色、可暂停/跳过/停止、刷屏不慌。

---

## 一、调研结论（其他家 AI 怎么解决"听 AI 输出"）

### 1. ChatGPT —— Read Aloud（逐条朗读）
- **交互**：长按/悬停回复文本 → 菜单选 **Read Aloud** → 朗读该条**完整回复**（不是逐 token 跟读）
- 音色在 Settings→Voice 全局选；有播放/暂停
- **社区痛点**（直接指导我们的设计）：
  - 朗读时滚动页面/点击别处/切 tab → 播放就停（大量投诉）→ **我们的播放控制条必须常驻、不因交互丢焦点**
  - 用户呼吁"自动朗读"开关（想听长回复时不用每次点）→ **这就是我们的跟读模式开关**

### 2. Claude —— 消息级 🔈 按钮 + Voice Mode
- 每条消息下有 🔈/播放按钮 → 点它朗读该条回复；可选中文字只听**某一段落**
- Voice Mode（音波图标）= 实时语音对话，是**另一种模式**（STT→模型→TTS 循环），不是朗读文本

### 3. Gemini —— 朗读按钮 + 播放速度
- 简单：消息工具栏朗读按钮，支持倍速

### 4. 连续免提（ChatGPT Advanced Voice / GPT-Live）
- turnless 实时语音对话，逐 token 出声。**这是"语音对话"不是"朗读"，且对网络/后端要求高** → 不适合我们（我们要朗读 pi-web 已有文本流）

### 5. 听书 App（微信读书 / 番茄小说）
- 标配：**倍速（0.75–3x）、定时关闭、章节跳过、进度条、音色切换**；番茄 AI 朗读由火山语音提供、音色接近真人播讲

### 提炼：我们要的产品模式 = 「ChatGPT Read Aloud 的队列化 + 听书 App 的播放控制 + 显式开关」

| 问题 | 其他家答案 | 我们的设计 |
|---|---|---|
| 刷屏太快怎么读 | ChatGPT/Claude **不逐 token 读**，读"已完成的消息" | 消息完成才进队列，顺序朗读 |
| 怎么开启 | 逐条手动点（ChatGPT）| **跟读模式开关**：开 = 自动入队 |
| 控制 | 播放/暂停（ChatGPT）；倍速（Gemini/听书）| 常驻播放条：⏮ ⏯ ⏭ ⏹ + 倍速 + 音色 |
| 停 | 无明确停止（切走即停=痛点）| ⏹ 停止=清队列回阅读模式，随时重开 |
| 音色 | 全局一个（ChatGPT）| 实时切换（浏览器系统语音列表）|

---

## 二、产品定义：跟读模式（Follow-Along Mode）

### 交互流程
```
默认：纯阅读（不朗读）
  ↓ 用户点工具栏 🔊 跟读开关
跟读模式 ON：
  agent 每条回复完成（agent_settled）
    ↓
  进朗读队列（不打断当前正在读的）
  ↓
  播放条顺序朗读：当前句高亮 + 队列信息「3 在排队」
  ↓ 用户点 ⏹ / 关开关
停止：清空队列、恢复纯阅读（随时可再开）
```

### 核心交互元素

**1. 🔊 跟读开关**（toolbar 插槽，全局）
- 默认关；开 = 本会话进入跟读模式（localStorage 记忆用户偏好，可设"记忆/每次默认关"）

**2. 播放控制条**（sessionTopbar / 浮动面板，常驻不消失）
```
⏮ 上一句 | ⏯ 播放/暂停 | ⏭ 跳过本条 | ⏹ 停止
语速 [0.75x|1x|1.5x|2x]   音色 [晓晓▾]   队列 [2/5 正在读]
```

**3. 设置面板**（dialogs 插槽）
- 默认音色、默认语速、自动朗读开关（跟读模式细分：`自动读新回复` / `仅手动点读`）
- 朗读内容：`全文` / `摘要模式`（二期：只读每段要点）
- 忽略阈值：回复 < N 字不自动读（避免"好的""收到"刷屏）
- 定时关闭（听书标配，二期）

**4. 队列语义（解决刷屏的核心）**
- 新回复 → **队尾**，正在读的不打断（刷屏时你在听的就听完）
- 积压处理：队列 > 5 条时提示"回复积压 N 条，可⏭跳过追进度"；可选自动摘要
- 每条显示来源（消息序号/时间），可点某条**跳播**（读历史消息）
- 消息被用户手动停止后：队列清空，新回复继续自动入队（跟读模式仍是 ON）

**5. 跟读高亮（二期）**
- 正在读的句子在消息流中高亮、自动滚动（听书式）

### 6. 朗读内容优化（本扩展的灵魂：读"好读的"）

> 表格逐格读、代码逐行读 = 灾难。设计三层策略：**读总结 → 读问题 → 其余概要化**。

**A. 总结信息（必读）**——AI 回复里的总结/结论/要点
- 识别：标题含「总结/结论/要点/综上/小结/回顾」的段落；回复开头或结尾的概括句
- 朗读：正常播报（全文朗读模式下也优先、完整读）

**B. 问题信息（必读）**——AI 需要用户回答的内容
- 识别：以「？/吗/呢/吧」结尾的句子；「您觉得…」「你怎么看…」等提问结构；独立的问题列表
- 朗读：完整播报；**播放条「只看问题」**（二期）→ 只读 A+B，快速知道要回答什么

**C. 其余内容（概要化）**——表格/代码/复杂结构 → 口语化概要
| 结构 | 朗读处理 |
|---|---|
| 代码块 ``` | 不逐行读 → 「接下来是一段 <语言> 代码，约 N 行，主要实现 <函数名/首行注释>；细节请看屏幕」|
| 表格 | 「这是一张 N 行 M 列的表格，表头：<表头>；例如：<首行摘要>；结论：<末行/标注>」|
| 长列表 | 「第一…第二…」口播，无嵌套 |
| 标题/分隔线 | 停顿 + 「第 X 部分：<标题>」|
| 链接/图片/公式 | 只读文字；公式口播化（√→根号、≥→大于等于）|
| 代码/表格前后已有 AI 概要 | 直接读概要，跳过原文块 |

**实现位置**：浏览器端 `toSpeechText(markdown)`（朗读预处理，markdown → speech-friendly 文本 + 内容类型标记 summary/question/body）

### 7. AI 侧提示词注入（让 AI 输出时就优化朗读）

> 开启跟读模式时，服务端经 `info.steer()` 给会话注入一条提示词（等同用户发话，当前 turn 完成后生效）——让 AI 知道用户"在听"，输出自带朗读优化。

**注入文案（设计稿）**：
```
【朗读模式提示】用户正在听语音朗读你的回复。请按以下方式输出，方便朗读：
1. 开头先用一两句话给出核心结论/总结；
2. 需要展示表格、代码或复杂结构时，务必先加一句口语化说明概要
   （表格："下面是一张对比表，主要对比A和B，结论是…"；代码："这是一段实现xx功能的代码"）；
3. 需要用户回答时，把问题明确放在回复末尾（如"…您觉得呢？"）；
4. 优先短句、口语化，避免超长嵌套句。
```

- **注入时机**：用户开启跟读模式 → 对当前活跃会话注入一次（记录已注入 sessionId，避免重复）；`onAgentSession` 会话启动时若跟读已开也注入
- **关闭朗读**：不注入"恢复"提示（AI 输出习惯自然回落），可选「恢复提示」开关（二期）
- **注意**：steer 等同用户发话，消息流会显示该条（设计为带「📢 朗读模式已开启」样式的提示消息，不干扰阅读）

### 8. 朗读模式设置（dialogs）
- `朗读内容`：**全文概要化**（A+B+C，默认）/ **仅要点**（A+B，只听总结和问题）
- `提示词注入`：开（默认）/ 关（不想改变 AI 输出风格时）
- `表格代码`：概要化（默认）/ 跳过（完全不读）/ 逐行（硬读，不推荐）
- 其余：音色/语速/忽略阈值/定时关闭

---

## 三、技术架构（前端为主，后端极薄）

> **方案：纯前端扩展**——client bundle 监听 pi-web 消息事件（EventSource `/api/agent/<sid>/events`），前端拆句、前端控制播放；**消息识别/排队/暂停全在前端**（用户可随时暂停正在读的）。TTS 引擎可切换：**浏览器直接读（Web Speech，零后端）** 或 **后端输出语音（edge-tts，可选）**。
>
> **后端只保留 2 个可选 API**（不参与消息识别/发出）：① tts 合成（用户选 edge-tts 语音时）② steer 提示词注入（可选增强）。
>
> **复用原则**：novel-web 已验证的朗读实现直接复用/照搬改造（拆句/清理/面板 UI/高亮/缓存），不另起炉灶（资产清单见下）。

### 复用 novel-web 已实现资产（优先，不另写）

| novel-web 资产 | 位置 | 能力 | 用法 |
|---|---|---|---|
| `cleanMarkdown()` | `server/index.js:965` | markdown→纯文本（去 **/#/链接/代码块/引用/中文引号转义）| **直接复用**：AI 回复朗读前清理 |
| `parseContentToSegments()` | `src/views/Chapter.vue.bak:357` | 按空行分段落（段落独立渲染/朗读）| **复用**：分段策略 |
| TTS 面板 UI | `src/views/Chapter.vue.bak:47-150` | 浮动开关 + 底部面板 + 进度条 + 播放/暂停/继续/停止 + 音色/语速/音调 + **段落高亮**（跟读高亮已实现）| **UI 照搬**（换 React h/hooks 实现）|
| `engine-manager.js` + `cache.js` | `server/tts/` | 多引擎管理 + 自动降级 + **SHA-256 缓存**（key=engine+voice+segments）| **复用**：合成 + 缓存（同文本不重复合成）|
| `estimateDuration()` | `server/index.js:1048` | 时长估算（中文 4字/秒）| 复用：进度估算 |
| edge-tts 引擎 | `server/tts/edge-tts-engine.js` | 微软神经语音合成 | **复用**：改造成扩展服务端调用 |

> 差异点（novel-web 是「手动点读章节」；我们是「AI 回复自动跟读」）：新增 onAgentSettled 钩子接入、per-session 队列、steer 提示词注入、总结/问题优先、代码/表格概要化——这些是 novel-web 没有的。

```
前端（client bundle，唯一主角）
├── 🔊 toolbar 开关      → 跟读 ON（localStorage 记忆）
├── 消息监听 listener.ts（核心）
│    ├── new EventSource(apiUrl('/api/agent/<sid>/events'))
│    │    监听 message_update / assistant 事件 → 新回复文本
│    ├── 备选：轮询 apiUrl('/api/sessions/<sid>') 拉新消息（EventSource 不可用时）
│    └── 过滤：文本过短/非当前会话 → 丢弃
├── 拆句 segmenter.ts（复用 novel-web parseContentToSegments）
│    ├── cleanMarkdown（复用 novel-web）→ 按空行/句子分段（阈值截断）
│    └── 标注类型：summary / question / body（读总结、读问题优先）
├── 播放器 player.ts（复用 novel-web 面板 UI + 播放逻辑）
│    ├── 引擎可切换：① Web Speech（浏览器直接读，零后端）
│    │                ② edge-tts（GET /api/extensions/aiti-ai-speek/tts → <audio> 播放）
│    ├── 控制：⏯ 暂停/继续 ⏹ 停止 ⏭ 跳过 ⏮ 重读 + 倍速 + 音色 + 进度
│    │    （Web Speech: pause/resume/cancel；audio: pause/currentTime）
│    ├── 段落高亮：正在读的句子在消息流高亮（novel-web 已有逻辑）
│    └── 顺序播放：队列推进，新消息进队尾不打断当前
└── 设置（localStorage）：音色/语速/朗读内容（全文概要化|仅要点）/引擎选择

后端（极薄，2 个可选 API，不参与消息识别/发出）
├── GET /api/extensions/aiti-ai-speek/tts?text&voice&rate → edge-tts 合成 mp3
│    └── 复用 novel-web edge-tts-engine + SHA-256 缓存 + ChatTTS→edge 降级
├── POST /api/extensions/aiti-ai-speek/steer → info.steer(【朗读模式提示】…)（可选，让 AI 输出自带朗读优化）
└── （消息监听/拆句/排队/播放全在前端，后端零参与）
```

### 浏览器朗读能力（Web Speech API）要点

```js
// 音色枚举（异步，voiceschanged 事件）
const voices = speechSynthesis.getVoices()  // 过滤 lang.startsWith('zh')
// 朗读：浏览器原生队列——连续 speak() 自动按序播放，天然解决刷屏顺序问题
const u = new SpeechSynthesisUtterance(text)
u.voice = selectedVoice; u.rate = 1; u.pitch = 1; u.lang = 'zh-CN'
u.onend = () => next()
speechSynthesis.speak(u)
// 控制
speechSynthesis.cancel()   // 停止 + 清空队列（= 我们的 ⏹）
speechSynthesis.pause()    // 暂停（= ⏯）
speechSynthesis.resume()
```

### 刷屏 → 顺序朗读（浏览器原生队列语义）
```
开启跟读：点 🔊（纯前端状态，localStorage）
  → 前端 new EventSource(/api/agent/<sid>/events) 监听消息
  → 可选：POST /steer 注入朗读提示词（AI 之后输出自带朗读优化）
agent 回复输出中（message_update 事件）
  → 前端收集文本增量（完整后再入队；或句子边界即时入队——见「流式 vs 完成后」）
  → cleanMarkdown + 拆句（复用 novel-web）→ 标注 summary/question/body
  → 按模式（全文概要化/仅要点）选段
  → 播放器：Web Speech speak() 或逐段 GET /tts（edge-tts）→ <audio> 顺序播放
  → 新回复进队尾（不打断当前）→ 刷屏变听书
  → 用户随时 ⏯暂停 ⏹停止（纯前端控制，无后端往返）
  → 段落高亮（novel-web 已有逻辑，照搬）
```

### TTS 引擎决策（前端可切换，默认浏览器直接读）
| 方案 | 音质 | 后端依赖 | 结论 |
|---|---|---|---|
| **浏览器 Web Speech API（speechSynthesis）** | 依赖系统语音（Edge/Windows/macOS 好）| **零（纯前端，最贴合"后端无关"）** | ✅ **默认引擎** |
| 服务端 edge-tts（novel-web 方案）| 微软神经语音，好 | edge-tts（pip 清华镜像装）+ 极薄 tts API | 可选：用户想要更好音质时切换 |

- **默认浏览器直接读**（纯前端，符合"后端不参与"）；想更好的音质 → 设置里切 edge-tts
- 依赖安装（仅选 edge-tts 时）：`pip install edge-tts -i https://pypi.tuna.tsinghua.edu.cn/simple`（幂等）
- 切换：设置面板引擎下拉；播放时切换即时生效（下一条用新引擎）

### 音色（edge-tts 微软中文语音，novel-web 已用，全部免费）
| 音色 | 音色名 | 风格 |
|---|---|---|
| 晓晓（默认）| zh-CN-XiaoxiaoNeural | 女声，温柔清晰 |
| 云希 | zh-CN-YunxiNeural | 男声，年轻 |
| 云扬 | zh-CN-YunyangNeural | 男声，新闻播报（听书推荐）|
| 晓伊 | zh-CN-XiaoyiNeural | 女声 |
| 云枫 | zh-CN-YunfengNeural | 男声，沉稳 |

- 列表静态内置（novel-web `edgeTtsVoices` 同源）；Web Speech 备选引擎才用 getVoices() 动态枚举
- 用户选择存 localStorage，下次恢复

### 限制与对策
| 限制 | 对策 |
|---|---|
| edge-tts 需网络（微软 TTS 端点）| 失败自动降级 Web Speech API（novel-web 降级思想）；缓存命中不耗网络 |
| 长文本单次限长 | 分段朗读（复用 novel-web 按空行分段 + estimateDuration）|
| autoplay policy（Web Speech 备选引擎）| 跟读开关点击 = 用户手势；备选引擎才涉及 |
| 浏览器无语音环境（备选引擎）| 主引擎 edge-tts 不依赖系统语音；备选才提示装 speech-dispatcher |
| 后台标签页播放暂停（浏览器省电）| 提示保持 pi-web 前台 |

---

## 四、扩展工程结构（源码 → 部署）

```
aiti-ai/pi-web-ext/aiti-ai-speek/            ← 源码（git）
├── index.ts                            ← 扩展对象（server.agent.onAgentSettled + api + ui 声明）
├── server/
│   ├── pending.ts                      ← per-session 待读列表（内存，{id, text, ts}）+ 过滤
│   ├── tts.ts                          ← edge-tts 合成 + SHA-256 缓存（复用 novel-web engine/cache，改造成扩展 API）
│   ├── clean.ts                        ← cleanMarkdown + 分段（复用 novel-web，直接拷贝）
│   └── steer.ts                        ← 朗读提示词注入（开启跟读时 info.steer，去重）
├── client/
│   ├── aiti-ai-speek-client.mjs             ← 手写 ESM bundle（h/hooks/registerItems，参照 aiti-devtools）
│   ├── player.ts                       ← 播放器（<audio> 逐段播放 + 段落高亮 + 引擎切换，UI 照搬 novel-web 面板）
│   └── toSpeechText.ts                 ← 朗读预处理（markdown→speech-friendly：代码/表格概要、类型标注）
├── tools/deploy.mjs                    ← 部署脚本（参照 deploy-ext.mjs：拷贝 → web/web-dev → reload）
└── PLAN.md                             ← 本文档
```

- **部署**：`node tools/deploy.mjs` → `~/.pi/web/extensions/aiti-ai-speek/` + `~/.pi/web-dev/extensions/aiti-ai-speek/` → `POST /api/extensions/reload` 热重载（dev 实例 3001 带 `/dev` 前缀）
- **依赖**：仅 **edge-tts** 一个 Python 包（`pip install edge-tts -i https://pypi.tuna.tsinghua.edu.cn/simple`，幂等）；**无其他工具**——播放走浏览器 <audio>，不装播放器/ffplay 等
- **验证**：`GET /api/extensions/aiti-ai-speek/ping`、`/api/extensions/status`；浏览器 console 验证 `speechSynthesis.getVoices()` 含 zh 语音

---

## 五、实现步骤（里程碑）

| # | 内容 | 验收 |
|---|---|---|
| # | 内容 | 验收 |
|---|---|---|
| **M0 骨架** | index.ts（仅 ui 声明 + 可选 tts/steer API 占位）+ 空 client + deploy 脚本 | `/api/extensions/status` 出现 aiti-ai-speek，toolbar 出现 🔊 按钮 |
| **M1 前端监听** | listener.ts（EventSource /api/agent/<sid>/events 捕获 message_update）+ 拆句（复用 novel-web parseContentToSegments）| 真会话回复 → 前端拿到文本并拆好句 |
| **M2 浏览器朗读** | player.ts Web Speech 引擎（speak/暂停/停止/音色/倍速）+ 播放条（⏮⏯⏭⏹，UI 照搬 novel-web 面板）+ 段落高亮 | 真会话回复 → 浏览器自动顺序朗读；可暂停/跳过/停止 |
| **M3 朗读体验** | toSpeechText（代码/表格→概要 + summary/question 标注）+ 全文/仅要点模式 | 代码块读概要不逐行；总结/问题优先可听清 |
| **M4 可选后端** | ① tts API（edge-tts + SHA-256 缓存，pip 镜像装）→ 设置切引擎 ② steer 提示词注入 | edge-tts 音质档可选生效；AI 回复自带口语概要 |
| **M5 完善+二期** | 开关记忆、忽略阈值、积压提示、语音不可用提示、跟读高亮滚动、定时关闭、流式朗读（句子边界即时读）| 听书级体验 |

## 六、风险与对策

| 风险 | 对策 |
|---|---|
| 风险 | 对策 |
|---|---|
| 浏览器无中文语音（Linux Chrome 依赖 speech-dispatcher）| 安装提示（apt speech-dispatcher espeak-ng）；Edge 内置微软语音；扩展内自检语音列表并引导 |
| 长文本朗读截断（旧 Chrome ~15s）| 分段朗读（utterance 按句/段切）|
| autoplay 限制（无手势不能 speak）| 跟读开关点击即手势；若页面刷新后自动开 → 提示再点一次 |
| 队列积压（AI 连续多轮刷屏）| ⏭ 跳过 + 积压提示 + 摘要模式（二期）；浏览器原生队列天然不打断 |
| 音色/语速切换中断 | 切换即生效（下句新参数，当前句读完）|
| 多会话混乱 | 待读列表 per-session；仅"当前活跃会话"跟读，切会话自动跟随 |
| 语音质量不满意（机器人音）| 二期可选后端音质档：edge-tts（pip 带清华镜像安装，非 justget）|

---

*调研：ChatGPT Read Aloud / Claude 🔈 / Gemini / GPT-Live / 微信读书·番茄听书 · 外部方案：浏览器扩展模式（Read Aloud / GPT Reader / 社区脚本 = 纯前端监听 + 分段 + 悬浮控制条 + Web Speech/云端 TTS）；流式 TTS（Pipecat/OpenAI）太重不适合跟读 · 平台：pi-web 扩展框架（client bundle 可 EventSource /api/agent/<sid>/events + /api/sessions/<sid> 拉消息）· 复用：novel-web 拆句/清理/面板 UI/高亮/缓存 · 引擎：默认浏览器 Web Speech（纯前端），可选 edge-tts（pip 清华镜像装）*
