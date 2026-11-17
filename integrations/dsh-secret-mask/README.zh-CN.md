# dsh-secret-mask

> **随手贴，不泄密。** — Paste-safe by default.

[DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness)的会话级 AI 脱敏插件：你贴进 prompt 的 token / API key / 凭据，在**一步进入模型之前**（`agent/pre-step`）自动替换为稳定占位符（如 `[REDACTED:github-token]`）；模型在工具参数里引用占位符时，在白名单工具的 shadow 包装层内**执行前还原为真值**。零运行时依赖。

检测核心逐字移植自 [@aiti-ai/pi-secret-mask](https://www.npmjs.com/package/@aiti-ai/pi-secret-mask)——同规则、同熵阈值、同占位符格式、同还原语义。与官方 `@deepseek-ai/dsh-client-ui-secret-mask`（只遮挡**浏览器显示**，模型输入保留原始字符）互补：本插件工作在**模型边界**。

```
你：  我的 api key 是 sk-ant-api03-<80位> —— 帮我写进 .env 的 ANTHROPIC_KEY
模型看到：我的 api key 是 [REDACTED:ANTHROPIC_KEY#a1b2c3d4] —— 帮我写进 .env ...
bash 工具：ANTHROPIC_KEY=sk-ant-api03-<80位>   ← shadow wrapper 执行时已还原为真值
session 日志：占位符持久落盘（pre-step 替换是 durable 的）
```

## 安装

```bash
dsh plugin --profile web add @aiti-ai/dsh-secret-mask
dsh --profile web --dump-config   # 核查 bundle 行已挂载
```

手动等价：profile 目录内 `pnpm add @aiti-ai/dsh-secret-mask`，再往 profile 的 `cordis.patch.yml` 插入：

```yaml
- insert:
    - id: dsh-secret-mask
      name: '@aiti-ai/dsh-secret-mask'
```

新会话在其下次 agent 创建时生效。

## 配置（按 profile 配置）

| key | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 全部脱敏/还原行为的总开关 |
| `autoDetect` | `true` | 对用户手写文本自动检测密钥形状的值 |
| `restoreToolArgs` | `true` | 白名单工具参数内的占位符还原（shadow 工具） |
| `audit` | `false` | 会话起始即打开线上 payload 审计 |
| `workspaceDir` | 进程 cwd | 持久化分桶键 |
| `auditPath` | `~/.dsh/secret-mask-audit.log` | 审计证据文件覆盖 |

## 命令

| 命令 | 作用 |
|---|---|
| `/secret add <值> [as <别名>]` | 登记一个值。**`recordInput: false`——值不进模型、也不落会话日志**（命令不会成为面向模型的消息）。 |
| `/secret list` | 已登记值清单（打码预览 `…****abcd`、来源、规则 id） |
| `/secret remove <别名\|标签>` / `clear` | 移除一个 / 全部 |
| `/secret on` / `off` | 本会话开/关脱敏 |
| `/secret status` | 状态总览（含审计状态与最近一次审计结果） |
| `/secret save` / `unload` | 把当前 workspace 的值持久化到 `~/.dsh/secret-mask.json`（0600，显式 opt-in）/ 清除 |
| `/secret audit on\|off\|show` | 每次发送的线上 payload 证明日志 |

## 工作机制

| 环节 | 钩子 | 行为 |
|---|---|---|
| 发送边界 | `agent/pre-step` | 对本步 claim 的 `UserMessage[]` 批（followup / steering / 注入上下文全走这里）逐 text block 自动检测（高置信规则）+ 脱敏已登记值。替换是**持久的**：会话日志存占位符。 |
| 约定注入 | `systemPrompt.section` | `secret_masking` 节（仅本会话已登记值时渲染）：占位符是不透明替身，引用时原样照抄进工具参数，禁止猜测真值。 |
| 执行边界 | `agent/session-start` shadow 工具 | 在 agent 域重注册 `bash`、`write`、`edit`、`str_replace_editor`，包装 `execute`：把占位符还原进参数深拷贝再委托原定义。管线冻结参数与模型可见的调用记录保持占位符。 |
| 工具输出 | `tools/post-execute` | 优先替换 canonical `value`（过 output schema 重校验；失败即阻断，不放行原值），退化为替换呈现 `content` 的 text block。 |
| 证明层 | `llm/stream` | opt-in：扫描最终上线 payload（**会话请求 + compaction/title 辅助调用**）中的已登记真值与占位符出现次数；证据追加到 `~/.dsh/secret-mask-audit.log`（0600，永不含真值）；发现任何真值立即 `secret-mask LEAK` 高声报警。 |

## 不做的事（已知局限，与 pi 版一致）

- **pre-step 替换在 DSH 是持久的**——本地会话日志存占位符而非原文（pi 的 transcript 留原文）。这是 DSH pre-step 替换的既定语义，特此明示。
- **无关键字上下文的裸值不自动检测**——直接贴一段没有 `key =` / `Authorization:` 形态的高熵串规则看不见；用 `/secret add`。
- 变换逃逸（`${T:0:10}` 切片、重新编码的 base64）——`redactForms` 能兜住常见形态，其余如实存在局限。
- 图片不扫描。
- `ctx.tools.restrict` 交互：shadow 白名单刻意收窄（bash + 文件写家族）；被 restrict 摘除的全局工具不会被包装（包装时校验可见性）。
- 被提示注入的 agent 仍可把还原后的值经网络命令外传——本工具防**意外泄露**，不防恶意 agent。审计层能发现真值出现在模型边界。

## 检测规则

确定性正则 + 校验和规则，无网络请求、无模型调用：AWS、GitHub、GitLab、Slack（token + webhook）、Stripe live、SendGrid、Twilio、Google API/OAuth、Anthropic、OpenAI、Hugging Face、npm、PyPI、Azure storage、JWT（解出 alg 头）、PEM 私钥（完整 + 截断）、带真实密码的 DB URL、`Authorization` 头、泛型 `key = "value"` 赋值（香农熵阈值 + 代码标识符/模板/URL 排除）、base64 包装的前缀型 token、中文关键词形态（`密码：xxx`、`授权码：xxx`，全角冒号、CJK 词边界）。误报防护：`plausibleSecret` 排除集、熵下限、近 miss 测试语料。归属见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 开发

```bash
npm test            # node --test — 50 用例（pi 套件移植 + DSH 适配套件）
npm run build       # esbuild → lib/index.js（host bundle）
npm run fp-corpus   # 11 个锁定公共仓的误报语料复测
```

License: MIT。aiti 生态组件，也可在任意 DSH profile（web / headless / acp）独立使用。
