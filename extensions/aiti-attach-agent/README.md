# @aiti-ai/aiti-attach-agent

> Socket 附着已运行 agent 进程 —— 连接 pi TUI bridge；支持环境变量全自动（PI_WEB_BRIDGE_AUTO=1 任何 CLI 会话自动上桥）；followUp 排队回显 + 图片附件透传 + 空闲超时退出

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

Socket 附着已运行 agent 进程 —— 连接 pi TUI bridge；支持环境变量全自动（PI_WEB_BRIDGE_AUTO=1 任何 CLI 会话自动上桥）；followUp 排队回显 + 图片附件透传 + 空闲超时退出

多 agent 后端 · tags: `attach` · `socket` · `tui` · `session` · `multi-agent`

## Positioning (English)

Socket-attaches to already running agent processes — connects the pi TUI bridge; supports full automation via environment variables (PI_WEB_BRIDGE_AUTO=1 auto-bridges any CLI session); followUp queue echo + image attachment passthrough + idle timeout exit

## 安装 / 部署

pi-web 端（本包）随 pi-web 部署：

```bash
# 部署到 ~/.pi/web/extensions/aiti-attach-agent/ 后 reload
```

pi TUI 端（配对包，`/web` 命令 + 自动桥）独立发布为 pi 包，在 pi 里安装：

```bash
pi install @aiti-ai/pi-web-bridge
```

两侧配对关系：TUI 端起 socket 桥并写 `~/.pi/agent/bridge-registry.json`，本包（pi-web 端）打开会话时查注册表命中即 attach 到该 socket（单写者规则——会话文件仍由 pi 进程独占写入）。`PI_WEB_BRIDGE_AUTO=1` 时 TUI 端每个会话自动上桥，免 `/web`。

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-attach-agent.html>
- English docs: <https://aiti.pw/en/extensions/aiti-attach-agent.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
