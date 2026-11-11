# @aiti-ai/pi-git-trace

> 编外 AI 变更追踪——仓根 .aiti-trace 独立追踪仓（无 git 也可 autoInit）+ op 编号 before/after 双 commit + 文件⇄消息⇄操作全链路 + 回撤 + 影子仓瘦身 compact

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

编外 AI 变更追踪——仓根 .aiti-trace 独立追踪仓（无 git 也可 autoInit）+ op 编号 before/after 双 commit + 文件⇄消息⇄操作全链路 + 回撤 + 影子仓瘦身 compact

系统工具 · tags: `git` · `trace` · `lineage` · `rollback`

## Positioning (English)

Out-of-band AI change tracking — repo-root .aiti-trace standalone trace repo (autoInit even without git) + op-numbered before/after dual commits + full file⇄message⇄op lineage + rollback + shadow repo slimming compact

## 安装 / 部署

pi CLI 侧：`~/.pi/agent/settings.json` 的 packages 加本地路径或 npm 包；pi-web 侧：`node pi-web-ext/aiti-git-trace/tools/deploy.mjs`（双实例部署 + reload）。

pi CLI side: add the local path or npm package to `packages` in `~/.pi/agent/settings.json`; pi-web side: `node pi-web-ext/aiti-git-trace/tools/deploy.mjs` (dual-instance deploy + reload).

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-git-trace.html>
- English docs: <https://aiti.pw/en/extensions/aiti-git-trace.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
