# AITI Web

[English](../README.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

**AITI Web**（`@aiti-ai/pi-web`）是 [pi 编程智能体](https://github.com/earendil-works/pi)的浏览器工作台，也是 [aiti](https://aiti.pw/) 工具生态的基座：页面注入式 AI 调试工具、面向 AI agent 的 MCP 桥，以及持续增长的内置扩展库。

### 为什么要 fork？

上游 [pi-web](https://github.com/agegr/pi-web) 是很优秀的 pi 本地界面——但做一个完整的 AI 开发工作台，光有界面不够：还需要扩展运行时、围绕 git 与队列的会话工具、把本地端口分享出去的服务隧道、页面级调试注入，以及 AI ↔ 页面 ↔ IDE 的深度协作。上游架构留不出这些层的空间，所以本 fork 把它们做成 **63+ 个内置扩展随包分发**——`npm i -g @aiti-ai/pi-web`，整个工作台开箱即用，无需逐个装扩展。

引擎仍是 pi（共享 JSONL 会话与本机配置），上游文档描述的一切照常适用。文档、产品矩阵与 fork 背后的故事见 [aiti.pw](https://aiti.pw/)（[源码](https://github.com/aiti-ai/aiti-docs)）。

![AITI Web 展示包含结构化 Markdown、工具调用和项目导航的 pi 会话](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

### 内置扩展（精选）

上游界面全部保留；以下功能以 bundled 扩展形式随包开箱即用。

- **会话与队列**——`session-manager`（跨项目 All Sessions 管理器：看板/标签/归档/全文搜索/fork 工具）、`queue-keeper`（排队消息编辑/导出/导入/插队）、`aiti-recovery`（中断会话重启恢复向导）、`aiti-draft-keeper`、`aiti-session-cards`（审批/授权卡）
- **Git 工具链**——`aiti-git-ops`（提交图谱、AI 分组提交计划+断点回滚、worktree、分支面板）、`aiti-git-review`（Monaco diff 工作区+行标注+AI 预审）、`aiti-git-trace`（AI 变更追踪时间线）
- **页面注入调试（aiti-devtools）**——在任意本地 Web 应用内进行 AI 调试：FAB/HUD、8 域 42 命令类 CDP 命令集、Inspector、以及让 AI agent 与页面对话的 MCP 桥
- **多 Agent 后端**——Claude Code、Codex、Cursor、CodeBuddy、Qoder、ZCode、OpenCode、Kimi、Gemini、Copilot、iFlow 等（CLI+ACP 双驱动），统一登录管理、子代理舰队、自定义 Agent 注册
- **模型与用量**——模型向导（目录搜索/多 key 轮转/聚合）、可用性探测+429 限流识别、余额配额与用量报表
- **运维基础设施**——`service-tunnels`（本地端口 DNS/隧道分享+认证）、扩展管理器（在线注册表）、配置版本化+崩溃自检、备份、事件总线、VNC UI 环境、邮件、IM 渠道、文档中心
- **阅读与交互**——消息智能（点击引用/滚动导航/锚点）、语音输入输出、弹窗浮动、上下文比例条、Prompt 收藏库、方案先行、文档查看器（docx/xlsx/pdf/pptx），以及约 40 个更多

工作台之外，[aiti 生态](https://aiti.pw/)还提供 Vite/Vue/Next/React/Svelte 页面注入 SDK、Chrome 与 IDE 扩展、MCP 桥/server（任意 AI agent 直达 IDE 窗口），以及一键 Docker 镜像（core/full）。


## 功能

- **会话工作区**：按项目查找、继续、重命名、导出和删除对话，并查看运行状态、上下文占用、花费和压缩信息。
- **两种分支方式**：**新会话**会从较早的消息创建独立会话文件；**从此处编辑**会在当前会话内创建分支。
- **项目文件工具**：浏览和上传文件、查看 Git Diff，并预览源码、Markdown、图片、音频、PDF 和 DOCX；文件变化后会自动刷新。
- **Git worktree**：从侧边栏切换 checkout，同时把同一仓库不同 worktree 的会话归在一起。
- **网页配置**：无需离开 Pi Web，即可管理 Provider 登录和 API Key、模型、模型测试、插件包及技能。
- **英文、简体中文和繁体中文界面**：Pi Web 首次打开时跟随浏览器语言，也可从顶部栏切换语言。

## 快速开始

Pi Web 要求 Node.js 22.19.0 或更高版本。先用 `node --version` 检查版本，然后运行：

```bash
npx @aiti-ai/pi-web@latest
```

服务就绪后，命令行会尝试自动打开浏览器。如果没有打开，请访问 [http://127.0.0.1:30141](http://127.0.0.1:30141)。Pi Web 默认仅监听 `127.0.0.1`。

如果尚未配置模型 Provider，请打开**模型（Models）**面板登录或添加 API Key。

如需全局安装 `pi-web` 命令：

```bash
npm install -g @aiti-ai/pi-web@latest
pi-web
```

命令：

```bash
pi-web version          # 打印已安装的版本
pi-web status           # 列出正在运行的服务
pi-web stop [--port N]  # 停止正在运行的服务
pi-web open [--port N]  # 在浏览器中打开正在运行的服务
pi-web update [--check] # 更新全局 npm 安装
```

更新时先运行 `pi-web stop`，再运行 `pi-web update`（也可以再次执行同一条安装命令）。卸载时运行 `npm uninstall -g @aiti-ai/pi-web`。

## 配置

端口和主机名以命令行参数为准，优先于对应的环境变量。`--no-open` 与 `PI_WEB_NO_OPEN=1` 中任意一个都会关闭自动打开浏览器。运行 `pi-web --help`（或 `-h`）可打印启动选项并以退出码 0 结束，不会启动服务；未知参数会报错并以退出码 1 结束。

| 参数或环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `--help`、`-h` | 打印启动选项并退出 | — |
| `--port <端口>`、`-p <端口>` 或 `PORT` | 服务端口 | `30141` |
| `--hostname <主机>`、`-H <主机>` 或 `PI_WEB_HOSTNAME` | 监听主机名 | `127.0.0.1` |
| `--no-open` 或 `PI_WEB_NO_OPEN=1` | 不自动打开浏览器 | 自动打开 |
| `PI_WEB_APP_NAME` | PWA manifest 的 `name` 和 `short_name`；去除首尾空白，空值使用默认值 | `Pi Web` |
| `PI_WEB_ALLOWED_HOSTS` | 额外允许的代理或自定义主机名，多个值用逗号分隔，必须精确匹配 | 未设置 |
| `PI_WEB_PASSWORD` | 启用浏览器密码登录；API 客户端可使用用户名为 `pi` 的 Basic Auth | 不启用认证 |

在启动服务前设置 `PI_WEB_APP_NAME`，例如 `PI_WEB_APP_NAME='工作 Pi' pi-web`。修改后重启服务即可提供新的 manifest，无需重新构建。已安装 PWA 的名称更新由浏览器管理，不保证立即生效；此设置不改变页面标题或图标。

例如：

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### 远程访问

监听非回环地址会暴露一个可执行高权限操作的智能体。在可信局域网中使用时，请设置足够长的随机密码：

```bash
PI_WEB_PASSWORD='足够长的随机密码' pi-web --hostname 0.0.0.0
```

密码认证不会加密连接。不要通过明文 HTTP 将 Pi Web 暴露到互联网；远程访问应使用可信反向代理提供 HTTPS，或通过可信 VPN。如果反向代理传递外部主机名，请把该名称精确加入 `PI_WEB_ALLOWED_HOSTS`。这个白名单不会改变 Pi Web 的监听地址。

### HTTP 代理

服务端的模型和 API 请求会读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量。

macOS 或 Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @aiti-ai/pi-web@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @aiti-ai/pi-web@latest
```

## 注意事项

- **智能体数据**：Pi Web 默认读取 `~/.pi/agent` 下的 pi 数据，包括 `sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl` 中的会话文件。可通过 `PI_CODING_AGENT_DIR` 指定其他 pi agent 目录。
- **文件系统访问**：Pi Web 必须能读取智能体数据目录及会话记录中的工作目录。与现有 pi 会话共用数据时，请让 Pi Web 运行在与 pi 相同的文件系统环境中。
- **共享配置**：模型面板使用 pi 的模型、设置和凭据存储，因此两种界面都能看到相关更改。
- **文件访问边界**：文件浏览器仅能访问在 Pi Web 中选择过的工作目录，以及它已识别的项目或会话根目录；它不是通用的文件系统浏览器。
- **Git worktree**：切换器何时显示、如何创建 worktree，以及删除会产生什么影响，见 [Pi Web 里的 Worktree](./worktrees.zh-CN.md)。

## 开发

```bash
npm install
npm run dev
```

开发服务器运行在 [http://127.0.0.1:30141](http://127.0.0.1:30141)。常用检查命令：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

日常开发时不要运行 `next build` 或 `npm run build`。它们会写入 `.next/`，可能干扰开发服务器；仅在发布流程中执行构建。

开始做新功能之前，请先阅读[参与贡献](./CONTRIBUTING.zh-CN.md)，了解哪些改动在范围内以及提交 PR 前的检查项。

贡献者文档：[国际化](./i18n.md)和[发布流程](./release.md)。

## 仓库结构

```text
app/             Next.js 界面和 API 路由
components/      React 界面组件
hooks/           客户端状态和交互 hooks
lib/             会话、智能体、模型、文件、Git 和安全逻辑
public/          静态资源和 PWA 文件
bin/             npm CLI 入口及启动参数解析
docs/            面向用户和贡献者的专题文档
demo/            发布到 GitHub Pages 的静态演示站（见 demo/README.md）
```

架构说明和详细文件地图见 [AGENTS.md](../AGENTS.md)。

## 许可证

[MIT](../LICENSE)
