# Show Your Plugins! 帖草稿（dsh-secret-mask 首发用）

> 发布位置：https://github.com/deepseek-ai/deepseek-harness/discussions （分类：Show Your Plugins!）
> 状态：草稿——待 @aiti-ai/dsh-secret-mask 上架 npmjs 后，把「安装」节的版本号核对一遍再发。
> 同帖可带 @aiti-ai/aiti-devtools-dsh 的补录说明（已发布 0.8.2，本次同步进入公共渠道）。

---

大家好，分享一个 DeepSeek Harness 安全插件：**`@aiti-ai/dsh-secret-mask`**（0.1.0，MIT，零运行时依赖）。

**随手贴，不泄密**：把 API key / token / 密码贴进对话时，插件在消息进入模型**之前**把真值替换为稳定占位符（`[REDACTED:github-token]` / `[REDACTED:ANTHROPIC_KEY#a1b2c3d4]`），模型只能看到占位符；当模型把占位符写进工具参数（比如让你把 key 存进 `.env`）时，`bash`/`write`/`edit`/`str_replace_editor` 的 shadow 包装层在**执行前**还原为真值——文件里是真值，模型与 session 日志里永远只有占位符。

## 五层能力

| 环节 | 钩子 | 行为 |
|---|---|---|
| 发送边界 | `agent/pre-step` | 高置信规则自动检测（AWS/GitHub/Slack/Stripe/Google/Anthropic/OpenAI/JWT/PEM/DB URL/Authorization/泛型赋值 + 中文关键词 `密码：`等 + base64 包装 token），熵阈值+校验和防误报；已登记值整会话持续脱敏 |
| 约定注入 | `systemPrompt.section` | 告诉模型占位符是不透明替身：引用时原样照抄进工具参数，禁止猜测 |
| 执行边界 | shadow 工具 | 参数占位符还原（deep clone，冻结参数不动；模型可见的调用记录仍是占位符） |
| 工具输出 | `tools/post-execute` | canonical value 先替换（过 output schema 校验，失败即阻断不放行原值），退化为 content 文本 |
| 证明层 | `llm/stream` | opt-in：扫描最终上线 payload（会话 + compaction/title 调用），证据追加 `~/.dsh/secret-mask-audit.log`（永不含真值）；发现真值立即 LEAK 报警 |

## 安装

```bash
dsh plugin --profile web add @aiti-ai/dsh-secret-mask
dsh --profile web --dump-config   # 确认 bundle 行
```

登记：`/secret add <value> [as <alias>]`——`recordInput: false`，**值不进模型也不落会话日志**。其余子命令：`list / remove / clear / on / off / status / save / unload / audit on|off|show`。

## 与现有方案的关系

- 官方 `dsh-client-ui-secret-mask` 只遮挡**浏览器显示**（模型输入保留原始字符）；本插件工作在**模型边界**，两者互补，可同装。
- 与 `dsh-redact`（tools/post-execute 输出令牌化）钩子链兼容（waterfall 链式，令牌格式不相交）；本插件额外覆盖用户输入脱敏、占位符还原与审计。

## 第一版的安全边界（如实说明）

- pre-step 替换在 DSH 是**持久的**：session 日志存占位符而非原文（DSH pre-step 语义；pi 版则是非破坏性深拷贝）。
- 无关键字上下文的裸高熵串不自动检测（防压缩 JS 误报的刻意取舍）——用 `/secret add`。
- shadow 白名单刻意收窄（bash + 文件写家族），避免与 `tools.restrict` 交互放大权限面。
- 防意外泄露，不防恶意 agent；审计层能发现真值出现在模型边界，发现不了还原后经 Bash 外传的值。

## 检测与误报

规则形状对标 gitleaks / GitHub secret-scanning 语料；单测含近 miss 语料（形状相邻但必须不命中）；另跑 11 个锁定公共仓（4.2 万+文件）的误报复测，0 误报基线。检测核心与 `@aiti-ai/pi-secret-mask`（pi 生态同名插件）逐字同源，两边同步演进。

欢迎反馈：还需要哪些凭据形态？shadow 白名单要不要扩大（如 `web` 工具的 header 注入）？engines.dsh 兼容范围（本版声明 `>=0.1.1-rc.0`，实测 0.1.1-rc.2 runtime 与 0.2.2-rc.1 launcher）？

npm：https://www.npmjs.com/package/@aiti-ai/dsh-secret-mask
源码：https://github.com/aiti-ai/aiti-ai （integrations/dsh-secret-mask）
市场索引（ Discover 页添加索引源即可浏览安装 aiti 系 dsh 插件）：
`https://raw.githubusercontent.com/aiti-ai/aiti-ai/main/integrations/dsh-market/index.json`
