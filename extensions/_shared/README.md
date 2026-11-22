# @aiti-ai/ext-shared

> aiti-agent 扩展的服务端共享层：agent-spawn-env（spawn env 治理 / resolveCliLaunch）、seed-tool（历史回放种子）、cursor-cli-store（Cursor CLI 会话读取器）、exec-async、git-ops-client 等共享模块。扩展 package.json 声明依赖后由 extman reconcile 统一装进共享根 node_modules，jiti walk-up 解析。

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

aiti-agent 扩展的服务端共享层：agent-spawn-env（spawn env 治理 / resolveCliLaunch）、seed-tool（历史回放种子）、cursor-cli-store（Cursor CLI 会话读取器）、exec-async、git-ops-client 等共享模块。扩展 package.json 声明依赖后由 extman reconcile 统一装进共享根 node_modules，jiti walk-up 解析。

## Positioning (English)

Server-side shared layer for aiti-agent extensions: agent-spawn-env (spawn env governance / resolveCliLaunch), seed-tool (history-replay seeds), cursor-cli-store (Cursor CLI session reader), exec-async, git-ops-client and more. Declared in each extension's package.json and installed into the shared node_modules root by extman reconcile (resolved via jiti walk-up).

## 安装 / 部署

随 aiti-agent 扩展体系部署（extman 安装 / deploy 脚本拷贝到 `~/.pi/web/extensions/`），一般不单独 npm 安装；作为依赖被引用时经 extman reconcile 自动装入共享 node_modules。

Deployed as part of the aiti-agent extension system (extman install / deploy scripts copy it to `~/.pi/web/extensions/`); usually not installed standalone.

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/guide/ext-services.html>
- English docs: <https://aiti.pw/en/guide/ext-services.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
