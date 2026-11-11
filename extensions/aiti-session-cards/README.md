# @aiti-ai/aiti-session-cards

> 会话请求卡扩展——交互元语卡（zcode 方案审批 / AskUser / omp OAuth / generic 兜底）与工具授权卡完整 UI，自 pi-web core 外迁（agent 能力 UI 去核化 P1）

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

会话请求卡扩展——交互元语卡（zcode 方案审批 / AskUser / omp OAuth / generic 兜底）与工具授权卡完整 UI，自 pi-web core 外迁（agent 能力 UI 去核化 P1）

聊天增强 · tags: `session-request-card` · `plan-approval` · `ask-user` · `tool-auth` · `oauth` · `interaction` · `permission`

## Positioning (English)

Session request card extension — full UI for interaction-primitive cards (zcode plan approval / AskUser / omp OAuth / generic fallback) and tool authorization cards, migrated out of pi-web core (agent capability UI de-coring P1)

## 安装 / 部署

```bash
node pi-web-ext/aiti-session-cards/tools/deploy.mjs   # vite 构建 + 双实例部署 + reload
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-session-cards.html>
- English docs: <https://aiti.pw/en/extensions/aiti-session-cards.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
