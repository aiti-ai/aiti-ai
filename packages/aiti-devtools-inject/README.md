# @aiti-ai/aiti-devtools-inject

> launcher + client 注入产物与注入 SDK：本地 inject 细节、三种形态、宿主/iframe 路由（__dbg 协议、createDbgLauncher、动态 iframe 注入）。

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

launcher + client 注入产物与注入 SDK：本地 inject 细节、三种形态、宿主/iframe 路由（__dbg 协议、createDbgLauncher、动态 iframe 注入）。

## Positioning (English)

Launcher + client injection artifacts and SDK: local injection internals, three forms, host/iframe routing (the __dbg protocol, createDbgLauncher, dynamic iframe injection).

## 安装 / 部署

```bash
npm install -D @aiti-ai/aiti-devtools-inject
```

不同载体的接线方式见文档（多数一行接入）。

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/devtools/inject.html>
- English docs: <https://aiti.pw/en/devtools/inject.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
