# @aiti-ai/aiti-cursor-agent

> 驱动 Cursor Agent CLI 会话（agentKey: cursor）——stream-json print 模式 + --resume 多轮；Cursor IDE 会话只读解析

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

驱动 Cursor Agent CLI 会话（agentKey: cursor）——stream-json print 模式 + --resume 多轮；Cursor IDE 会话只读解析

会话管理 · tags: `cursor` · `agent` · `sessions` · `cli`

## Positioning (English)

Drives Cursor Agent CLI sessions (agentKey: cursor) — stream-json print mode + --resume multi-turn; Cursor IDE sessions parsed read-only

## 安装 / 部署

随 aiti-agent 扩展体系部署（extman 安装 / deploy 脚本拷贝到 `~/.pi/web/extensions/`），一般不单独 npm 安装；作为依赖被引用时经 extman reconcile 自动装入共享 node_modules。

Deployed as part of the aiti-agent extension system (extman install / deploy scripts copy it to `~/.pi/web/extensions/`); usually not installed standalone.

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-cursor-agent.html>
- English docs: <https://aiti.pw/en/extensions/aiti-cursor-agent.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
