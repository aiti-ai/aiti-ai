# aiti-devtools (vscode)

[English](./README.md)

> [aiti-devtools](https://aiti.pw/devtools/integrations/) 的 VS Code 载体：一键完成页面注入 + aiti 桥 + IDE 内置 AI agent 的 MCP 配置——让 Copilot Chat 直接看到并操作你正在开发的页面（`page_exec` / `page_snapshot` / `user_*`）。

## 功能

- **零改码注入页面** — 本地反向代理把 aiti launcher 脚本前置进 dev server 的 HTML 响应，任何 HTTP 页面都适用。
- **桥生命周期** — 自动拉起（或复用已在跑的）aiti 桥，连接注入页面与 AI agent。
- **MCP 配置** — 写入 `.vscode/mcp.json` 的 `aiti` 条目，IDE 里的 MCP agent 即刻接入。
- **dev server 发现** — 枚举 IDE 自身子进程（集成终端 / 任务 / 调试）里启动的 HTTP 服务并转为注入通道；IDE 之外的进程永不枚举。
- **AI 窗** — 页面右下角 💬 打开你的 AI 窗：默认本地桥 cockpit，也可经 `aiti.aiUrl` 指向任意 aiti 兼容页面（如自建的 [pi-web](https://aiti.pw/) 实例）。

## 快速开始

1. 启动 dev server（Vite / Next / webpack / …）——建议在 IDE 集成终端里启动，以便自动发现。
2. 命令面板 → **`aiti: 启用页面调试`**。自动起桥 + 代理、发现 dev server 并打开代理地址。
   - 多个候选 → QuickPick 选择；一个没有 → 手动输入地址（`localhost:5173`、`:5173`、纯端口号都可以）。
3. 浏览器打开代理地址（默认 `http://127.0.0.1:8788/`）——右下角出现 💬 / 🎯 即注入成功。
4. 在 Copilot Chat 里让 AI 操作页面：`bridge_status` 看已连页面，`page_exec` 在页面里执行 JS。

## 命令

| 命令 | 作用 |
|---|---|
| `aiti: 启用页面调试` | 确保桥在跑 → 启动注入代理 → 写 `.vscode/mcp.json` → 打开代理地址 |
| `aiti: 停止调试` | 停代理 + 本扩展拉起的桥（外部桥不代杀） |
| `aiti: 打开桥面板` | 状态、注入通道、可注入服务、框架接入、AI 窗地址、桥日志 |
| `aiti: 重新注入` | 重启代理（页面已自带注入时用它换用代理注入） |

## 设置（`aiti.*`）

| 设置 | 默认 | 说明 |
|---|---|---|
| `bridgePort` | `8777` | 桥端口（与独立桥默认一致） |
| `bridgePath` | 空 | `aiti-bridge.mjs` 路径（空 = 自动探测） |
| `shimPath` | 空 | `aiti-mcp-shim.cjs` 路径（空 = 自动探测） |
| `proxyPort` | `8788` | 注入代理起始端口；每个目标独立端口（8788、8789、…） |
| `targetUrl` | 空 | 固定注入目标（留空 = 自动发现） |
| `aiUrl` | 空 | 💬 徽标打开的 AI 窗地址。留空 = 本地桥 cockpit；可指向 pi-web 实例（如 `https://pi.example.com/`）。可在桥面板直接修改，改动后代理自动重建 |
| `autoOpenBrowser` | `true` | 启用后自动打开代理地址 |
| `autoEnable` | `false` | 扩展激活时自动执行「启用页面调试」（工作区级；测试钩子） |

## 桥面板

- **状态头** — 桥状态 + 数量概览 + 主操作，附当前 AI 窗地址与就地修改按钮。
- **注入通道** — 每个目标 ↔ 代理对一张卡片。
- **可注入服务** — IDE 子进程里发现的 HTTP 服务；非页面服务自动折叠。
- **折叠区** — 框架接入（Vite / webpack / Rspack / Nuxt / Astro / Next / Express 一键载体插件）、手动登记端口、已连接页面、桥日志。

## 两种注入形态

1. **代理注入**（本扩展）— 零改码，任何本地 dev server 都能用；页面 origin 与 dev server 不同（代理端口）。
2. **框架载体插件** — 给 dev server 加 aiti 的 vite/webpack/Nuxt 插件，全套同源运行（`/aiti/`），更稳。桥面板自动检测框架并支持一键补丁 config（原文件备份为 `.aiti-bak`）。见[载体接入文档](https://aiti.pw/devtools/integrations/)。

## AI 窗与 agent 后端

💬 徽标可打开任意 aiti 兼容页面作为 AI 窗（`aiti.aiUrl`）。指向自建的 **[pi-web](https://aiti.pw/)** 实例（npm `@aiti-ai/pi-web`）即可获得完整 AI 窗：会话管理、模型选择、多 agent 会话。pi-web 已集成大量外部 agent CLI：

- **ACP 后端** — Claude Code、Codex、DeepSeek（`dsh`）、Gemini、Kimi、Qoder、Grok、antigravity、omp（Oh My Pi）、OpenClaw 等，经 `aiti-acp-agent`（Agent Client Protocol 适配）接入。
- **深度集成** — OpenCode（L2 载体扩展，会话与桥接）与 OpenClaw。
- **pi / zcode** — 一等公民家族后端。

它们都出现在同一个 All Sessions 面板里，可从 AI 窗接管任意注入页面。

## 链接

- 载体接入文档：<https://aiti.pw/devtools/integrations/>
- 快速开始：<https://aiti.pw/devtools/quick-start.html>
- 用 npm [`@aiti-ai/pi-web`](https://aiti.pw/) 自建 AI 窗
- English: [README.md](./README.md)
