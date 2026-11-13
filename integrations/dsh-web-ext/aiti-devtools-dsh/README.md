# @aiti-ai/aiti-devtools-dsh

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

**English**: DSH (DeepSeek Harness) host adapter for aiti-devtools: one package with the host bundle (in-process bridge on the DSH port + 16 aiti_* tools + placeholder rewriting) and the client plugin (the DSH web UI as the AI window with candidate bar / element picking).

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>


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
node /home/pi/workspace/deepseek-harness/apps/cli/lib/bin.js plugin --profile web add @aiti-ai/aiti-devtools-dsh@^0.8.2
sudo systemctl restart dsh.service
```

## 构建 / 发布

```bash
cd dsh-web-ext/aiti-devtools-dsh
node tools/build.mjs        # → lib/index.js（host）+ lib/client.js（client，__ModuleLoader__.load CJS）
npm publish --access public # @aiti-ai/aiti-devtools-dsh（registry = npm.example.com）
```

## 状态

- **已落地并端到端验证**（0.8.2，2026-11-07 复检全过）：占位符方案 + agent/pre-step 替换 + 候选条两区 +
  详情弹窗 + 发送后自动清理 + 交互卡 + 错误候选自动捕获 + 模型真实调用
  aiti_hello/aiti_inbox/bridge_status/page_snapshot/page_exec（改写出的 pageId 直接被模型用）。
  见 `../PLAN.md` §17.1。首次落地验证 0.6.6（2026-08-23）。
- **版本**：0.8.2（内嵌 core 0.3.10；profile 根级 core 同步 ^0.3.10——升级后 launcher/cockpit 资产与仓库 HEAD 对齐）。
- **升级注意**：npm 安装用 `--legacy-peer-deps`（npm 11 arborist 对 peerDependencies `*` 会崩 `Cannot read
  properties of null`）；profile 根级 core 是独立依赖行，升级 dsh 包后须显式
  `plugin --profile web add @aiti-ai/aiti-devtools-core@^0.3.10`，否则 runtime 解析到的还是旧版。

## 相关包

| 包 | 角色 |
|---|---|
| `@aiti-ai/aiti-devtools-agent` | 接线层：AgentBridgeClient + AgentHost + mapBridgeTools（复用）|
| `@aiti-ai/aiti-devtools-core` | 桥核心 `createBridge` + 浏览器协议（host-protocol）+ `assets/` 产物 |
| `packages/aiti-devtools-inject` | launcher 页面内 UI + client（复用不改）|

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-devtools-dsh.html>
- English docs: <https://aiti.pw/en/extensions/aiti-devtools-dsh.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>
