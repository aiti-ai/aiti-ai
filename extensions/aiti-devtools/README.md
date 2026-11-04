# aiti-devtools · 页面内 AI 调试助手（pi-web 扩展）

aiti 生态的核心扩展：把任意网页变成 AI 可协作的调试现场——页面注入 launcher UI
（FAB / HUD / 工具条 / 弹窗 / AI 窗）、client（元素选区、事件冻结/放行矩阵、类 CDP
命令集），并通过**桥（bridge）**把页面能力以 MCP 工具的形式交给任意 AI agent。

## 三端结构

```
页面注入层（launcher + client）  ⇄  桥（MCP server 核心 + 消息/会话）  ⇄  agent 端
```

| 端 | 组成 | 说明 |
|---|---|---|
| 页面注入层 | launcher + client | FAB/HUD/工具条/AI 窗等 UI；选区、事件冻结矩阵、CDP 命令集、刷新恢复 |
| 桥 | 本扩展 `bridge.ts` + `packages/aiti-devtools-core` | MCP 端点（stateless `POST /mcp`）、pageId 会话体系、SSE 事件广播 |
| agent 端 | pi 扩展直连 / 任何标准 MCP client | pi-web 场景经 `server.agent` 扩展点进程内注入（零配置）；外部 agent 走 stdio shim |

## 能力速览

- **Inspector**：用户点选页面元素 → 结构化载荷（tag/rect/xpath/text/attributes/framework/selector）直达 AI
- **类 CDP 命令**：DOM/CSS/Input/Page/Runtime/Storage/Performance/Browser 域，iframe 上下文 eval
- **user_\* 交互工具族**：confirm / choose / input / pick-element / presence / notify —— AI 可向用户提问、让用户点选、探测在场
- **AI 窗 / 操作台**：`cockpit.html`（独立桥）或 pi-web 根页面（扩展部署）
- **框架识别**：React/Vue/Next/Nuxt/SvelteKit/Astro 自动识别
- **自检**：client 启动自检矩阵（`__dbg`）

## 生态包（本仓 `packages/`）

| 包 | 角色 |
|---|---|
| `aiti-devtools-core` | 桥核心（bridge/http + host-protocol/aiwin 浏览器模块），载体无关 |
| `aiti-devtools-inject` | 注入产物构建（launcher bundle → `aiti-launcher.js`） |
| `aiti-devtools-agent` | 多 agent 宿主接线框架（AgentBridgeClient + AgentHost 契约） |
| `aiti-devtools-vite` / `-webpack` / `-nuxt` | 框架载体插件（应用 dev server 内置 MCP，同源 `/aiti/`） |

## 安装与构建

```bash
# 扩展目录内安装依赖并构建 client（本仓 clone 后首次）
npm install && npm run build:client

# pi-web extman 安装（本地路径 / git 来源均可）
#   extman › install › pi-web 扩展目录路径
# 或直接放到 PI_WEB_EXTENSIONS_DIR 指向的目录后 reload：
#   POST /api/extensions/reload
```

> 构建注入产物（launcher）需要本仓 `packages/aiti-devtools-inject`；
> 桥核心运行时依赖 `packages/aiti-devtools-core`（jiti walk-up 解析，无需发布）。

## 依赖

- 运行时共享层：`@aiti-ai/ext-shared`（本仓 `extensions/_shared/`，经 extman reconcile
  或 webRoot node_modules 解析）
- 无轮询、无遥测；扩展数据遵守 config/cache 分层（见各 AGENTS.md）
