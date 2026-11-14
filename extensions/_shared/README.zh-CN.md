# @aiti-ai/ext-shared

> aiti-agent 扩展的服务端共享层：agent-spawn-env（spawn env 治理 / resolveCliLaunch）、seed-tool（历史回放种子）、cursor-cli-store（Cursor CLI 会话读取器）、exec-async、git-ops-client 等共享模块。扩展 package.json 声明依赖后由 extman reconcile 统一装进共享根 node_modules，jiti walk-up 解析。

简体中文 · English see [README.md](./README.md)

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

## 安装

不直接安装——aiti 扩展的运行时共享依赖。扩展在各自 `package.json` 的 dependencies 里声明本包；extman reconcile 统一装入共享根 `node_modules`（jiti walk-up 解析）。

## 文档

- 中文文档: <https://aiti.pw/guide/ext-services.html>
- Documentation (English): <https://aiti.pw/en/guide/ext-services.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
