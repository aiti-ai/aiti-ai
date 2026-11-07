# @aiti-ai/aiti-devtools-core

> aiti-devtools 的桥核心：页面 ⇄ agent 的消息/会话桥（claim/SSE/result 协议）、Streamable HTTP MCP 端点、浏览器协议（host-protocol/aiwin）与载体无关公共能力（mcp-config 注册 / endpoints 地址协商 / connect 中间件适配 / assets 公共资产）。

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

aiti-devtools 的桥核心：页面 ⇄ agent 的消息/会话桥（claim/SSE/result 协议）、Streamable HTTP MCP 端点、浏览器协议（host-protocol/aiwin）与载体无关公共能力（mcp-config 注册 / endpoints 地址协商 / connect 中间件适配 / assets 公共资产）。

## Positioning (English)

Bridge core of aiti-devtools: the page ⇄ agent message/session bridge (claim/SSE/result protocol), Streamable HTTP MCP endpoint, browser protocol (host-protocol/aiwin) and carrier-agnostic shared capabilities (mcp-config registration / endpoints negotiation / connect middleware / assets).

## 安装 / 部署

```bash
npm install -D @aiti-ai/aiti-devtools-core
```

不同载体的接线方式见文档（多数一行接入）。

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/devtools/core.html>
- English docs: <https://aiti.pw/en/devtools/core.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
