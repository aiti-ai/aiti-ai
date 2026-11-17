# pi-secret-mask

> **随手贴，不泄密。** — Paste-safe by default.

[pi](https://github.com/earendil-works/pi-coding-agent) 的会话级 AI 脱敏插件：你贴进 prompt 的 token / API key / 凭据，在**发送给模型之前**自动替换为稳定占位符（如 `[REDACTED:github-token]`）；模型在工具参数里引用占位符时，**工具执行之前**自动还原为真实值。

pi 包形态，零运行时依赖。装一次即覆盖 TUI 和全部 pi-web 会话（pi-web 的每个 pi 会话都是独立 `pi --mode rpc` 子进程，加载全局 packages）。

English: [README.md](README.md)

```
你：  我的 api key 是 sk-ant-api03-<80位> —— 帮我写进 .env 的 ANTHROPIC_KEY
模型看到：我的 api key 是 [REDACTED:ANTHROPIC_KEY#a1b2c3d4] —— 帮我写进 .env ...
write 工具：ANTHROPIC_KEY=sk-ant-api03-<80位>   ← 执行时已还原为真值
session 文件：原文保留（context 钩子是非破坏性的）
```


## 关于 aiti

本包是 **aiti** 生态的一部分——一个以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台生态。

- **aiti Web 工作台**（自托管、浏览器主操作面，本插件默认预装）：npm 包 **`@aiti-ai/pi-web`** —— <https://github.com/aiti-ai/pi-web> · 官网 <https://aiti.pw>
- 生态 monorepo（文档站、扩展、集成）： <https://github.com/aiti-ai/aiti-ai>

**可独立使用**：任何 pi（coding agent）用户均可直接 `pi install npm:@aiti-ai/pi-secret-mask`，单独获得全部能力，与 aiti 其它组件无任何依赖。

**也可配合 aiti Web 使用**：从 Web 工作台发起的会话自动带上本插件（第一方插件，启动时自动预配）。

## 安装

```bash
pi install npm:@aiti-ai/pi-secret-mask@latest     # 开发期也可用本地路径
```

或在 `~/.pi/agent/settings.json` 加：

```json
{ "packages": ["npm:@aiti-ai/pi-secret-mask@latest"] }
```

**新开的会话生效**（每个新 TUI / pi-web 会话都会新起一个 pi 进程）；已运行的会话不受影响。

## 命令

| 命令 | 作用 |
|---|---|
| `/secret add <值> [as <别名>]` | 登记一个值（省略值时进入交互输入，值不进对话）。别名让占位符可读。 |
| `/secret list` | 已登记值清单（打码预览 `…****abcd`、来源、规则 id）。 |
| `/secret remove <别名\|标签>` | 移除一个值。 |
| `/secret clear` | 清空全部。 |
| `/secret on` / `off` | 本会话开/关脱敏。 |
| `/secret status` | 状态总览（含审计状态与最近一次审计结果）。 |
| `/secret save` / `unload` | 把当前项目的值持久化到 `~/.pi/agent/secret-mask.json`（0600，显式 opt-in）/ 清除。 |
| `/secret audit on\|off` | 每次发送的线上 payload 证明日志（见下文[测试与验证](#测试与验证)）。 |
| `/secret audit show` | 查看最近的审计证据行。 |

## 工作机制

| 环节 | 钩子 | 行为 |
|---|---|---|
| 发送边界 | `context` | 对所有角色（user / assistant 文本 / 工具结果 / `!` bash 命令与输出 / 压缩摘要）做脱敏；自动检测（高置信规则）只对**用户手写文本**登记新值。该钩子拿到的是深拷贝：session 原文不受影响，只有发往模型的副本被改写。 |
| 约定注入 | `before_agent_start` | 追加 `secret_masking` 系统提示节：占位符是不透明替身，引用时原样照抄进工具参数，禁止猜测真值。 |
| 返回边界 | `tool_call` | 就地还原工具参数中的占位符（pi 只接受就地修改字段）。bash 默认包含——核心场景就是"用这个 key 跑命令"；若你的威胁模型不接受，`/secret off` 可整体关闭。 |
| 工具输出 | `tool_result` | 工具输出进入上下文与 session 记录前替换已登记值（防止 `cat .env` 把值再次灌进对话）。 |
| 证明层 | `before_provider_request` | 开启 `/secret audit on` 后：在**最终线上 payload**（provider 序列化完成、HTTP 发出前）扫描已登记真值与占位符出现次数。每次发送 `leaks=0` 且 `placeholders>0` = 只有占位符上线的直接证据；出现任何真值立即报警。该检查独立于脱敏主链路——无论之前钩子链怎么改写，它看到的就是最终上线内容。 |

## 检测规则

确定性正则 + 校验和规则，无网络请求、无模型调用：AWS、GitHub、GitLab、Slack（token + webhook）、Stripe live、SendGrid、Twilio、Google API/OAuth、Anthropic、OpenAI、Hugging Face、npm、PyPI、Azure storage、JWT（须解出 alg 头）、PEM 私钥（完整 + 截断）、带真实密码的 DB URL、`Authorization` 头、泛型 `key = "value"` / `key = value` 赋值（香农熵阈值 + 代码标识符/模板/URL 排除）。base64 包装的前缀型 token 解码后整段命中。短于 6 字符的值忽略（噪音防护）。

**中文关键词**（v0.1.x）：泛型赋值词表包含 `密码 / 密钥 / 秘钥 / 口令 / 令牌 / 授权码 / 授权密钥 / 访问令牌 / 访问密钥 / 凭证 / 凭据 / 私钥`；赋值分隔符支持全角冒号（`密码：xxx`、`授权码：xxx`、`Authorization：Bearer xxx`）；中英邻接（`API密钥`、`db密码`）与纯中文前缀（`数据库密码`）都算词边界。已知取舍：**裸赋值的纯中文短语**值需约 8 个不同汉字才达熵下限（3.0 bits/字符）；引号包裹形态可靠，或用 `/secret add`。

误报三重防护：`plausibleSecret` 排除集（模板槽位、`${VAR}`、路径、URL、`process.env.*`、`example`/`changeme` 等填充值）、熵下限（引号形态 ≥2.0 / 裸值 ≥3.0 bits/字符）、代码标识符/成员链排除（`Uint8Array`、`jose.base64url.decode` 不是密码值）。规则形状对标公开的 gitleaks/GitHub secret-scanning 语料库（以 MIT 许可的 `claude-code-redact` 项目实现为参照）；`tools/fp-corpus.mjs` 复用其 11 个锁定公共仓库（4.2 万+ 文件）做误报复测。完整归属、许可文本与商标说明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 占位符格式

- 显式登记（带别名）：`[REDACTED:github-token]`——别名即语义。
- 自动检测：`[REDACTED:GITHUB_TOKEN#a1b2c3d4]`——hash = fnv1a(会话盐 + 值)；同会话内同值同占位符（幂等、缓存友好），跨会话无意义（防碰撞猜测）。

## 测试与验证

四层手段，从单测到线上证明：

### 1. 单元测试（`npm test`）

`node --test`，38 个用例。覆盖：每条规则族（正匹配 + **近 miss** fixture——形状相邻但必须不命中的非密串）、熵/校验和辅助函数、中文关键词形态（全角冒号、中英邻接、`密码规则如下：` 等文字性近 miss）、占位符幂等、子串包含时长值优先、多形态匹配（PEM 正文被行号拆散仍命中）、还原往返、工具输入深遍历、按角色的消息脱敏、命令处理、持久化往返、线上 payload 审计扫描。

### 2. 误报语料（`npm run fp-corpus`）

扫描与 claude-code-redact 的 fp-corpus 相同的 11 个锁定公共仓库（lockfile、go.sum、Kubernetes/Terraform 清单、含示例凭据的 compose、重文档 Markdown、压缩 JS、JWT/PEM 测试向量、JOSE 向量、`.env` fixture；约 6 万文本文件，单文件 <2MB）。锁定时点结果：**66 处命中全部为真实形状（测试 PEM 私钥、签名 JWT 向量、示例 DB 凭据）——0 误报**，与上游基线（42,836 文件 / 68 命中 / 0 误报）对齐。判定标准：作为测试向量发布的完整私钥 / 签名 JWT / 示例 DB 凭据**就是密钥、应当被脱敏**，不算误报。结果写入 `tools/fp-corpus-results.md`；仓库缓存在 `/tmp/pi-secret-mask-fp-corpus/`，热跑约 20 秒。

局限：语料为英文仓。中文误报行为由单测近 miss 覆盖（`密码规则如下：` / `密码策略：` 必须不命中）。

### 3. 端到端冒烟（行为学证明）

新会话里——**模型说不出它没收到的东西**：

```
你：  把这个 key 存到 /tmp/k.txt：sk-ant-api03-<80位假值>
      （模型只看到 [REDACTED:ANTHROPIC_KEY#hash]；它发出的 write 工具参数就是占位符）
你：  /tmp/k.txt 里是什么？原样输出
      → 说得出真值 = 脱敏失败；只给占位符 = 生效
cat /tmp/k.txt   → 文件里是真实值（tool_call 还原生效）
```

### 4. 线上 payload 审计（每次发送自带证据）

`/secret audit on`——之后每次 provider 请求都会在最后一刻（`before_provider_request`，所有其他钩子之后）被扫描，并向 `~/.pi/agent/secret-mask-audit.log`（0600）追加一条证据：

```json
{"time":"...","sessionId":"...","strings":299,"placeholders":2,"leaks":0,"leakedLabels":[]}
```

- `leaks=0` 且 `placeholders>0` = 该次发送只有占位符上线的直接证据
- `placeholders` 随对话轮递增（对话携带占位符）——与脱敏生效的表现一致
- payload 中发现任何已登记真值 → 立即弹出 `secret-mask LEAK: ...` 报警通知
- 证据文件永不含真值（只有标签名）；`/secret audit show` 在会话内直接查看尾部

## 不做的事（已知局限，与业界同类一致）

- **session 文件保留原文**。pi 没有改写历史记录的钩子；脱敏只作用于模型/provider 边界。本地 transcript 本来就有你输入的原文。
- **无关键字上下文的裸值不自动检测**。直接贴一段没有 `key =` / `Authorization:` 形态的高熵串，规则看不见——这类用 `/secret add`。这是刻意的：裸高熵检测会在压缩 JS 上全面误报。
- **纯中文裸短语**不足约 8 个不同汉字时低于熵下限；加引号或 `/secret add`。
- **变换逃逸**（`${T:0:10}` 切片、重新编码的 base64）——`redactForms` 能兜住多形态（被行号拆散的 PEM 正文、JSON key 文件），其余如实存在局限。
- **图片不扫描**。
- 被提示注入的 agent 仍可把还原后的值发进网络命令外传——本工具防**意外泄露**，不防恶意 agent。审计层能发现真值出现在模型边界，但发现不了经还原后的 Bash 命令外传的值。同款警告见 keyshroud 的 security model。

## 共存

与 `keyshroud`（vault 系脱敏）及其他 `tool_result`/`context` 改写类扩展安全共存：钩子链按加载顺序链接，精确匹配的替换集互不相交（vault 值 vs 会话登记值）。

## 致谢与第三方声明

规则形状与方法论参照两个 MIT 项目——[claude-code-redact](https://github.com/karanb192/claude-code-redact)（Karan Bansal）与 [keyshroud](https://github.com/dinhkarate/keyshroud)（Daniel / EONSR）——以及公开的 [gitleaks](https://github.com/gitleaks/gitleaks) token 语料。本项目为独立实现；完整归属与许可文本见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。规则标签中的产品/厂商名仅是对凭据格式的指称性使用，无任何隶属或背书关系。

## 开发

```bash
npm test            # node --test，38 用例
npm run fp-corpus   # 误报语料复测（热缓存约 20 秒）
```

License: MIT。
