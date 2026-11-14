# @aiti-ai/aiti-omp-agent

> Oh My Pi (omp.sh)——pi 最大 fork 的 RPC spawn 后端（拆分自 aiti-pi-agent 专一 omp）：omp --mode rpc 子进程 + ready 握手 / get_state 能力面 / host tools / login / branch

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

分类: 多 agent 后端 · tags: `omp` · `rpc` · `spawn` · `session-backend` · `host-tools` · `login` · `branch` · `subagents`

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-omp-agent/` 后 reload。

需本机装有 omp：`bun install -g @oh-my-pi/pi-coding-agent`（bun ≥ 1.3.14），或 `OMP_CLI` 指定路径。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-omp-agent.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-omp-agent.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
