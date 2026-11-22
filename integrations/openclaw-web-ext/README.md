# openclaw-web-ext

> OpenClaw 扩展作用域目录。承载 aiti-devtools → OpenClaw 迁移的宿主 adapter。

## 结构

```
openclaw-web-ext/
└── aiti-devtools-openclaw/     # ★@aiti-ai/aiti-devtools-openclaw —— OpenClaw 宿主 adapter 插件（已落地 v0.1）
    ├── openclaw.plugin.json    # manifest（id: aiti-devtools；contracts.tools 16 个，build 时生成）
    ├── package.json            # openclaw.runtimeExtensions + extensions → dist/index.js
    ├── tools/build.mjs         # 桥 MCP tools/list → dist/index.js（内嵌 16 工具定义，aiti_ 前缀）
    └── dist/index.js           # 生成物：default export {register(api)}；execute → POST 桥 REST
```

## 这是什么

OpenClaw 插件（**跳过 MCP**）：`api.registerTool` × 16 注册 `aiti_*` 工具进 OpenClaw agent 会话；
execute 直调桥 REST `POST /bridge/agent/tools/call {tool, args, agentId:'openclaw'}`（与 pi-web 扩展同款无状态直连）。

- 工具定义源：桥 `tools/list`（build 时拉取内嵌；桥加工具后重跑 `node tools/build.mjs`）
- 桥地址：`plugins.entries.aiti-devtools.config.bridgeUrl` > env `AITI_BRIDGE_URL` > `http://127.0.0.1:8777`
- 安装：`openclaw plugins install <本目录> --link` + `openclaw plugins enable aiti-devtools` + 重启 gateway

## 状态（2026-08-23/24 · 全部计划功能完成）

> **2026-11-07 复检（v0.6.8，openclaw 2026.10.10）**：dist 自活桥 tools/list 重新生成（pageId 兜底/截屏确认链/
> 设备信息/永久等待四组工具描述更新，51 行）+ build.mjs 版本号改随生成写入；网关重启后真实 turn 全链路复验——
> 会话自动上线（`会话上线 agent:main:dashboard:… → openclaw/…`）→ before_prompt_build → 模型调
> `aiti_bridge_status` → 答复已回桥（桥 JSONL agent_answer 落盘）✅。dingtalk 插件加载失败是第三方包
> （built with OpenClaw 2026.7.1-2）需 `openclaw plugins update dingtalk`，与本插件无关。

### P2 · client 面（伴生 AI 窗）—— ✅ 浏览器 E2E 验证

- **nginx `/aiti/` 代理**（`/etc/nginx/conf.d/openclaw.conf`）：`oc.pi.example.com:8443/aiti/*` → 独立桥 8777（带 Authelia；同源页 cookie 正常携带）。子路径：`/aiti/aiti-launcher.js`、`/aiti/cockpit.html`、`/aiti/bridge/*`、`/aiti/mcp` 全 200。
- **演示页 `/aiti-demo/`**（`/var/www/aiti-demo/index.html`）：已注入 launcher（桥 = `/aiti`，AI 窗 = `/aiti/cockpit.html`，同源无 cookie 问题）。
- **E2E 实证（chrome-devtools MCP 真实点击）**：page1=注入页、page2=cockpit AI 窗；`user_confirm` 工具调用 → cockpit 渲染确认卡（`❓ 确认 · FROM OPENCLAW/2DA722D2…`）→ 点 ✅ 是 → 工具返回 `{status:"answered",approved:true}`。**人与 OpenClaw 会话的交互闭环成立**。
- **跨域注入说明**：第三方页面注入 launcher 时，跨域 fetch 不携带 Authelia cookie → 用 `http://127.0.0.1:8777` 直连（LAN/dev），或同源页（/aiti-demo/ 模式）。公网跨域需桥鉴权方案（未做，见遗留）。

### v0.6（占位符改写 —— DSH pre-step 等价物）—— ✅ 端到端验证（2026-08-24）

- **三层实现**：
  1. `before_prompt_build`（async，可 fetch）：prompt 含占位符 → fetch 桥 picked（agentKey→agentId→`__all__` 三级回退）→ **prependSystemContext 注入「展开对照表」**；sessionKey 在 **ctx 第二参**（event 上没有）。
  2. `before_message_write`（⚠ **同步 hook**，async 返回值被忽略）：用 **pickedCache**（SSE 推送到达时预取）同步展开落盘 + `notifyConsumed`（aiti_consumed → AI 窗清候选）。
  3. **matched-filter**：只展开与本文匹配的 tag（桥 picked 全局单键，多宿主并发会互相覆盖）。
- **端到端实证**：模型原样引用对照表——「本轮用户消息占位符展开对照：[元素3] = <button id="net">发个 404</button>… [发自: ro572/host…]」并正确理解元素。（免费模型偶发不利用 system 段，机制已验证）。
- **core 同步修复：picked 持久化**（`bridge.ts`）：`pickedReports` 内存 Map → `dataDir/picked.json` 启动加载/更新即写——桥重启不再丢候选（多宿主/升级场景）。独立桥重启实测候选存活。
- **深层架构结论**：OpenClaw 的 bmw 改写只影响 transcript，本轮模型输入在组装期冻结；能进模型输入的只有 bpb 的 prepend/appendContext/prependSystemContext（`composeModelPromptContext` = prepend + prompt + append）。与 DSH pre-step 整段替换的等价物 = 对照表注入。

### v0.5（cockpit 消息进循环）—— ✅ 端到端验证（2026-08-24）

**背景**：v0.2 的「推送链路全通」是误判——`scheduleSessionTurn` 对非 bundled 插件被 origin 门拦（`host-hook-scheduled-turns.ts: if (origin !== "bundled") return undefined`，静默无错），当时模型看到消息是因为 push 落桥 outbox 后下一轮调了 `aiti_inbox`。真要「cockpit 主动发消息立即进循环」需 v0.5：

1. **会话自动上线**（前置）：`api.on("session_start")` + `before_message_write` user 消息兑底 → `POST /bridge/agent/register` + 开 SSE 流——**不等调过工具**。cockpit 的 agents 列表实时出现新会话。（坑：bmw 的 ctx 只有 `{agentId, sessionKey}`，sessionId 从 sessionKey 尾段派生）
2. **消息注入双路**：① `enqueueNextTurnInjection`（下一轮可见，非 bundled 可用，无 origin 门）；② **`registerHttpRoute('/aiti-devtools-push', auth:'gateway', gatewayRuntimeScopeSurface:'write-default')` + `dispatchGatewayMethod('chat.send', {sessionKey, message, idempotencyKey})`**（立即触发一轮）。
3. **实测**：cockpit push → 插件 SSE → chat.send → turn 跑 → 模型回复「chat-ok」→ `agent_answer` 落盘桥 JSONL。

**踩坑记录（v0.5 全套）**：auth:'plugin' 路由 runtimeScopes 恒空（operator.write 必败）→ 必须 auth:'gateway' + Bearer gateway token；chat.send 必填 `idempotencyKey`；插件 loader 禁 top-level await（动态 import 放函数内）。

### v0.3（答复回传）—— ✅ 端到端验证

- **答复回传**：`api.on("before_message_write")`（assistant 终稿落盘前触发）→ sessionKey 匹配已知 aiti 会话 → `POST /bridge/agent/answer`（AI 窗/页面实时显示）。桥 JSONL 实证：`{"kind":"agent_answer","from":"agent","agentId":"openclaw","text":"Sessions count: 2."}`。
- **三个踩坑**（已固化）：
  1. typed hook 必须用 `api.on(...)`（`registerHook` 走 legacy 内部路径不触发）；
  2. `before_agent_reply` 仅渠道投递路径触发（CLI/web 直答不触发）→ 改用 `before_message_write`；
  3. 非 bundled 插件需 `openclaw config set plugins.entries.aiti-devtools.hooks.allowConversationAccess true`（会话访问安全门）。
- **过滤**：只回传本插件记录过的会话（调过 aiti 工具），钉钉等其它渠道回复不灌桥。

### v0.2（身份接线 + 推送）—— ✅ 端到端验证

- **身份接线**：toolContext（`agentId/sessionId/sessionKey/workspaceDir`）→ 桥会话。桥侧 `/bridge/agents` 实证：`openclaw/2da722d2-… registered:True cwd:/home/pi/.openclaw/workspace online:True agentStream:True`（真实 OpenClaw session UUID）。
- **桥推送 → 会话注入**：每会话开 `GET /bridge/agent/sse`（空闲 60s 重连）；收到 `agent_push/page_event` → `api.session.workflow.scheduleSessionTurn({sessionKey, message, delayMs:0, deleteAfterRun:true})` 立即触发一轮。实测：`POST /bridge/push` → 桥 `stream+delivered` → 插件日志 → 下一 turn 模型原样引用推送内容并确认。**与 pi 扩展 `sendUserMessage(steer)` 同语义，比 DSH 占位符方案干净（无需 host 替换）**。

### v0.1（工具直连）—— ✅

- `api.registerTool`×16 → `POST /bridge/agent/tools/call`（REST 直连，无 MCP）；gateway-backed turn 可见（`plugins inspect --runtime` 列 16 工具）。
- 模型：`models.providers.openrouter`（pi models.json 拷贝，免费模型实测 `nvidia/nemotron-3.5-lightning:free` 可用；`z-ai/glm-5.2:free` 上游限流、`thinkingmachines/inkling:free` 仅限 agent harness）+ auth profile `openrouter:manual`；`agents.defaults.model.primary` 已切。

## 遗留（后续可选）

- **公网跨域注入鉴权**：桥端点无自身鉴权（loopback 信任）；若要公网跨域页面注入，需加 token/签名方案。
- **dashboard widget 候选卡**：cockpit 伴生页已覆盖 AI 窗需求；widget 方案待需要时再评估。
- **dingtalk 插件告警**：`plugins.entries.dingtalk` duplicate id + `llm_output` hook 被 allowConversationAccess 门挡（不影响功能；若需 dingtalk 统计可同样开授权）。
- **MCP 路线已撤**：`openclaw mcp unset aiti-devtools`（用户决策：不折磨 MCP；桥 streamable 能力另行保留）。
