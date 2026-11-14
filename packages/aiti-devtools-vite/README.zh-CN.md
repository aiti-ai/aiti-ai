# @aiti-ai/aiti-devtools-vite

> Vite 载体插件：dev server 内置桥/MCP（同源 /aiti/）+ launcher 自动注入 + 启动自动注册 agent 工具；SvelteKit 等任意 Vite 工程同样适用；dev-only，生产构建零注入。

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

## 安装

```bash
npm install -D @aiti-ai/aiti-devtools-vite
```

不同载体的接线方式见文档（多数一行接入）。

## 文档

- 中文文档: <https://aiti.pw/devtools/integrations/vite.html>
- Documentation (English): <https://aiti.pw/en/devtools/integrations/vite.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
