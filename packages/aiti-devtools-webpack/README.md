# @aiti-ai/aiti-devtools-webpack

> webpack-dev-server 载体插件：setupMiddlewares 挂桥 + html-webpack-plugin 注入；Rspack 同格式零改动直接复用。

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

webpack-dev-server 载体插件：setupMiddlewares 挂桥 + html-webpack-plugin 注入；Rspack 同格式零改动直接复用。

## Positioning (English)

webpack-dev-server carrier plugin: bridge via setupMiddlewares + html-webpack-plugin injection; Rspack reuses it unchanged.

## 安装 / 部署

```bash
npm install -D @aiti-ai/aiti-devtools-webpack
```

不同载体的接线方式见文档（多数一行接入）。

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/devtools/integrations/webpack-rspack.html>
- English docs: <https://aiti.pw/en/devtools/integrations/webpack-rspack.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
