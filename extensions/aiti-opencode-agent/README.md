# @aiti-ai/aiti-opencode-agent

> OpenCode CLI 专属驱动 —— 历史会话在 pi-web 打开、续聊（oneshot run -s --format json）

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

OpenCode CLI 专属驱动 —— 历史会话在 pi-web 打开、续聊（oneshot run -s --format json）

多 agent 后端 · tags: `opencode` · `agent` · `session-provider` · `cli`

## Positioning (English)

OpenCode CLI-exclusive driver — open historical sessions in pi-web and continue chatting (oneshot run -s --format json)

## 安装 / 部署

```bash
node tools/deploy.mjs   # 拷贝 + 双实例热重载；要求 opencode CLI 已登录
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-opencode-agent.html>
- English docs: <https://aiti.pw/en/extensions/aiti-opencode-agent.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
