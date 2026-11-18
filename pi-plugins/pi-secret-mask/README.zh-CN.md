# pi-secret-mask

> **随手贴，不泄密。**

pi（[pi coding agent](https://github.com/earendil-works/pi-coding-agent)）的会话级密钥脱敏插件：你在 prompt 里粘贴的 token/API key/凭据，在**发送给模型之前**就被替换为形似凭据的不可读令牌 `rsec_a1b2c3d4`；模型在工具参数里原样引用该令牌时，执行前自动还原真值。

零运行时依赖（检测/替换引擎与加密持久版共享 `@aiti-ai/secret-mask-core`）。一次安装覆盖 TUI 与全部 pi-web 会话。

English: [README.md](README.md)

```
你:    我的 api key 是 sk-ant-api03-<80 字符>，写进 .env 的 ANTHROPIC_KEY
模型看到:  我的 api key 是 rsec_a1b2c3d4，写进 .env 的 ANTHROPIC_KEY
write 工具: ANTHROPIC_KEY=sk-ant-api03-<80 字符>   ← 执行前还原
session 文件: plain 档=原文；ephemeral 档=rsec_a1b2c3d4
```

为什么用 `rsec_<hash8>` 而不是 `[REDACTED:别名]`：安全对齐训练让模型把 `[REDACTED:*]` 理解为「已被拦截、拿不到明文」，从而拒绝放进工具参数。看起来像真凭据的令牌会被自然引用，而真值始终不出现在模型上下文里。

> 需要**跨会话持久、加密落盘、可被模型按别名查询**？装持久版 **`@aiti-ai/pi-secret-vault`**（`/vault add`、`vault_list` / `vault_get`）。两包共享同一引擎、同一会话内互斥（vault 优先，mask 自动停用）。

## 安装

```bash
pi install npm:@aiti-ai/pi-secret-mask@latest
# 或把路径加进 ~/.pi/agent/settings.json 的 packages
```

对**新启动**的会话生效（TUI / pi-web 每个会话都是独立 pi 进程）。运行中的会话不受影响。

## 命令

| 命令 | 作用 |
|---|---|
| `/secret add [<值>] [as <别名> \| --alias <别名>]` | 登记一个值（省略值时走隐藏输入，值不进对话）。别名让占位符在 `/secret list` 可读。 |
| `/secret list` | 占位符 → 别名/规则 的映射 + 打码预览。 |
| `/secret remove <别名\|标签\|占位符>` | 注销一个值（本会话内旧占位符引用仍可还原）。 |
| `/secret clear` | 清空全部。 |
| `/secret on` / `off` | 本会话脱敏开关。 |
| `/secret landing [plain\|ephemeral]` | 落盘策略（见下）。 |
| `/secret guard on\|off` | 拦截引用「本会话未挂载占位符」的工具调用（默认开）。 |
| `/secret strict on\|off` | 旁路一律拒绝（`!` 命令、摘要路径）而不是告警放行。 |
| `/secret rule list \| add <标签> <exact\|regex> <模式> [--fixed <文本>] [--global] \| remove <标签> \| reload` | 自定义规则（`~/.pi/agent/secret-mask-rules.json`，改动即时生效）。 |
| `/secret save <文件>` / `load <文件>` | 显式明文快照（0600）：文件名由你指定，系统不记忆、不自动加载，位置与安全自负。 |
| `/secret audit on\|off` / `show` | 每次发送的线上 payload 证明日志。 |
| `/secret status` | 状态摘要：landing、guard、strict、规则数、登记数、审计开关。 |

## 落盘三态（真值住在哪里）

| 档位 | session 文件 | 重启后找回 | 说明 |
|---|---|---|---|
| `plain`（默认） | 原文 | grep session / `/secret load <文件>` / 重新粘贴 | 现状；本地 transcript 本来就含你输入的值 |
| `ephemeral` | 只有 `rsec_*` 令牌 | **设计上不可能**（只在进程内存） | `message_end` 用脱敏副本替换落盘消息 |
| `vault` | 只有 `rsec_*` 令牌 | `/vault unlock` + `vault_get <别名>` 复活**稳定令牌** | 仅 `@aiti-ai/pi-secret-vault` 提供 |

档位只作用于当前会话，新会话回到默认档。

## 钩子一览

| 阶段 | 钩子 | 行为 |
|---|---|---|
| 输入边界 | `input` | vault/ephemeral 档：在**你输入的 prompt** 落盘前检测并改写成令牌（只靠 message_end 会晚于原文落盘）。plain 档原样放行。 |
| 发送边界 | `context` | 全 role 脱敏（user / assistant 文本与 thinking / toolResult / `!` 命令与输出 / 摘要消息）；自动检测只扫用户手写文本；钩子拿到的是深拷贝。 |
| system 段 | `context_with_system` | 补 `context` 看不到的 system prompt（AGENTS.md/项目说明里的值）。 |
| 用法约定 | `before_agent_start` | 注入 `secret_masking` 段：令牌**就是**可用凭据，原样复制，禁止拒用/索要明文/改写。 |
| 守卫 + 还原 | `tool_call` | 未挂载占位符 → `block` 并给出确切的恢复命令；已挂载 → 就地还原（任意工具任意参数）。 |
| 工具输出 | `tool_result` | 回显脱敏（`cat .env` 不再回灌上下文/落盘）。 |
| 落盘副本 | `message_end` | vault/ephemeral 档返回脱敏替换消息（role 保持不变）。 |
| 摘要 | `session_before_compact` / `session_before_tree` | 深替换摘要模型输入（messagesToSummarize / turnPrefixMessages / previousSummary / 树条目）。 |
| `!` 命令 | `user_bash` | 命中已登记值默认告警放行（尊重用户意图），`strict` 直接拒绝。 |
| 防护 + 证明 | `before_provider_request` | 改写兜底（默认开，无值零开销）+ `/secret audit on` 时对**最终 wire payload** 做真值泄漏扫描与占位符计数。 |

不透明 provider 字段（thinking/thought/text signature）一律不动。

## 检测规则与自定义规则

24 条确定性规则（正则 + 校验和 + 熵阈值 + 误报排除），无网络、无模型调用：AWS / GitHub / GitLab / Slack / Stripe / SendGrid / Twilio / Google / Anthropic / OpenAI / Hugging Face / npm / PyPI / Azure / JWT / PEM 私钥 / 带真密码的 DB URL / Authorization 头 / 泛型赋值；base64 包裹的令牌解码后再匹配；短于 6 字符的值不登记。中文关键词（密码/密钥/口令/令牌/授权码/凭证…）、全角冒号、拉丁-CJK 邻接均支持。

自定义规则文件（`mode: "placeholder"` 走正常脱敏+还原；`"fixed"` 单向替换）：

```jsonc
{
  "version": 1,
  "rules": [{ "label": "corp-token", "type": "regex", "match": "acme_[A-Za-z0-9]{32}" }],
  "projects": { "/home/me/repo": [{ "label": "local", "type": "exact", "match": "..." }] }
}
```

非法规则会被跳过并在 `/secret rule list` 中报告；文件按 mtime/size 懒加载（无定时器、无轮询）。

## 验证

- `npm test`（22 用例）+ 共享引擎套件（`@aiti-ai/secret-mask-core` 62 用例）：引擎 + pi 适配层 + 钩子接线（mock pi host 驱动 input/脱敏/guard/还原/message_end/compact/user_bash/provider/握手）。
- `npm run fp-corpus`：11 个固定公开仓（~42k 文本文件）误报语料。基线 65 命中全为真实形状 = **0 误报**（顺带清除 `token is configured.` 散文与 `${VAR:default}` 模板默认值两类误报）。
- 端到端：新会话里让模型复述刚写入文件的内容——它说不出真值才算生效。
- 线上证明：`/secret audit on` 每次发送追加一行证据（只含标签，绝不含真值）。

## 已知边界

- 无关键词上下文的裸值不会被自动检测（用 `/secret add`）。这是刻意设计：裸高熵检测会在压缩 JS 上狂误报。
- 低熵纯中文裸短语不检测；加引号或 `/secret add`。
- 变形值（切片、再编码）逃逸（`redactForms` 覆盖的多形态除外）。
- 图片不扫描。
- 流式工具输出不进模型上下文（pi 只把最终 toolResult 回灌，`tool_execution_update` 仅 UI 展示，已按 pi 1.5 核实），无需流式 scrub。
- plain 档下本机进程仍可读 session；在意就用 ephemeral/vault 档。另外被注入的模型仍可把还原后的真值塞进外联命令——本插件防**意外**泄漏，不防恶意 agent。

## 共存

与 keyshroud 等改写 `context`/`tool_result` 的扩展可共存（钩子链组合、替换集不相交）。与 **`@aiti-ai/pi-secret-vault`** 同会话时握手互斥：vault 优先，mask 自动停用。

License: MIT.
