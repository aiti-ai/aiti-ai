# aiti-devtools → DSH 移植方案

> **范围**：把 aiti-devtools（页面内 AI 调试助手）的主要功能移植到 DeepSeek Harness（DSH）。
> **目标**：同样的集成 JS launcher，AI 窗地址 = DSH（`https://dsh.pi.example.com:8443`），与 pi-web 集成同等体验，agent 使用同样的 `aiti_*` 命令。
> **本文件**：`dsh-web-ext/PLAN.md` —— 独立扩展宿主目录（对齐 `pi-web-ext/`），本目录承载 DSH 侧扩展源码与方案。
> **关联**：`../docs/aiti-devtools-launcher-architecture.md`（launcher 模块地图）、`../docs/aiti-devtools-integration-guide.md`（载体接入）、`../docs/dsh-deployment.md`（DSH 部署）、`../docs/dsh-adapter-assessment.md`（适配评估）。

---

## 0. 一句话

在 **DSH 里写一个 Cordis 插件**，通过 `ctx.tools.register()` 把**独立桥**的 `aiti_*` 工具注册进 DSH agent 会话（execute 直调桥 `callTool`），并接通**桥 ⇄ agent 会话**的双向消息（推送 → `agent.followup()`；agent 答复 → `bridge.answer()`），再把 **AI 窗 aiUrl 指向 DSH**。launcher/client 复用现成 `aiti-launcher.js` 产物，不改。

---

## 1. 目标与范围

### 1.1 要达成
- ✅ 目标页注入**同样的 launcher**（`aiti-launcher.js`，UI+client 二合一，不改）。
- ✅ **AI 窗 = DSH**：launcher 的 aiUrl 指向 `https://dsh.pi.example.com:8443`，在目标页 iframe 里嵌入 DSH web UI；DSH 页面跑 `aiti-client.mjs` 适配层连桥。
- ✅ **agent 用同样命令**：DSH agent 会话内出现 `aiti_page_exec` / `aiti_user_confirm` / `aiti_aiti_inbox` 等 15 个 `aiti_*` 工具，行为与 pi-web 一致。
- ✅ **同等体验**：目标页点 🧰 按钮开 AI 窗 / 页面注入 / 选区 / 危险命令确认 / 人机交互（confirm/choose/input/presence/notify）都在 DSH 里可用。

### 1.2 范围边界
- **dsr 不做**：不移植 pi-web 的 `service-tunnels`（HTML 自动注入 / vhost 安全门 / 端口登记）到 DSH——DSH 页面注入先用「手动 `<script>`」+「DSH 注入端点」两种，自动注入按需后加。
- **不重写桥核心**：复用 `packages/aiti-devtools-core` 与独立桥 `packages/aiti-bridge/bin/aiti-bridge.mjs`（消息/会话/CTP 命令集/危险命令/通知链路全复用）。
- **框架不移植**：不把 pi-web 的扩展宿主框架搬到 DSH；DSH 用自家 Cordis 插件模型承载。

---

## 2. 现状机制（pi-web 版 + 新 agent 接线层，移植蓝本）

> **2026-08-22 重构后**：接线逻辑已抽成 `packages/aiti-devtools-agent`（AgentBridgeClient + AgentHost + mapBridgeTools），pi / DSH 共用，不再各写一套。

```
目标页(injected launcher)
   │  postMessage / SSE
   ▼
桥（packages/aiti-devtools-core 核心；pi-web 在 /api/extensions/aiti-devtools/mcp/*，独立桥在 packages/aiti-bridge）
   │  ▲  callTool / registerAgent / answer / SSE
   ▼  ▲
接线层（packages/aiti-devtools-agent）
   · AgentBridgeClient：桥 HTTP/SSE 客户端（callTool/register/probe/answer）
   · AgentHost 契约：kind / currentSession / registerTool / injectToModel / notify
   · mapBridgeTools + wrapToolResult：桥 16 工具 → 宿主工具定义/返回值 通用映射
   · jsonSchemaToTypeBox（可选子路径）
   ▼  ▲
宿主 adapter（pi-web / pi / DSH）——只实现 AgentHost + 宿主注册 API
```

**AI 窗**：launcher iframe 嵌入 `aiUrl`（pi-web 版 = pi-web 根页）；AI 窗页加载 `pi-web-ext/aiti-devtools/client/aiti-client.mjs` 适配层，把「桥协议 ⇄ 页面」打通。`aiUrl` 由 launcher 的 `data-ai-url` 属性 / `ctx.cfg.aiUrl` / `ctx.loadCustomAiUrl()` 决定（`packages/aiti-devtools-inject/src/launcher/aiwin.js`）。

---

## 3. 目标架构（DSH 版）

```
目标页(injected launcher: packages/aiti-devtools-inject 构建产物)
   │  （桥协议，复用）
   ▼
独立桥 packages/aiti-bridge/bin/aiti-bridge.mjs（常驻，默认 127.0.0.1:8777 —— 复用不改）
   │  ▲  AgentBridgeClient(callTool/register/answer/SSE) + AgentHost 接线层
   ▼  ▲
DSH agent 会话（dsh-web-ext 薄 adapter —— 实现 AgentHost + DSH 注册 API，复用 aiti-devtools-agent）
   · registerTool(def)  → 包装成 DSH ToolDefinition → ctx.tools.register()（补 output）
   · injectToModel      → agent.followup(createUserMessage(...))（桥推送 → 模型）
   · notify             → DSH 通知/日志
   · 会话/工具/交互：mapBridgeTools + AgentBridgeClient（复用）
```

**AI 窗**：launcher iframe 嵌入 `aiUrl = https://dsh.pi.example.com:8443`（DSH web UI）。DSH 页（或配套页）加载 `pi-web-ext/aiti-devtools/client/aiti-client.mjs` 适配层连桥。

### 3.1 路线选择（评估 §3.1 的两条）

| | 路线 A（薄插件 + 独立桥）—— 推荐先做 | 路线 B（深度集成） |
|---|---|---|
| 桥 | 独立桥 `aiti-bridge.mjs` 常驻，不改 | 桥路由挂 DSH `ctx.webServer` + index tap 注入 launcher |
| 工具注册 | DSH 插件 `ctx.tools.register()`（进程内，优于走 MCP） | 同（但工具调用自动进 Session Log 审计） |
| 代码量 | 小 | 大 |
| 风险 | 低 | 中（DSH webServer/前端注入耦合） |
| 结论 | **先做** | 后做（可选增强：审计/天然同服） |

**本方案按路线 A 落地**，路线 B 作为后续增强对照。

---

## 4. 目录结构

> **实际落地**：DSH adapter 是 **`dsh-web-ext/aiti-devtools-dsh/` 包**（作用域 `@dsh-web-ext/*`），不在 `packages/`；`dsh-web-ext/` 是 DSH 扩展作用域目录（后续 DSH 相关包/文档收集处）。

```
dsh-web-ext/                               # DSH 扩展作用域（@dsh-web-ext/*）
├── PLAN.md / README.md                    # 本方案 + 目录说明
├── aiti-devtools-dsh/                     # ★DSH 宿主 adapter 包（已建）
│   ├── package.json                       # name: @dsh-web-ext/aiti-devtools-dsh；deps: aiti-devtools-agent；peerDeps: @deepseek-ai/*
│   ├── src/index.ts                       # DSH Cordis 插件入口 apply：连桥 + 拉工具(MCP tools/list) + mapBridgeTools + connectAgentStream
│   ├── src/agent-host.ts                  # ★实现 AgentHost（kind=dsh；registerTool→ctx.tools.register；injectToModel→agent.followup；notify）
│   ├── tools/build.mjs                    # esbuild → dist/aiti-devtools-dsh.js（外部 @deepseek-ai/*）
│   ├── dist/aiti-devtools-dsh.js          # 构建产物（内嵌 aiti-devtools-agent）
│   └── README.md
└── (后续 DSH 相关包/文档：cordis.patch.yml 装配 / deploy 等)
```

> 复用来源：`packages/aiti-devtools-agent`（接线层）、`packages/aiti-devtools-core/assets`（产物）、`packages/aiti-devtools-inject`（注入源）、`packages/aiti-bridge`（独立桥）。**DSH 侧代码集中在 `dsh-web-ext/aiti-devtools-dsh/`。**

---

## 5. 组件设计

### 5.1 DSH adapter（agent-host.ts + index.ts）—— 复用 aiti-devtools-agent

**核心**：不再自建桥 HTTP 客户端/工具映射；`dsh-web-ext` 实现 `AgentHost`，用 `mapBridgeTools` 注册 16 个工具，`AgentBridgeClient` 连桥。DSH 侧只需把 `HostToolDef` 包装成 DSH `ToolDefinition`（补 `output` + 映射 `execute(args, exec)`）。

```ts
// agent-host.ts —— 实现 AgentHost
import { AgentBridgeClient, mapBridgeTools, wrapToolResult, type AgentHost, type HostToolDef } from 'aiti-devtools-agent';
import { createUserMessage } from '@deepseek-ai/dsh-...';  // DSH 消息构造（按 DSH 实际导出）

export function createDshAgent(ctx, bridgeUrl: string): AgentHost {
  const bridge = new AgentBridgeClient(bridgeUrl);
  const agentOf = (agentKey: string) => /* agentKey → Agent 对象（ctx.get('agents') + session 映射） */;
  return {
    kind: 'dsh',
    currentSession: () => /* 当前 agent 会话 */ null,
    // registerTool：HostToolDef → DSH ToolDefinition
    registerTool(def: HostToolDef) {
      ctx.tools.register({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        // DSH 强制 output；agent 层已预留（HostToolDef.output / MapBridgeToolsOptions.output）
        output: def.output ?? { schema: { type: 'object' }, render: (a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] },
        // DSH: execute(args, exec)；把 exec.signal 透传给 agent 层 execute(args, signal)
        async execute(args, exec) { return def.execute(args as Record<string, unknown>, exec?.signal); },
      });
    },
    injectToModel(agentKey, text, opts) {
      void agentOf(agentKey).followup(createUserMessage({ role: 'user', content: text })).catch(() => {});
    },
    notify(text, kind) { /* DSH 日志/通知 */ },
  };
}
```

```ts
// index.ts —— DSH Cordis 插件入口（apply）
export function apply(ctx: Context, config: { bridgeUrl: string }) {
  const host = createDshAgent(ctx, config.bridgeUrl);
  const bridge = new AgentBridgeClient(config.bridgeUrl);
  // ⚠️ 工具清单获取：AgentBridgeClient 无 tools()。DSH 跨进程拿 BridgeTool[] 需调
  // 桥 MCP tools/list —— POST {bridgeUrl}/mcp, 先 initialize 再 tools/list（桥 core `case "tools/list": return {tools:TOOLS}`）。
  const tools = await fetchBridgeTools(bridge);   // 或给 AgentBridgeClient 加 tools()（推荐小改进）
  mapBridgeTools(tools, host, {
    prefix: 'aiti_',
    descriptionSuffix: 'aiti-devtools 直连，DSH 会话',
    output: () => ({ schema: { type: 'object' }, render: (a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] }),
    // AgentCallOptions 形状 = { agentId, sessionId, cwd?, cancelId? } —— 从 currentSession() 展开，不是 { session }。
    execute: (tool, args, signal) => bridge.callTool(tool.name, args, { ...(host.currentSession() ?? {}), }, signal)
      .then(wrapToolResult)   // → { content:[{text}], details, isError? }
      .then(r => r.content[0]?.text ?? ''),  // DSH execute 返回 lossless 值；render 再把它变文本
  });
  // agent 会话生命周期：ctx.on('agent/status'...) → 桥 register + connectAgentStream → injectToModel；完成 → bridge.answer
}
```

> 对照：`AgentBridgeClient`（`packages/aiti-devtools-agent/src/bridge-client.ts`：probe/register/callTool/answer/connectAgentStream，**无 tools()**）；`AgentCallOptions={agentId,sessionId,cwd?,cancelId?}`；`wrapToolResult(r:AgentCallResult): HostToolResult`；`BridgeTool={name,description,inputSchema}`。DSH 侧 `createUserMessage` 在 `packages/llm/llm/src/message.ts:192`；`agent.followup/steer/inject(message: UserMessage)` 在 `packages/core/agent-loop/src/agent.ts`、`agent/runtime-types.ts`；`ctx.get('agents').get(agentId)` 取 Agent（agent.id = SessionId）。

> **DSH 规范**：`ToolDefinition` 必带 `output:{schema, render}`；`execute(args, exec)`（`exec.signal`=中止）。`HostToolDef.execute(args, signal)` 已是 agent 层约定，DSH 侧只需一处薄转换（`def.execute(args, exec?.signal)`）。
>
> 对照：DSH `core/tools` 的 `ctx.tools.register(def): ()=>void`（`packages/core/tools/src/index.ts:1037`）；`ToolDefinition`/`ToolOutputDefinition`（同文件 212）。agent 层 `HostToolDef`/`MapBridgeToolsOptions.output` 已为 DSH 预留（`packages/aiti-devtools-agent/src/agent-host.ts`）。
> ⚠️ **修正点**：DSH 无单一的 `onAgentSession`/`addHook('settled')`。实际挂接用 `ctx.on('agent/status')`、`ctx.on('agent/inbox/claimed')`、`ctx.on('session/event')`、`ctx.on('agent/request-error')` 等核心事件（见 `packages/acp/acp/src/index.ts`、`packages/compaction/compaction-basic/src/index.ts` 均用此模式），并用 `ctx.get('agents')` 取 Agent。对应 DSH **`agent.followup(createUserMessage(...))`** 在非空闲 agent 上立即开一轮。**具体用哪个事件激活/完成信号，需在 P1 落地时按 agent 状态机确认。**

**用户交互映射**（interact.ts）—— ⚠️ 精确 API 是 `ctx.userQuestions.ask()`：
| 桥工具 | DSH 映射 |
|---|---|
| `aiti_user_confirm` | `ctx.userQuestions.ask({ questions:[{...confirm}], agent, signal })`（`packages/interaction/user-questions`）|
| `aiti_user_choose` | 同上（questions[0].options = 选项列表）|
| `aiti_user_input` | 同上（questions[0].options 可为 free-text 类型）|
| `aiti_user_presence` | `ctx.userQuestions.ask()` 快速问询 或 桥侧实现 |
| `aiti_user_notify` | DSH 非阻塞通知（若无原生 → 桥侧实现 + followup 回告）|

> 已确认：`ctx.userQuestions`（`UserQuestionService`，`registerProvider` + `ask(request: AskUserQuestionRequest){questions[], agent, signal}`）；`ctx.approval`（`ApprovalService`，`approval/request` waterfall）。**映射时把桥工具参数转成 `AskUserQuestionRequest`，答案从 `ask()` 返回结构取回填给模型。** 若 DSH 无原生「在场/通知」等价 API，保留桥侧实现 + `agent.followup()` 回告。

### 5.2 桥（复用 aiti-devtools-agent + aiti-bridge）

- 复用 `packages/aiti-devtools-core`（桥核心）+ `packages/aiti-bridge/bin/aiti-bridge.mjs`（独立桥 CLI）。
- DSH adapter 用 `packages/aiti-devtools-agent` 的 **`AgentBridgeClient(base)`**（HTTP/SSE 连独立桥），不再自建客户端。
- 不重写桥核心；DSH adapter 只做「DSH 侧接线」。

### 5.3 launcher 注入（inject.ts）

- 复用构建产物 `packages/aiti-devtools-core/assets/aiti-launcher.js`（由 `packages/aiti-devtools-inject/tools/build.mjs` → `core/tools/build-assets.mjs` 生成）。
- **注入方式**（先做前两种）：
  1. **手动**：目标页加 `<script src="{bridgeHost}/aiti-launcher.js" data-ai-url="https://dsh.pi.example.com:8443" data-bridge-url="http://127.0.0.1:8777"></script>`。
  2. **DSH 注入端点**：DSH adapter `ctx.webServer` 挂 `/aiti/aiti-launcher.js` + `/aiti/cockpit.html`（或 `/aiti/ai.html`），供目标页加载；同时开放 `/aiti/inject`（返回带内容哈希 `?v=<hash>` 的注入脚本片段 + `data-ai-url` 自动拼成 DSH 地址）。
  3. **自动注入**（可选，路线 B / 后加）：DSH webserver index tap 在目标页 HTML 响应里注入（需目标页也走 DSH 反代，vhost 场景）。

**aiUrl 决定**（`packages/aiti-devtools-inject/src/launcher/aiwin.js` + `standalone.js`）：launcher 读 `data-ai-url` → `ctx.cfg.aiUrl` → `ctx.loadCustomAiUrl()`；`data-ai-url="https://dsh.pi.example.com:8443"` 即让 AI 窗 = DSH。

### 5.4 AI 窗 = DSH（client/）

- **DSH 侧**：让 DSH web UI（或一个 DSH 包装页）能加载 `pi-web-ext/aiti-devtools/client/aiti-client.mjs` 适配层，驱动连桥、控制目标页 launcher。
- **两条路**：
  - A：在 DSH 里加一个配套入口（如 DSH 插件注册 `/aiti/ai.html` 的路由），该页 iframe 嵌 DSH web UI + 挂 `aiti-client.mjs`（与 pi-web 的 `ai.html` 同理）。
  - B：直接在 DSH web UI 里挂 `aiti-client.mjs`（DSH 扩展 UI 插槽 / 脚本注入），更接近 pi-web「根页即 AI 窗」的体验——**工作量大**，属于 P2。
- `aiUrl` 统一 = `https://dsh.pi.example.com:8443`，该页用 `aiti-client.mjs` 的协议委托（host-protocol）与桥双向通信。

---

## 6. 工具清单（16 个 `aiti_*` → DSH）

复用桥的 TOOLS（`packages/aiti-devtools-core/src/bridge.ts`），DSH 侧经 `aiti-devtools-agent` 的 `AgentHost` + `mapBridgeTools` 自动映射。分组：
- **页面调试**：`aiti_page_exec` / `aiti_page_snapshot` / `aiti_self_ui` / `aiti_form_fill` / `aiti_bridge_status` / `aiti_page_logs` / `aiti_page_network`
- **用户交互**：`aiti_user_pick_element` / `aiti_user_confirm` / `aiti_user_choose` / `aiti_user_input` / `aiti_user_presence` / `aiti_user_notify`
- **agent 会话**：`aiti_aiti_hello` / `aiti_aiti_inbox` / `aiti_file_stat`

> 工具名/描述/入参 schema 与桥同源 → DSH 插件从 `bridge.tools()` 读取即可，勿重复维护（与 pi-web `features` 同原则）。

---

## 7. DSH API 映射速查

| DSH / agent 层能力 | 位置 | 用途 |
|---|---|---|
| **`AgentBridgeClient(base)`** | `packages/aiti-devtools-agent/src/bridge-client.ts`（probe/register/callTool/answer/connectAgentStream；**无 tools()**）| 连桥 + callTool/注册/SSE 推送 |
| `mapBridgeTools` / `wrapToolResult` | `packages/aiti-devtools-agent/src/agent-host.ts` | 桥 16 工具→宿主工具映射 / 返回包装 |
| `AgentHost` 契约 | `packages/aiti-devtools-agent/src/agent-host.ts` | DSH 实现：kind/currentSession/registerTool/injectToModel/notify |
| `ctx.tools.register(def)` | `packages/core/tools/src/index.ts:1037` | 注册每个 `aiti_*` 工具（**需 `output:{schema,render}`**）|
| `ToolDefinition` / `ToolOutputDefinition` | `packages/core/tools/src/index.ts:212` | 工具须满足的契约（name/description/parameters/output）|
| `createUserMessage(...)` | `packages/llm/llm/src/message.ts:192` | 构造 UserMessage 注入模型 |
| `agent.followup/steer/inject(msg: UserMessage)` | `packages/core/agent-loop/src/agent.ts`、`agent/runtime-types.ts` | 桥推送 → 模型立刻看到 |
| `ctx.get('agents').get(id)` / `.roots()` | agents registry | 按 SessionId 取活 Agent 对象 |
| `ctx.on('agent/status')` 等 | 核心事件（acp / compaction-basic 均此模式）| 会话生命周期信号（registerAgent / answer 时机）|
| `ctx.userQuestions.ask(req)` | `packages/interaction/user-questions` | 映射 user_confirm/choose/input |
| `ctx.approval` | `packages/interaction/user-approval`（`approval/request` waterfall）| 审批/危险确认 |
| `ctx.webServer` 路由 / `register` | `packages/host/webserver` | 挂 `/aiti/*`（launcher/assets/ai.html）|
| webserver `tapIndex` / `index-inject` | `packages/host/webserver` | 目标页 HTML 自动注入 launcher（选做）|
| `ctx.plugin(...)` / bundler（`dsh.bundle`）| 插件机制 | 把本扩展作为 profile 插件挂进 web profile |

---

## 8. 分阶段实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 · 链路** | 独立桥 `packages/aiti-bridge/bin/aiti-bridge.mjs` 常驻；手工注入 launcher 到测试页，aiUrl 先用桥自带 `cockpit.html` | 目标页 🧰 可用，AI 窗 cockpit 显示 |
| **P1 · 工具** | DSH Cordis 插件 `index.ts`/`tools.ts`：注册 16 个 `aiti_*` 工具（execute→桥 callTool）；`session.ts`：agent 会话生命周期 + 推送→`followup()` + settled→`answer()` | DSH 会话里出现 `aiti_*` 工具，可 `aiti_page_exec` 控制目标页 |
| **P2 · AI=DSH** | `client/aiti-client.mjs` 适配层 + DSH 插件挂 `/aiti/ai.html`（iframe 嵌 DSH + 挂 aiti-client），aiUrl 换成 `https://dsh.pi.example.com:8443` | launcher 打开 AI 窗 = DSH，人机交互（confirm/choose/input）经桥进 DSH |
| **P3 · 增强（选做）** | 路线 B：桥挂 DSH `ctx.webServer` / index tap 自动注入 / 工具调用自动进 Session Log | 更集成、审计免费 |

> P0/P1 是打通「agent 用同命令」的最小闭环；P2 是「AI 窗=DSH」的核心，量最大。

---

## 9. 验证

1. **launcher 注入**：目标页出现 🧰 按钮（`aiti-launcher.js` 注入成功）。
2. **DSH 工具**：DSH 会话工具清单含 `mcp__*`/`aiti_*`；`aiti_page_exec` 能在目标页执行 `Runtime.evaluate`。
3. **双向消息**：人经 AI 窗发消息 → DSH 模型立即看到（`followup`）；DSH agent 答复 → 目标页/AI 窗收到（`answer`）。
4. **人机交互**：`aiti_user_confirm/choose/input` 在 AI 窗弹卡，作答回填给模型。
5. **aiUrl**：`data-ai-url=https://dsh.pi.example.com:8443` → AI 窗 iframe 为 DSH。

---

## 10. 风险与坑

- **DSH 是复杂 React SPA**：让 AI 窗 = DSH（P2）需要 DSH 页面跑 aiti-client 或做包装页，工作量大；P0/P1 先用 cockpit 验证链路，P2 单独攻坚。
- **工具注册必须满足 DSH `ToolDefinition`**：`execute(args, exec)`（非 `(params, signal)`）、**必须 `output:{schema,render}`**——桥工具是 MCP 形状（`{content:[{text}]}`），需适配成 output.schema 允许的 lossless JSON 值。skip 掉会直接 `TypeError`（register 硬校验）。
- **桥协议载体无关但要稳**：桥协议唯一来源 `packages/aiti-devtools-core`；DSH 插件只写接线层，别复制协议。
- **DSH 工具 AbortSignal**：DSH 停止 → 透传桥 `callTool` 的 signal，桥侧挂起即时结算（与 pi-web execute 同）。
- **会话生命周期无单一钩子**：DSH 用 `ctx.on('agent/status')`/`ctx.on('agent/inbox/claimed')` 等核心事件 + `ctx.get('agents')` 取 Agent；**没有像 pi-web `server.agent` 那样的 `onAgentSession/settled` hooks**，激活/完成信号需按 agent 状态机在 P1 落地时确定。
- **注入依赖反代**：自动注入需目标页也走 DSH 反代（vhost）；先手动 `<script>`，自动注入按需（避免与 DSH 前端/其它扩展冲突）。
- **`git pull` 覆盖**：DSH 是源码 clone，插件若改 DSH 内部（碰 `packages/*`）会被上游覆盖；**优先做成外置 profile 插件**（`dsh-web-ext` 独立，用 `dsh plugin add` 挂进 web profile），只依赖公开的 `ctx.*` API。
- **工具名归一化**：DSH `ctx.tools` 对 64 字符/字符集有归一化规则；`aiti_<桥名>` 名都短且合法（16 个均在 64 字符内、无非法字符），料不触发改写。
- **全局工具可见性已确认**：default `standard` preset **不用 allow/deny 屏蔽全局工具** → 宿主 `ctx.tools.register` 的 `aiti_*` 对 agent 会话可见（`layers.admits` 默认放行）。

---

## 11. 复用关系总览

| 组件 | 来源（重构后） | DSH 侧改动 |
|---|---|---|
| launcher/client | `packages/aiti-devtools-inject`（`core/assets/aiti-launcher.js` 产物）| 复用，不改 |
| 桥核心 / 独立桥 | `packages/aiti-devtools-core` + `packages/aiti-bridge/bin/aiti-bridge.mjs` | 复用，不改 |
| **agent 接线层（★新增）** | `packages/aiti-devtools-agent`（AgentBridgeClient + AgentHost + mapBridgeTools + wrapToolResult + jsonSchemaToTypeBox）| **直接复用**——DSH 只写 AgentHost adapter |
| AI 窗适配层 | `pi-web-ext/aiti-devtools/client/aiti-client.mjs` | 复用（或按 DSH 壳微调）|
| 工具定义 | 桥 `bridge.tools()`（经 AgentHost）| 只做 `mapBridgeTools`（补 output）|

---

## 12. 下一步（P0 启动）

1. 起独立桥：`node ~/workspace/pi-work/packages/aiti-bridge/bin/aiti-bridge.mjs --port 8777 --register-mcp`。
2. 准备测试页 + 手工注入 `<script src="http://127.0.0.1:8777/aiti-launcher.js" data-ai-url="http://127.0.0.1:8777/cockpit.html" data-bridge-url="http://127.0.0.1:8777">`。
3. 验证 cockpit 链路 → 进入 P1 写 DSH adapter（复用 `aiti-devtools-agent` 的 AgentHost）。

---

## 13. 审核结论（深入完成度）

### 13.1 已核实（对源码/文档逐条验证，非假设）

| 断言 | 验证点 | 结论 |
|---|---|---|
| **全局工具对 agent 会话可见** | default `standard` preset 不调 `restrictGlobalTools`（全仓无调用）；preset 工具行注册进 scope 层；`view(scope)` 按 `layers.admits` 过滤（默认放行）| ✅ 方案成立基石 |
| 桥 core 方法 | `callTool(name,args,session,signal,cancelId)` / `registerAgent` / `setAgentSink` / `answer` / `tools()`（bridge.ts）| ✅ 与方案一致 |
| launcher 读 aiUrl | `standalone.js` 读 `data-ai-url`/`data-bridge-url`/`window.__AITI_AI_URL` → `opts.aiUrl` | ✅ 注入方式正确 |
| `ctx.userQuestions` | `UserQuestionService.ask(request: AskUserQuestionRequest)`（user-questions/src/index.ts）| ✅ 交互映射更精确 |

### 13.2 修正点（初版审核 + 重构后审核，均已改）

| # | 原方案 | 修正 | 严重度 |
|---|---|---|---|
| 1 | 桥工具直接喂 `register` | 须构造 DSH `ToolDefinition`，**必带 `output:{schema,render}`**（缺则 `TypeError`）| **高** |
| 2 | `execute(params, signal)` | 实为 `execute(args, exec)`（`exec.signal` 是中止信号）| 高 |
| 3 | 工具数 15 | 实为 **16**（多 `aiti_file_stat`）| 低 |
| 4 | `session.agent.addHook('created'/'settled')` | DSH 用 `ctx.on('agent/status')`/`ctx.on('agent/inbox/claimed')` 等核心事件 + `ctx.get('agents')`；无 pi-web 式 hooks | 高 |
| 5 | `ctx.userQuestions`泛称 | 精确为 `ctx.userQuestions.ask({questions, agent, signal})` + `ctx.approval` | 中 |
| 6 | `AgentBridgeClient` 有 `tools()`（方案 `bridge.tools?.()`）| **无 tools()**；DSH 跨进程拿 `BridgeTool[]` 需调桥 **MCP `tools/list`**（桥 core `case "tools/list": {tools:TOOLS}`），或给 `AgentBridgeClient` 加 `tools()`（小改进）| **高** |
| 7 | `callTool(...opts={ session: currentSession() })` | `AgentCallOptions={agentId,sessionId,cwd?,cancelId?}`；应 `{ ...currentSession(), cancelId }` | **高** |
| 8 | `createUserMessage` 来源占位 | 实为 `packages/llm/llm/src/message.ts:192`；Agent 由 `ctx.get('agents').get(agentId)` 取 | 中 |
| 9 | execute 直接返回 wrapToolResult | DSH `execute` 返回 lossless 值（`wrapToolResult(...).content[0].text`），`output.render` 再变文本 | 中 |

**重构后新增依赖**：DSH adapter 依赖 `packages/aiti-devtools-agent`（仓库内包，**无 npm workspace 链接**）——外置 profile 插件需把该包作为依赖或文件引用；P0/P1 先用文件引用最快。

### 13.3 仍需落地时敲定（非阻断）

- **工具清单获取**：DSH 跨进程拿 `BridgeTool[]` —— 调桥 MCP `tools/list`（POST `/mcp`，jsonrpc initialize→tools/list），或给 `AgentBridgeClient` 加 `tools()`（小改进，推荐）；P1 落地时二选一。
- **P1 会话激活/完成信号**：`agent/status` 从哪个值到哪个值判定「接入/结束」，按 agent 状态机确认。
- **插件打包形态**：`dsh.bundle`（npm 包 `dsh.profile.bundles` 自动入层栈）vs `--patch`/profile cordis.patch.yml 文件引用（不改 DSH）。**由于 DSH adapter 依赖 `packages/aiti-devtools-agent`（仓库内 TS 包，非 npm 包，且仓库无 workspace 链接）**——文件引用（`cordis.patch.yml` `name: '{abs}/index.ts'`）需 node 能跑 TS（node24 type-stripping），且 agent 层代码须 erasable-TS；若不行则把 agent 接线拷贝/打包进插件。P0/P1 需实测。
- **P2（AI=DSH）** 是最大变量：DSH 页面挂 `aiti-client.mjs` 的方式（插件路由包装页 vs 直接注入 DSH SPA）需在 P2 单独设计/验证。

### 13.4 整体完成度

- **P0（链路）**：可行性高，风险低，可直接开干。
- **P1（工具）**：方案成立（全局工具可见性已证实），但工具注册契约/会话生命周期按 §13.2 修正后落地即可；预估 1 天内。
- **P2（AI=DSH）**：方案概念成立但工作量最大、不确定度最高（DSH SPA 挂适配层），建议 P0/P1 验证后再单独攻坚。
- **结论**：方案**技术可行、完成度良好**，关键风险（工具可见性/注册契约/会话钩子）本轮已消除或明确；**可进入 P0 启动**。

---

## 14. 变更记录：aiti-devtools monorepo 重构（2026-08-22）

> 依据 `docs/aiti-devtools-monorepo-restructure.md`。**`examples/dbg-widget/` 已整体删除**，正式代码归位 `packages/`，并**新增 `packages/aiti-devtools-agent`（多 agent 接线框架）**——本方案的复用方式随之大改。

### 14.1 路径变化（旧 → 新）

| 旧（已失效） | 新（本方案采用） |
|---|---|
| `examples/dbg-widget/bin/aiti-bridge.mjs` | `packages/aiti-bridge/bin/aiti-bridge.mjs` |
| `examples/dbg-widget/src/launcher/*.js` | `packages/aiti-devtools-inject/src/launcher/` |
| `examples/dbg-widget/src/client/*.js` | `packages/aiti-devtools-inject/src/client/` |
| `examples/dbg-widget/src/mcp/bridge-client.js` | `packages/aiti-devtools-inject/src/mcp/bridge-client.js` |
| `examples/dbg-widget/src/standalone.js` | `packages/aiti-devtools-inject/src/standalone.js` |
| `examples/dbg-widget/dist/`（launcher 产物） | `packages/aiti-devtools-core/assets/`（构建产物集中地） |
| — | **`packages/aiti-devtools-agent/`**（新增：接线层） |

### 14.2 方案的核心变化

1. **DSH adapter 大幅瘦身**：不再自写桥 HTTP 客户端/工具映射/会话一次接线；改为**复用 `packages/aiti-devtools-agent`** 的 `AgentBridgeClient` + `AgentHost` 契约 + `mapBridgeTools`/`wrapToolResult`。`dsh-web-ext/` 只剩：`agent-host.ts`（实现 AgentHost）+ `index.ts`（apply：连桥 + mapBridgeTools 注册 + 会话接线）。
2. **`HostToolDef.output` / `MapBridgeToolsOptions.output` 已为 DSH 预留**（`agent-host.ts`）——DSH 的 `output:{schema,render}` 契约由 agent 层模板字段覆盖，DSH 只需填 render。
3. **工具清单/桥 core/launcher aiUrl 均不变**（桥 16 工具、`data-ai-url` 读取逻辑、`ctx.tools.register` 全局可见性），只是**文件位置**变了。
4. **构建链**：`packages/aiti-devtools-inject/tools/build.mjs` → `packages/aiti-devtools-core/tools/build-assets.mjs` → `core/assets/`；launcher 从 `core/assets` 读，不依赖注入源码位置。

### 14.3 对已完成审核的影响

- §13.1 的「launcher 读 aiUrl」「桥 core 方法」结论**仍成立**（换路径即可）。
- §13.2 修正点仍有效（ToolDefinition output / execute(args,exec) / 会话事件）；且因 agent 层已预留 output 契约，**落地更顺**。
- §13.3 的「插件打包形态」结论：DSH adapter 依赖 `aiti-devtools-agent`（仓库内包，无 npm workspace 链接）——若做外置 profile 插件需把 agent 层加为依赖或用文件引用。**P0/P1 先用文件引用（`cordis.patch.yml` 指向 `dsh-web-ext/index.ts`）最快。**

---

## 15. DSH 插件机制（权威理解，纠正此前的混乱）

> **教训**：此前一直没搞清 DSH 前端插件机制，靠打补丁硬套 aiti-client.mjs，错了。现按源码/文档核实清楚。

### 15.1 两类插件 / 两个载体

| 概念 | 文档 | 职责 |
|---|---|---|
| **bundle** | `package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` | 贡献一个**配置层**（插/改 plugin 行）|
| **profile** | `$DSH_HOME/profiles/<name>` 的 `dsh.profile.bundles` | 描述**哪个 bundle 组合+顺序** |

**加载顺序**：profile.bundles 各 bundle patch（按序）→ profile/cordis.patch.yml → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖。后层按 `id` 覆盖整行 config（不深合并）。

### 15.2 host 插件（服务端 Cordis 插件）

- **结构**：`main`（lib/index.js 或 src）+ `name`/`inject`/`Config`/`apply(ctx,config)`。
- **安装**：`dsh plugin --profile <name> add <pkg>` → 若声明 `dsh.bundle`（patch 引用自己）→ 追加进 `dsh.profile.bundles`。
- **解析自**：**profile node_modules**（`dsh plugin add` 安装进 profile）。
- **✅ 外部 `@aiti-ai/*` 可以做 host bundle**（本方案的 host bundle `@aiti-ai/aiti-devtools-dsh` 就是这么装的，验证 16 工具）。

### 15.3 client 前端插件（浏览器）—— 关键坑（已彻底趟清）

- **结构**：`exports["./client"]`（浏览器 bundle）+ `dsh.client: {platform:'web', inject:[...]}` + host 面 `apply(){}`（让 Loader 加载）。
- **扫描**：`dsh-client-modules` 扫 `ctx.loader.entries()` 中声明 `dsh.client` 的包，解析其 `exports["./client"]`，组 `window.__DSH_BOOT__` → serve `/plugins/<id>/client.js`。
- **解析**：`createRequire(ctx.baseUrl)` —— `ctx.baseUrl` = **profile 目录**（`profile.ts` 明说「Loader 的 baseUrl 是 profile 目录」），所以**外部 `@aiti-ai` 包（在 profile node_modules）可被解析**！
- **✅ 外部 `@aiti-ai` 包能同时做 host bundle + client 插件**，必须满足：
  1. `dsh.client:{platform:'web'}` + `exports["./client"]`；
  2. **`exports` 含 `"./package.json"`**（client-modules `require.resolve('pkg/package.json')`；否则解析失败 → 包被跳过——反复踩的坑）；
  3. client bundle 用 **`window.__ModuleLoader__.load({id, factory:(require)=>{...CJS}})`** 格式（DSH lazy-CJS；不是 ESM——ESM 会 `Unexpected token export` + `loaded without registering via __ModuleLoader__.load`）；
  4. host 面（bundle patch 行加载）+ client 面（exports[\"./client\"] 被扫）同包共存。

### 15.4 结论（已验证的机制）

| 想做的 | 正确做法 |
|---|---|
| **DSH 进程内 aiti_* 工具 + 桥同端口** | 外部 bundle `@aiti-ai/aiti-devtools-dsh`（✅ 已做）|
| **DSH 前端输入交互 UI** | **同一个 `@aiti-ai/aiti-devtools-dsh` 包**声明 `dsh.client` + `exports["./client"]` + `./package.json` + `__ModuleLoader__.load` 格式 → client-modules 扫到，client apply 在 DSH React/懒加载里跑。✅ 已实现真实 UI（候选条 overlay + 协议层，见 §16）。 |

> **实证**：`@aiti-ai/aiti-devtools-dsh@0.4.0` 已同时是 host bundle（16 工具 + 桥同端口）+ client 插件（`__DSH_BOOT__` 含它 + `/plugins/@aiti-ai/aiti-devtools-dsh/client.js` 200 + console「前端 client 插件已加载」+ `conversation.input.overlay` 渲染候选条）。

---

## 16. 变更记录：DSH client 面真实 UI（2026-08-22）

> **此前**：client apply 只 `console.log` + 注册空 slot（`return null`），P2「AI=DSH」未落地。**本次**：移植 pi-web aiti-client 协议层到 DSH slot 模型，实现最小可用真实 UI。

### 16.1 实现内容（`src/client/index.ts`）

1. **AI 窗特征标记**：`/[?&]_dbg=/.test(location.search) || window.name==='aiti-ai-popup'` → `window.__AITI_AI_WIN__=true`（与 pi-web 同条件；防 launcher 嵌套自毁）。
2. **脚本资产加载**（从桥 `/aiti/`）：`host-protocol.js`（候选/去重/ack/localStorage）+ `bridge-client.js`（连桥）+ `cdp-core.js`（M1 self-exec 执行核心）。
3. **连桥 role=ai**：`onInteraction`/`onResult` 转发 `launcherHost()`（popup=opener / iframe=parent / self）；`onEvent` 把异步作答转候选 + 插占位符。
4. **作答回传监听**：`dbg_mcp_result`（非 `_aiBridge` 标记）→ `BridgeClient.postResult`；`dbg_mcp_interaction_control` → `postInteraction`。
5. **候选条 overlay**：`conversation.input.overlay` slot 注册 `CandidatesBar` React 组件，渲染 `[元素N]/[回答N]/[错误N]` 点击区，点击 `insertPlaceholderIntoTextarea`（原生 setter + input 事件，React 受控 textarea 兼容）。

### 16.2 与 pi-web aiti-client 的对应

| pi-web aiti-client.mjs | DSH client index.ts | 差异 |
|---|---|---|
| 顶部 `<script>` 注入 ESM | `__ModuleLoader__.load` lazy-CJS | 加载机制不同（DSH slot 插件契约）|
| toolbar 按钮 + dialog 面板 | `conversation.input.overlay` slot | DSH 是 SPA，用官方 slot 而非自绘 toolbar |
| `apiUrl('/api/extensions/aiti-devtools/host-protocol.js')` | `'/aiti/host-protocol.js'` | 资产路径：DSH 同端口 `/aiti/` |
| 自绘候选条（toolbar 下方，两区 chip）| slot 候选条（两区 chip：tag+描述+✕+清空）| 渲染载体不同，结构对齐 pi-web |
| `detailIdx` + DetailDialog（信息行/字段筛选/文件行）| 同构 DetailDialog（fixed 遮罩 portal）| 逻辑同，0.5.5+ 已实现 |
| `registerChatHook.preSend`（发送时替换+清候选）| host `agent/pre-step`（替换）+ `useSession` 监听 nodes（清理）| **替换在 host（正规插入点）；清理在前端 snapshot 数据流**，零发送 hook |
| host-protocol 候选/ack/去重 | 复用同一 host-protocol.js | **单源，零复制** |

### 16.3 未实现（下一步）

- ~~候选详情弹窗~~ **✅ 已完成（0.5.5+）**：点击候选描述区打开 DetailDialog（信息行 + 字段筛选 + 文件行）。
- **人机交互弹卡**（confirm/choose/input/presence/pick_element 可视化）：当前转发 launcherHost 由目标页 launcher 渲染（与 pi-web 同）；DSH 原生弹卡需接 DSH modal slot 或自建 portal。
- **桥连接状态指示**：pi-web 有 `useBridgeStatus` 状态条；DSH 版可挂 `conversation.composer.bar` 或省略。
- ~~废弃文件清理~~ **✅ 已完成（0.5.7+）**：`dist/dsh-aiti-register.js`（初版「打补丁硬套 aiti-client.mjs」产物）已删除。

---

## 17. 完成情况与待办（2024-08-23 记录）

### 17.1 已实现并端到端验证 ✅（最终定案：占位符方案 + agent/pre-step）

**目标**：DSH 前端输入交互 UI（候选条 / 点选元素 → composer / 发自 / 替换）全部经 DSH 框架正规实现，无 DOM 事件 hook、无发送钩子。

**核心结论（重要，替代早期 §15/§16/§17.0 的全部发送时替换方案）**：

> **DSH 的 `llm/stream` waterfall 里 `GenerateOptions.messages` 是 deep-frozen**（`freezeMessage`/`deepFreeze` 递归冻结，官方有意设计不可变）——插件无法在 llm/stream 层改写消息（报 `Cannot assign to read only property 'messages'`）。
>
> **真正正规的消息预处理插入点是 `agent/pre-step`**（agent-loop 的 waterfall 事件）：listener 签名 `({agent, messages, turn, step, signal}, next)`，`await next()` 拿默认 decision，**返回 `{...decision, messages: 替换后的消息}` 即可替换进入该步骤的消息**（plan-mode / repeat-tool-reminder 同款用法）。
>
> **关键机制**（agent.ts:282-284）：用户消息经 `agent.followup()` → inbox（**不 append session**）→ `preStep()` 里 `inbox.claim()` 取出 → `agent/pre-step` waterfall（可替换）→ **替换后的 `decision.messages` 才 append 进 session**。所以替换**同时**作用于：①发给 LLM 的请求（模型看到完整描述）；②session 历史（用户看到完整描述 + 发自）——**与 pi-web 原版行为完全一致**，且只 append 一次无重复。

**因此最终方案 =「占位符 + agent/pre-step 替换」**：

1. **client（AI 窗）**：点击候选/点选元素 → composer 插入**短占位符** `[元素N]`（干净，不塞大段描述）；候选变化时 POST `/aiti/picked` 上报 `{tag, describe, pageId}[]`（纯数据同步，非发送 hook）。
2. **host**：`/aiti/picked` 端点收候选存内存；`agent/pre-step` listener 把用户消息里的 `[元素N]` 替换成完整 describe + `[发自: pageId]`（只对含占位符的 user 消息构造新对象，frozen 安全）。

**已验证的完整链路**（Chrome DevTools 真实点击，2024-08-23）：

```
Inspector → 点「本地按钮」→ HUD ✓（拦截提示 + 元素信息卡）
→ AI 窗候选条（[元素1] chip） + composer 自动插入占位符：[元素1]
→ 补文本 → 点发送按钮（.rusa_q_primary[type="button"]）→ composer 清空
→ 服务端日志：pre-step 替换占位符: count=1 发自=si543/host 候选=1
→ 会话历史 user/message = 完整描述 + [发自: si543/host]（无占位符残留，无重复 append）
```

**技术要点（0.8.0）**：
- client `insertPlaceholderIntoTextarea(el)`：插入占位符 `[元素N]`（原生 value setter + input 事件，React 受控 textarea 兼容）；`reportPickedToHost()` 防抖 150ms POST 上报候选（describe 用 host-protocol.describe 生成）。
- host `agent/pre-step`：`await next()` → 检查 `decision.messages` 里 user 文本是否含 `[元素N]` → 逐个替换（`split/join`）→ **最后一条被替换消息**末尾追加**完整发自标注**（对齐 pi-web withSource）：`[发自: pid · clipUrl(url)（aiti-*：pageId 参数用它）]`——pid 取第一个候选来源页；url 从 `bridge.sessions()` 查（host 注册带 url）；clipUrl 复刻 host-protocol（去 hash、前 2 query、120 截断）；幂等（先摘已有 `[发自:]` 再追加）。frozen 安全（全部构造新对象）。
- **候选条（0.5.5+）**：`conversation.input.overlay` slot（`{kind:'list', scope:'session'}`）渲染两区 chip：占位符区（`.aiti-picked-tag`，点击仅补占位符）+ 描述区（点击补占位符 + 开详情弹窗）+ ✕ 逐条清除 + 清空按钮。
- **详情弹窗（0.5.5+）**：点击描述区 → fixed 遮罩弹窗（DetailDialog），显示 `hp.detailRows` 信息行（标签/xpath/尺寸/…）+ 字段筛选勾选（include，调 `hp.setPicked` 持久化）+ 文件行（rowFileInfo 提取 file:line）。
- **发送后自动清理（0.5.6+）**：CandidatesBar 用 slot 标准 props `useSession` 监听 `session.nodes`——新增 durable user 消息且含「发自:」（= agent/pre-step 已消费占位符）→ `clearAllCandidates()`（清候选条 + 摘输入框占位符 + localStorage/宿主指纹）。走 DSH 正规前端数据流（snapshot selector），非 DOM 发送 hook，与 pi-web 原版 preSend 清理同语义。
- **两个关键 bug 根因（0.5.6/0.5.7 修复）**：
  1. `useSession` 是 `SnapshotSelectorHook<T> = <S>(sel, eq?) => S`——**必须传 selector**（`useSession((s)=>s)`）；之前无参调用 `useSession()` → 内部 `sel is not a function` → slot 崩溃（`data-slot-error` 遮罩，候选条不渲染）。
  2. 发送清理的 `nodesRef` 初值 0 → 挂载时历史 user 消息（含「发自:」）就触发误清理清空候选；改为首次 effect 只记基线（不清理历史）。
  3. **DSH `overlayAnchor` 是 `position:absolute; height:0` 的空锚点**（InputBar.module.css:113-117，注释明言 slot 条目要自行定位 bottom:100%+gap 弹到输入卡上方）——流式布局的候选条从锚点向下溢出，与 textarea 重叠且被其热区覆盖：`elementFromPoint` 返回 TEXTAREA，真实点击永远点到输入框（不触发 onClick）。修复：候选条 `position:absolute; bottom:100%; left/right:0`（0.5.9）。
  4. 硬编码浅色（#eef2ff chips/白底弹窗）在暗色主题突兀 → 全部换 DSH `--dsw-alias-*` 设计变量（interactive-bg-hover-accent/border-l2/label-secondary/bg-layer-3/bg-mask-3/shadow-lv2 等，亮/暗自动适配）；详情弹窗 `createPortal` 到 document.body（防输入卡容器裁剪）。
- 之前试过的路已**废弃并回滚**：
  1. ~~前端 `transformText`/`hookComposerSend` hook~~（用户否：不要 DOM 事件 hook）
  2. ~~host 端 `llm/stream` 改 messages~~（deep-frozen 改不了，报 TypeError）
  3. ~~插入时展开~~（0.5.1 版本：点选即插完整描述——composer 被塞大段文本，且不显示占位符；被占位符方案取代）
- host bundle（`src/index.ts`）结构：进程内桥挂 `/aiti` + 16 个 aiti_* 工具 + 资产 serve + `/aiti/picked` 端点 + `agent/pre-step` listener（干净）。

### 17.2 当前版本与部署

| 组件 | 版本 | 说明 |
|---|---|---|
| `@aiti-ai/aiti-devtools-dsh` | **0.8.0** | host bundle + client plugin——占位符方案 + agent/pre-step；候选条两区 + 详情弹窗 + 发送后自动清理 |
| DSH | 0.1.1-rc.2 | `dsh.service` @127.0.0.1:3080，nginx `dsh.pi.example.com` |

```bash
node tools/build.mjs && npm publish --access public
node /home/pi/workspace/deepseek-harness/apps/cli/lib/bin.js plugin --profile web add @aiti-ai/aiti-devtools-dsh@^0.8.0
sudo systemctl restart dsh.service
```

**版本演进**：

| 版本 | 内容 |
|---|---|
| 0.5.0 | host `llm/stream` 预处理（后来证明 deep-frozen 改不了，回滚）|
| 0.5.1 | 插入时展开（点选即插完整描述；被占位符方案取代）|
| 0.5.2-0.5.3 | agent/pre-step 占位符替换（正式方案）+ `/aiti/picked` 上报端点 |
| 0.5.4 | 定案：占位符 + agent/pre-step（历史/模型同文案，无重复）|
| 0.5.5 | 候选条两区结构（tag+描述+✕+清空）+ 详情弹窗 DetailDialog |
| 0.5.6 | 发送后自动清理（useSession 监听 nodes；修复 nodesRef 基线 bug）|
| 0.5.7 | 修复 useSession 必须传 selector（`l is not a function` slot 崩溃）；删废弃文件 |
| 0.5.8 | onMouseDown→onClick + 样式全部换 DSH `--dsw-alias-*` 变量（亮/暗主题适配）+ 弹窗 createPortal 到 body |
| 0.5.9 | **关键布局修复**：overlayAnchor 是 height:0 空锚点，候选条必须 `position:absolute; bottom:100%` 上浮——流式布局会被 textarea 热区覆盖（点击落不到候选条）|
| 0.5.10 | **发自标注对齐 pi-web 完整格式**：`[发自: pid · clipUrl(url)（aiti-*：pageId 参数用它）]`（含来源页 URL + 工具提示 + 幂等清理）；URL 从桥 sessions() 查；顺手修 block 级 changed 变量污染 |
| 0.5.11 | **错误候选链路修复 + demo 错误按钮**：① 错误候选无 pageId → host pre-step 不替换（pageIds 空直接跳过）→ 改为替换不依赖 pageIds、发自仅在有 pid 时追加；② client 上报给无 pageId 候选兜底 `hp.hostIdentity().pageId`（宿主页身份）；③ demo 页加 💥throw/💥Promise 两按钮（真实触发页面错误供测试）|
| 0.6.0 | **发送清理改桥消息流（用户方向）+ 审核缺口大补**：① core 0.2.0 加 `bridge.pushAiEvent(event,payload)`（aiConns SSE 直推，公开方法）；② host pre-step 替换成功 → `pushAiEvent('aiti_consumed',{tags})`（权威信号+携带被消费占位符）；③ client `onEvent` 收到即 `clearAllCandidates`（**删掉 useSession snapshot 方案**——selector 坑/基线初始化/竞态全不需要）；④ 补 `onBridgeEvent`（页面事件→桥转发；此前空回调导致 page_logs/page_network 环形缓冲**恒空**）；⑤ 补 `onUserMessage`（HUD 👆 element_instruction→输入框）；⑥ replaceTag 换行分隔（desc 末行与用户原文粘连）；⑦ 孤儿占位符兜底 stripOrphanTags + 旧版 [选择N] 摘除；⑧ 纯文本消息也带发自；⑨ 详情弹窗文件行加「📂 后台打开」 |
| 0.6.1 | 修 BridgeClient `onEvent(m.event || m)` **剥层形状**：onEvent 收到的是**字符串**（如 'aiti_consumed''，payload 已丢）——判断改 `typeof m === 'string' ? m : ...` |
| 0.6.2 | **上报竞态修复**：AI 窗候选上报 150ms 防抖+POST 在途 vs pre-step 同步查 lastPicked——点选后飞快发送会裸发占位符。pre-step 是 async waterfall 可 await：检测占位符但 lastPicked 空 → 轮询等待 ≤800ms（正常 <200ms）|
| 0.6.3 | **修构建坑**：build.mjs 把 @aiti-ai/* **bundle 内嵌**——deps bump core ^0.2.0 后忘重 install+build，lib 里还是旧 core（`pushAiEvent?.()` optional chaining 静默跳过=事件没推）。**教训：core/agent 改动后必须先 `npm install` 再 `node tools/build.mjs`，且 grep 验证 bundle 内含新实现（pushAiEvent 应 3 处）** |
| 0.6.4 | **孤儿兜底无条件化**（深审 Bug #11）：stripOrphanTags 原包在 `if (lastPicked.length)` 内——无候选上报时整块跳过，`[元素5]` 原样裸发。改为无条件兜底（替换后残留 + 全孤儿都处理）。实测：`孤儿 [元素5] [回答9] 兜底复验` → 两条「⚠ 候选已失效，占位符已移除」，无残留 ✅ |
| 0.6.5 + core 0.2.1 | **localStorage 候选恢复（深审 Bug #12）**：host-protocol 的 `load()` 是死代码——定义了从未调用，AI 窗刷新即丢全部候选（注释声称的恢复从未发生，pi-web 同样受影响）。core 0.2.1 在 create 时 `setPicked(load())`（触发 onPicked → 适配端 syncPicked → **自动重上报 host**，lastPicked 同步恢复）。实测：点选 → 刷新 → 候选条重现（picked=1/ls=1）→ 发送 `[元素1] 刷新后替换验证` → 正确替换 ✅ |
| 0.6.6 | **规范符合度修复**：Config schemastery schema（删死字段 bridgeUrl，fail loud）+ web 路由 disposer（ctx.effect）+ ctx.logger + agents 可选依赖注释 |
| 0.7.0-0.7.1 + core 0.2.2 | **7 项差距全修**：类型收窄 / i18n（zh/en 字典+locale face）/ HMR 监听 ctx.effect 化 / bridge.close / 空 catch 命名 / createUserMessage / 受控 checkbox；0.7.0 曾引入 React #310（hooks 在早退后）0.7.1 修复 |
| 0.8.0 + core 0.3.x | **反馈落地（A/B 类）**：B1 rewriteMessage 下沉 core（send-rewrite.ts，28 测试）→ host pre-step 薄壳化；B3/B4/B5 host-protocol 修复（错误 pageId/双空格/per-instance key，11 测试）；A 类 pi-web deploy 吃到（页面实测恢复+隔离）；core 117 项测试全绿 + `npm run test`；发现 src/assets 双副本陷阱（改产物不改真源 → pi-web deploy 拿不到）已修 |

### 17.1.0 第三轮审查：DSH 规范符合度（2026-08-23，0.6.6）

对照 DSH 官方规范（AGENTS.md 质量条款 + cordis-primer 生命周期 + 官方插件 repeat-tool-reminder/ui-input-trigger 实例）逐条核查：

**本轮修复（0.6.6）：**
| 违规 | 官方规范 | 修复 |
|---|---|---|
| Config 无 schema、`bridgeUrl` 死字段被静默忽略 | "Config, validated by the same-named schemastery schema" + "Misconfiguration fails loud" | 加 `export const Config: z<Config>`（schemastery，peerDep `@deepseek-ai/schemastery`）；删 bridgeUrl；cordis.patch.yml 同步清理 |
| webServer.register 的两个 disposer 未接收 | "Registrations are reversible effects... every registration should have a disposer" | disposer 收集 + `ctx.effect(() => () => {...}, 'aiti-devtools-dsh: web routes')` 归一卸载 |
| console.log 中文日志 | 官方插件用 ctx.logger（分级） | 全部换 ctx.logger.info/warn（英文；logger.info 可能被运行时级别过滤——不阻断） |
| `ctx.get('agents')` 未声明依赖无解释 | inject 声明即硬依赖；不声明需有理由 | 注释说明可选服务依赖的理由（CLI/raw profile 无 agent 服务时仍可挂桥） |

**核查通过项（无违规）：**
- waterfall listener `await next()` 后返回新 decision——满足 "Waterfall listeners MUST call next()" ✓
- slot 注册 `order` 字段合法（与 `priority` 正交：priority=遮蔽占用、order=list 渲染排序，ui-slots:867；官方 ui-input-trigger 同传 order）✓
- client 模块顶层副作用有 `typeof window/document !== 'undefined'` 守卫（SSR 安全）✓
- React hooks 规则（所有 hooks 在条件 return 前调用）✓
- 包规范：`dsh.client{platform:'web'}` + `exports["./client"]` + `exports["./package.json"]` ✓
- `agent/pre-step` 是官方文档化扩展点（"Plugins, not loop changes"——未改 loop）✓

**记录在案的差距 → 已于 0.7.0/0.7.1 全部修复（core 0.2.2 协同）：**
| # | 差距 | 修复 |
|---|---|---|
| 1 | any 泛滥 | host：PreStepPayload/PreStepDecision/PickedReport 本地类型 + dsh-llm type import + 消灭 map 回调 any；client：HostProtocol/Candidate 最小接口（JS 全局资产的使用面声明）+ 编辑函数群签名收窄 |
| 2 | i18n 缺失 | AI18N zh/en 字典 + `ctx.locale.register` + slot 注册 `locale: NS` + 组件 props.t（tt() 渐进增强，无 locale face 回退中文）。**实测英文界面显示 "Clear all"/"[元素1] details"/"Fields sent to the AI"** |
| 3 | HMR/重载清理 | 作答回传 message listener 从模块顶层移入 apply，经 `ctx.effect` 注册（卸载自动摘除；effect 不可用兜底直挂） |
| 4 | bridge 无 close | core 0.2.2：`close()` 清 sweep 定时器；host dispose 接线（ctx.effect 收尾调 `bridge.close?.()`） |
| 5 | 空 catch 未命名 | host/client 关键处补「吞掉 X：Y 兜底」注释（推送失败/JSON 解析/postMessage 宿主关闭/setter 卸载等） |
| 6 | injectToModel 裸消息 | 改 `createUserMessage({content, source:{kind:'user'}})`（完整 UserMessage 契约：frozen + id/source） |
| 7 | 受控 checkbox | incState 本地 state 镜像（checked 由 React 持有；d 变化 useEffect 重置；toggle 先 setState 再同步 hp）。**实测：取消勾选「尺寸」→ 发送 describe 无尺寸行** |

**修复过程引入又修掉的回归（如实记录）**：受控 checkbox 初版把 useState/useEffect 放在 `if (d < 0) return null` 早退后 → React #310（hooks 数量随路径变化）→ slot 崩溃。0.7.1 全部 hooks 前置 + 惰性 readInc 修复。**这正是差距 #7 半吊子实现的风险实证**。

**剩余已知小项（不影响功能）**：locale `close` 键的 t() 返回异常走中文 fallback（同字典其他键正常——疑 DSH t() 对 ✕ 符号值的处理，未深究）；aria-label/title 仍硬编码中文。

### 17.1.1 第二轮深审结论（2026-08-23，0.6.5）

**全量对照 pi-web 功能面 + 极限路径实测**，新增修复 2 个（上表 0.6.4/0.6.5），验证通过项：

| 路径 | 结果 |
|---|---|
| include 字段筛选 → describe（勾掉「尺寸」后发送，describe 无尺寸行）| ✅ 实测（toggle → setPicked → 自动重上报链） |
| 刷新恢复 → 重上报 → 发送替换（全链）| ✅ 实测 |
| 孤儿占位符兜底（无候选时）| ✅ 实测 |
| 桥事件流清理（aiti_consumed）| ✅ 实测（上轮） |
| 极限竞态（注入+同 tick 发送）| ✅ 实测（上轮） |

**已知差距（诚实清单，按优先级）**：
1. **[回答N] 异步作答候选**（agent 交互→人作答→user_answer 候选）：代码在（client onEvent），**从未端到端实测**（需 agent 真实发起 aiti_user_confirm 且人在弹卡作答）——待办。
2. **详情弹窗行复制按钮 + onCopy 转发**：pi-web 每行 hover 复制（iframe clipboard 受限时 dbg_copy 转发宿主）；DSH 版未做——小功能，待办。
3. **InspectButton（AI 窗内点选按钮）**：pi-web toolbar 有；DSH 无（launcher Inspector 工具条可达，非阻断）。
4. **AITI 面板**（桥状态/页面列表/手动 CDP）：DSH 无（cockpit.html 承担查看，对话承担 CDP）——设计取舍。
5. **pushAiEvent 无 session 维度**：多 AI 窗同开时 aiti_consumed 全清——已知限制（单窗场景无影响）。
6. **pi-web 侧 host-protocol 恢复修复**：core 0.2.1 改动对 pi-web 同步生效（deploy 后需重新 deploy pi-web 资产才吃到）——待 pi-web 下次 deploy。
7. **测试方法学**：合成 click 偶发不触发 DSH 提交（React draft flush 时序，两段式 set→sleep→click 稳定）；真实用户操作无此问题。 |

### 17.3 待办（下一步）

1. ~~候选详情弹窗~~ **✅ 已完成（0.5.5+）**：点击候选描述区打开 DetailDialog（信息行 + 字段筛选 + 文件行）。
2. **人机交互弹卡**（confirm/choose/input/presence/pick_element 可视化）：当前转发 launcherHost 由目标页 launcher 渲染（与 pi-web 同）；DSH 原生弹卡待接 DSH modal slot。
3. **桥连接状态指示**：可挂 `conversation.composer.bar` 或省略。
4. **候选条样式打磨**：已用 indigo 系配色对齐 pi-web；DSH CSS 变量（`--dsw-static-*`/`--ds-*`）可进一步接入主题。
5. ~~废弃文件清理~~ **✅ 已完成（0.5.7+）**：`dist/dsh-aiti-register.js` 已删。
6. **多选元素/多候选**：一次点选多元素时 chips 行为（当前每确认一个插一个占位符 `[元素N]`；可考虑候选条去重 + 合并替换——agent/pre-step 已支持多条候选同时替换）。
7. ~~demos/README 补充验证步骤~~ **✅ 已完成**：占位符方案验证清单（composer 显示 `[元素N]`，发送后历史显示完整描述 + 候选条自动清理）。
8. ~~「发送时替换需要 DSH 可变消息插入点」~~ **✅ 已解决**：`agent/pre-step` 就是正规可变消息插入点（agent-loop waterfall，plan-mode 同款），且替换后的消息就是写入 session 历史的（agent.ts:282-284）。
9. **已验证的完整用户路径**（Chrome DevTools 真实点击，2024-08-23）：点选元素 → 候选条两区 chip → 点描述区开详情 → ✕ 清除单条 → 发送按钮 → 候选条自动清理 → 历史 = 完整描述 + 发自。
