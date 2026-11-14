# pi-models-combo

一个让模型列表保持整洁、并轮转 API key 防 429 的 [pi 包](https://pi.dev/packages)。

[English](./README.md) · 简体中文

## 关于 aiti

本包来自 [aiti](https://aiti.pw/)（GitHub 组织 [aiti-ai](https://github.com/aiti-ai)）——
一个以 pi 为引擎的个人 AI 开发工作台生态。

**可独立使用**：任何 pi（coding agent）用户均可直接 `pi install npm:@aiti-ai/pi-models-combo`，
单独获得本包全部能力——模型过滤、多 key 粘性轮转、多 provider 聚合（组合模型）、
质量监控与 429 治理，与 aiti 其它组件无任何依赖。

**也可配合 aiti-agent 使用**（自托管 Web 工作台，浏览器主操作面）：🧙 模型向导会识别本包
声明的多 key 池与组合模型，提供可视化编辑（「模型聚合」页签、多 key 粘性轮转配置），
📡 模型检查直接展示组合成员构成与限流状态——多 key 与多 provider 聚合的编排
无需手写 `models.json`，全在界面里点出来。

## 1. 模型过滤

对于你在 `models.json` 里显式配置了 `models` 列表的 provider，只有你配置的
模型保持可见——内置 catalog 里那一大堆模型（比如 openrouter 的全量目录）
会安静地退到一边。

## 2. Key 轮转（本地代理）

当 provider 配了多个 `apiKeys` 时，本包在随机端口启动本地代理，并通过
`pi.registerProvider()` 注册进会话（扩展层配置优先于 `models.json`，路由
必定经过代理）。代理负责：

- 按 API 类型注入正确的鉴权头：openai 系用 `Authorization: Bearer`、
  anthropic-messages 用 `x-api-key`（+ `anthropic-version`）、
  google-generative-ai 用 `x-goog-api-key`
- 把 openai-completions 请求体里的 `role:"developer"` 改写为 `"system"`
  （GLM 系中转上游不认 developer 角色，报 `[1214] Incorrect role information`；
  设 `PMC_NO_ROLE_REWRITE=1` 可关闭）
- 对 OpenCode Go（Console Go，`opencode.ai/zen/go`）上游注入 `x-opencode-session` 头——
  Console Go 强制要求此头用于 prompt cache 路由。值取稳定的 per-session hash
  （`runClient` = 每个会话 dummy token 的截断），会话内缓存友好、跨会话隔离。
  默认按上游 host 自动检测；可用 provider 级 `compat.xOpenCodeSession` 覆盖
  （`true` 强制注入 / `false` 关闭）。
- 429 自动重试（最多 5 次，指数退避 + 抖动）；被限流的 key 进冷却
  （按 `Retry-After` 或默认 30s）；每 key 可选 `rpm` + 等间距节流
  （默认：间隔按 60000/rpm 自动折算；`minIntervalMs: 0` 退回突发滑窗）
- 上游超时兜底（默认 120s → 返回 504）
- 上游限流错误可能很长（天级 `retry-after`），不适应多模型轮转——返回给 pi 一个较小的限流超时（默认 ≤60s），并剥掉其余限流响应头

pi 只看到一个普通地址（`http://127.0.0.1:{随机端口}/`）和一个随机 dummy
token，接触不到真实 key。

代理状态挂在 `globalThis` 单例上：CLI 反复调用、aiti-ai 每个 session 的重复
加载都复用同一组运行中的代理（不会每会话泄漏一个端口）；`stopAllRespect()`
+ 进程退出钩子保证长驻宿主干净退出。`settings.json` 为 CLI 与 aiti-ai 共享，
双通道加载同一引擎、幂等共存。

不删除任何东西：provider 定义、模型定义、凭据都原样保留。

## 3. 模型聚合（组合模型）

把多个真实模型组成**一个虚拟模型**暴露给 pi：`models.json` 里建一个
用户自命名的 provider（`"combo": true` 标记），每个虚拟模型的 `combo.members`
列出成员（可带 `weight` 权重，默认 10）。请求打到虚拟模型时由本包的本地代理路由：

```jsonc
"providers": {
  "快速组": {
    "name": "快速组", "combo": true,
    "baseUrl": "http://combo.pmc.invalid/",   // 占位：运行时被引擎 override
    "api": "openai-completions",              // 组内同协议（v1 不做跨协议翻译）
    "models": [{
      "id": "fast",
      "contextWindow": 64000,                 // 向导自动取成员最小值写入
      "input": ["text", "image"],             // 成员能力并集
      "combo": {
        "members": [
          { "provider": "deepseek", "model": "deepseek-v4-pro" },
          { "provider": "deepseek", "model": "deepseek-v4-flash", "weight": 30 },
          { "provider": "qwen", "model": "qwen-vl", "types": ["vision"] }   // 图形专用：纯文本请求不发给它
        ],
        "stickyTtlMin": 15
      }
    }]
  }
}
```

- **承接类别（types，v0.4.4）**：成员可配 `types` 白名单声明「我处理哪几类请求」，
  取值 `text` / `vision` / `other`（音频/视频/PDF 等），可多选；**不配或空数组 = 承接全部**（现状行为）。
  - `["vision"]`：**图形专用**——带图请求自动路由到它，纯文本请求不发给它（需模型 input 含 image）；
  - `["text"]`：仅文本——带图/媒体请求避开它；
  - `["other"]`：仅媒体（音频/视频/PDF 等）。
  请求类别检测覆盖 openai（image_url / input_audio）、anthropic（image / document）、
  google（inline_data / file_data 的 mime 前缀）三种协议；带图请求即使含文本也按 vision 路由，
  图文+媒体混合请求只被「全收」成员承接。典型用法：文本模型 + `["vision"]` 图形模型组成
  一个虚拟模型，带图/纯文本请求各走专用模型。

- **粘性路由（sticky）**：同一会话在 TTL 内（默认 15 分钟空闲）固定打同一
  成员——prompt cache 按上游账号/组织隔离，换模型 = 全量缓存失效；粘性最大化命中。
  429 冷却自动切换（先换同成员其它 key，再换下一成员）；连续网络错误自动避开。
- **权重占比**：初始选点/切换重选按成员权重随机（排序+累计区间+随机数落点）；
  多 key 成员按成员级语义分组，key 数不放大占比。全默认权重保持确定性轮转起步。
- **vision 路由**：带图请求自动避开无 vision 的成员；**types 分工路由（v0.4.4）**：
  带图请求还自动避开 `types` 不含 `vision` 的成员、纯文本请求避开 `types:["vision"]` 的
  图形专用成员（详见上方 types 配置说明）。
- **可观测**：usage log（`~/.pi/agent/model-usage/key-requests.jsonl`）每条成功
  记录带 `combo` 成员归属；切换写独立 `switch:{from,to,reason}` 行。
- 🧙 模型向导新增「模型聚合」页签可视化编辑；📡 模型检查对聚合模型显示成员构成。

**为什么粘性对 key 层同样默认开启？** 缓存按上游账号隔离：不同账号的 key 来回
切 = 每次全量 miss + 双份 cache write 成本（Anthropic 类 1.25×）。TTL 到期照样
轮换均摊配额；`"stickyKeys": false` 可一键退回纯轮转（同账号纯均摊场景）。

已知限制：v1 仅支持组内同协议（openai-completions 或 anthropic-messages 二选一，
跨协议 body 翻译放 v2）；oauth 登录型 provider 不能作成员（无 key 可注入）；
同一成员 key 同时被自身代理与聚合代理使用时 rpm/冷却计数各自独立。

## 4. 质量监控与超时

针对「会话卡住几十分钟」与「模型持续慢」两类问题：

**三段超时**（替代旧的单一 120s 总超时）：

| 计时器 | 默认 | 触发行为 |
|---|---|---|
| TTFB（等响应头） | 90s | 掐断请求 → 该槽位冷却 → **换下一把 key / 下一成员重试** |
| 流空闲（字节间无数据） | 45s | SSE 中途停摆即双端掐断（此前流开始后掐上游但客户端永不结束——会话卡死的根因） |
| 总时长上限 | 15min | 同上 |

**持续慢判定**：每槽位滚动窗口记录最近 8 次成功请求的 TTFB，中位数 >30s 判定
「持续慢」→ 粘性命中该槽位时**无视 TTL 立即换**到健康且不慢的槽位（usage log
switch 行 `reason:"slow"`）。

**错误状态码**：≥400 响应一律让粘性指针立即到期；401/402/403 与 5xx 视为槽位故障
（多槽位时冷却并换槽重试），其余 4xx 透传客户端但同样不再粘住坏槽位。

provider 级可选覆盖：

```jsonc
"timeouts": { "ttfbMs": 90000, "idleMs": 45000, "totalMs": 900000, "poolDeadlineMs": 300000 },
"quality":  { "window": 8, "ttfbMedianMs": 30000 }
```

**池级硬截止 `poolDeadlineMs`（默认 300s，0=关闭；env `PMC_POOL_DEADLINE_MS` 兜底）**：
一次客户端请求在代理内的**总预算**——跨所有重试/换成员串行累计。免费池整体拥堵时成员会
挨个 TTFB 超时，无截止 = 客户端串行干等 N×TTFB（实测 6×90s≈11.5min，session 表现为「卡死」）。
到期 → 终止重试链 + 结构化 504（`error.type:"timeout"`），pi 端自带重试稍后重来。

**超时降权 ×1/2**：TTFB/流空闲/总时长任一超时 → 该成员权重减半（成员级语义，
与加权选点一致；乘后保底 1），并按既有逻辑冷却（冻结）。该成员**下次真实成功**
（<400 完整响应）自动恢复权重。`status()` 每槽位新增 `effectiveWeight` /
`timeoutPenalized` 可观测。

## 4.1 多语（i18n / v0.4.3）

代理日志、客户端可见的结构化错误、`/combo` 命令全部输出、启动/刷新消息均已多语化。
语言检测优先级：**`PMC_LANG`（本扩展显式覆盖）> `PMC_LOCALE` > `LC_ALL` > `LC_MESSAGES` > `LANG`**
（POSIX 惯例链），归一后 `zh*` → zh-CN、`en*` → en、其它真实语言 → en 兑底，`C`/`POSIX`/空沿链继续；
全链无声明 → ICU 默认 locale 兑底（`Intl` 系统区域语言）——**Windows 原生环境不设 LANG/LC_*，
靠这层识别系统区域语言**（中文 Windows → zh-CN，英文 Windows → en）；无声明/无 Intl → zh-CN。
显式覆盖任何平台可用（PowerShell `$env:PMC_LANG="en"`）。
协议层锚点不翻译：`error.type` 字段、终态 400 的 `[quota exceeded: …]`
（pi-ai NON_RETRYABLE 匹配依赖）、日志锚点 `upstream timeout` / `upstream error`。

## 5. 429 冷却与饱和闸门

免费池配额耗尽时常返回**天级 `retry-after`**（实测见过 1600000s≈18.5 天）。照单全收会把槽位
雪藏数日；原样透传给客户端又会撞上 pi 的 60s 重试等待上限直接拒等（`Server requested XXXXs
retry delay (max: 60s)` → 不重试秒失败）。因此：

- **冷却封顶**：上游 retry-after 超过 `PMC_RETRY_AFTER_CAP`（秒，默认 60）时封顶并告警
  「大概率配额耗尽」，到期自动重新探测（用户可能已充值/上游已恢复）
- **回给客户端的 429 响应头同样封顶**（≤60s 且 ≤cap）：客户端按节奏重试而非秒失败
- **饱和闸门**：一个池子（组合分组/provider）**持续**全部槽位限流超过
  `PMC_SATURATION_TERMINAL_MS`（毫秒，默认 180000=3 分钟）→ 返回终态 400，消息带
  `quota exceeded` 锚点（客户端识别为不可重试，干净报错而非无限转圈）。任一请求**真正
  成功**（上游 <400）才解除计时；「选到槽位」不算恢复——冷却过期的死槽位会再度 429 并
  继续计时（慢节奏客户端如 pi 每 60s 重试也能到达终态）
- 全部槽位因**错误**（401/402/403/5xx/超时）冷却 ≠ 限流饱和 → 返回 502 api_error，
  不进闸门计时

## 配置

没有独立配置文件，一切都在 `models.json`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `apiKey` | `string` | 单 key（原始行为，无轮转） |
| `apiKeys` | `Array<{name, key, rpm?, minIntervalMs?, enabled?}>` | 命名 key 池（启用轮转）；rpm 每分钟上限；minIntervalMs：留空=auto（按 60000/rpm 匀速，默认）、0=突发滑窗、数字=固定毫秒间隔；`enabled: false` = 临时禁用该 key（不参与轮转、配置保留，向导一键启用即恢复） |
| `models` | `Array<{id, enabled?}>` | 可见模型白名单；模型条目 `enabled: false` = 临时禁用该模型（从可用列表隐藏、组合成员跳过、配置保留） |
| `enabled` | `boolean`（provider 级） | 临时禁用整个 provider（不建代理、全部模型从列表隐藏、组合成员跳过、配置保留；`false` 为禁用） |
| `stickyKeys` | `boolean`（provider 级） | key 层粘性开关（默认开）；`false` 回退纯轮转 |
| `combo` | `true`（provider 级） | 虚拟聚合 provider 标记（见「模型聚合」节） |

- `apiKeys` 有 **2 个及以上**时轮转生效
- 每个 key 需要唯一 `name`（模型向导 / 模型检查里展示）
- 不配 `apiKeys` 时单 `apiKey` 照常工作
- **临时禁用不删除**：provider / key / 模型三个层级都支持 `enabled: false`——引擎侧跳过（不建代理 / 不入轮转 / 隐藏模型 / 组合跳过），配置完整保留，模型向导里一键切回启用即恢复。聚合组禁用 = provider 级；聚合成员禁用 = `combo.members[i].enabled: false`（跳过该成员、其余照常组队）；虚拟模型禁用 = `models[i].enabled: false`（整个模型停用）。

## 安装

```sh
pi install npm:@aiti-ai/pi-models-combo
```

## 许可

见 LICENSE。
