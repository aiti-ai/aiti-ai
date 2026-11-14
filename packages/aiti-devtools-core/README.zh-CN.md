# @aiti-ai/aiti-devtools-core

> aiti-devtools 的桥核心：页面 ⇄ agent 的消息/会话桥（claim/SSE/result 协议）、Streamable HTTP MCP 端点、浏览器协议（host-protocol/aiwin）与载体无关公共能力（mcp-config 注册 / endpoints 地址协商 / connect 中间件适配 / assets 公共资产）。

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

## 安装

```bash
npm install -D @aiti-ai/aiti-devtools-core
```

不同载体的接线方式见文档（多数一行接入）。

## 文档

- 中文文档: <https://aiti.pw/devtools/core.html>
- Documentation (English): <https://aiti.pw/en/devtools/core.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
