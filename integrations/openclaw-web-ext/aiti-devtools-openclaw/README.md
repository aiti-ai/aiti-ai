# @aiti-ai/aiti-devtools-openclaw

> OpenClaw 插件直连跳过 MCP —— 16 工具注册进 agent 会话 + 会话自动上线 + chat.send 消息注入 + 答复回传 + 占位符对照表，cockpit 伴生 AI 窗

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

OpenClaw 插件直连跳过 MCP —— 16 工具注册进 agent 会话 + 会话自动上线 + chat.send 消息注入 + 答复回传 + 占位符对照表，cockpit 伴生 AI 窗

宿主适配 · tags: `openclaw` · `adapter` · `plugin` · `bridge-rest` · `chat-send` · `placeholder`

## Positioning (English)

OpenClaw plugin direct connection skipping MCP — 16 tools registered into agent sessions + sessions auto-online + chat.send message injection + answers relayed back + placeholder mapping table, cockpit companion AI window

## 安装 / 部署

```bash
# 源码安装（--link 本地目录）
openclaw plugins install <openclaw-web-ext/aiti-devtools-openclaw> --link
openclaw plugins enable aiti-devtools && 重启 gateway
# openclaw 2026.10.10+ 两道门：先 openclaw doctor --fix（state 库迁移，先备份 ~/.openclaw/state/）；
# 升级后插件报 requires capability consent → openclaw plugins enable aiti-devtools --accept-capabilities + 重启即清
# 桥地址：plugins.entries.aiti-devtools.config.bridgeUrl > env AITI_BRIDGE_URL > http://127.0.0.1:8777
# 工具定义构建：node tools/build.mjs（拉桥 tools/list 内嵌 16 工具）
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-devtools-openclaw.html>
- English docs: <https://aiti.pw/en/extensions/aiti-devtools-openclaw.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
