# @aiti-ai/aiti-devtools-dsh

> aiti-devtools 的 **DSH（DeepSeek Harness）宿主 adapter**（npm `@aiti-ai/` scope，发布到 npm.example.com）。
> 一个包同时提供 **host bundle**（服务端 Cordis 插件）+ **client plugin**（浏览器前端）：
> - host：进程内桥挂 DSH 同端口 `/aiti`（launcher/cockpit/bridge/mcp）+ 16 个 `aiti_*` 工具 + 占位符替换。
> - client：DSH SPA 充当 AI 窗——候选条 / 点选元素→composer / 详情弹窗 / 发送后清理。
>
> **方案**：`../PLAN.md`（§15 DSH 插件机制、§16 与 pi-web 对应、§17 完成情况）。

## 位置

```
dsh-web-ext/
├── aiti-devtools-dsh/            # 本包
│   ├── src/index.ts              # host bundle：DSH Cordis 插件入口 apply（桥 + 工具 + pre-step）
│   ├── src/client/index.ts       # client plugin：浏览器面（候选条/详情/清理）
│   ├── tools/build.mjs           # esbuild → lib/index.js（host）+ lib/client.js（client，__ModuleLoader__ 格式）
│   └── lib/                      # 构建产物（发布到 npm，DSH 从安装位置读取）
└── PLAN.md                       # 移植方案
```

## 是什么

**host bundle**（`src/index.ts` 的 `apply`）：
- `createBridge` 进程内建桥（route B，不另开端口），经 `ctx.webServer.register` 挂 `/aiti` 前缀
  （`/aiti/aiti-launcher.js` / `cockpit.html` / `bridge-client.js` / `host-protocol.js` / `cdp-core.js` 资产 +
  `/aiti/bridge/*` 桥 REST/SSE + `/aiti/mcp` MCP JSON-RPC + `/aiti/picked` 候选上报端点）。
- `bridge.tools()` → `mapBridgeTools` → `ctx.tools.register` 注册 16 个 `aiti_*` 工具
  （execute 经 `bridge.callTool` 进程内直连，返回 MCP 格式 `{content:[{text}]}` 取 `content[0].text`）。
- **`agent/pre-step` listener**（agent-loop 官方 waterfall，plan-mode 同款）：把用户消息里的
  `[元素N]/[回答N]/[错误N]` 占位符替换成完整 describe + `[发自: pageId]`（候选数据来自 client 上报）。

**client plugin**（`src/client/index.ts`，`dsh.client` 声明 + `exports["./client"]`）：
- 加载桥资产（host-protocol.js / bridge-client.js / cdp-core.js，从 `/aiti/`），连桥 role=ai。
- `conversation.input.overlay` slot 渲染候选条：两区 chip（占位符区 `.aiti-picked-tag` + 描述区）+ ✕ + 清空。
- 点选元素 → composer 插短占位符 `[元素N]`（`insertPlaceholderIntoTextarea`，React 受控 textarea 兼容）；
  候选变化 → POST `/aiti/picked` 上报（纯数据同步，非发送 hook）。
- 点描述区 → 详情弹窗 DetailDialog（信息行 + 字段筛选 + 文件行）。
- 发送后自动清理：`useSession`（slot 标准 props，**必须传 selector** `useSession((s)=>s)`）监听
  `session.nodes` 新增 user 消息含「发自:」→ 清候选条 + 摘输入框占位符。

## 加载（DSH web profile）

```bash
node /home/pi/workspace/deepseek-harness/apps/cli/lib/bin.js plugin --profile web add @aiti-ai/aiti-devtools-dsh@^0.6.6
sudo systemctl restart dsh.service
```

## 构建 / 发布

```bash
cd dsh-web-ext/aiti-devtools-dsh
node tools/build.mjs        # → lib/index.js（host）+ lib/client.js（client，__ModuleLoader__.load CJS）
npm publish --access public # @aiti-ai/aiti-devtools-dsh（registry = npm.example.com）
```

## 状态

- **已落地并端到端验证**（0.6.6，2026-08-23）：占位符方案 + agent/pre-step 替换 + 候选条两区 +
  详情弹窗 + 发送后自动清理。见 `../PLAN.md` §17.1。
- **版本**：0.6.6。

## 相关包

| 包 | 角色 |
|---|---|
| `@aiti-ai/aiti-devtools-agent` | 接线层：AgentBridgeClient + AgentHost + mapBridgeTools（复用）|
| `@aiti-ai/aiti-devtools-core` | 桥核心 `createBridge` + 浏览器协议（host-protocol）+ `assets/` 产物 |
| `packages/aiti-devtools-inject` | launcher 页面内 UI + client（复用不改）|
