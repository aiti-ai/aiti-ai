# @aiti-ai/aiti-devtools-agent

> 多 agent 宿主接线框架：AgentBridgeClient（桥 HTTP/SSE 客户端）+ AgentHost 契约 + 工具/交互映射模板——pi 扩展、DSH 宿主适配等复用同一套接线。

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

多 agent 宿主接线框架：AgentBridgeClient（桥 HTTP/SSE 客户端）+ AgentHost 契约 + 工具/交互映射模板——pi 扩展、DSH 宿主适配等复用同一套接线。

## Positioning (English)

Multi-agent host wiring framework: AgentBridgeClient (bridge HTTP/SSE client) + AgentHost contract + tool/interaction mapping templates — reused by the pi extension, the DSH host adapter and more.

## 安装 / 部署

```bash
npm install -D @aiti-ai/aiti-devtools-agent
```

不同载体的接线方式见文档（多数一行接入）。

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/devtools/>
- English docs: <https://aiti.pw/en/devtools/>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
