# @aiti-ai/aiti-attach-agent

> Socket 附着已运行 agent 进程 —— 连接 pi TUI bridge；支持环境变量全自动（PI_WEB_BRIDGE_AUTO=1 任何 CLI 会话自动上桥）；followUp 排队回显 + 图片附件透传 + 空闲超时退出

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

分类: 多 agent 后端 · tags: `attach` · `socket` · `tui` · `session` · `multi-agent`

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-attach-agent/` 后 reload。

pi TUI 端（配对包，`/web` 命令 + 自动桥）独立发布为 pi 包，在 pi 里安装：

```bash
pi install npm:@aiti-ai/pi-web-bridge
```

两侧配对关系：TUI 端起 socket 桥并写 `~/.pi/agent/bridge-registry.json`，本包（pi-web 端）打开会话时查注册表命中即 attach 到该 socket（单写者规则——会话文件仍由 pi 进程独占写入）。`PI_WEB_BRIDGE_AUTO=1` 时 TUI 端每个会话自动上桥，免 `/web`。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-attach-agent.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-attach-agent.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
