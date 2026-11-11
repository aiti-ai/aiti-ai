# @aiti-ai/aiti-omp-agent

> Oh My Pi (omp.sh)——pi 最大 fork 的 RPC spawn 后端（拆分自 aiti-pi-agent 专一 omp）：omp --mode rpc 子进程 + ready 握手 / get_state 能力面 / host tools / login / branch

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

Oh My Pi (omp.sh)——pi 最大 fork 的 RPC spawn 后端（拆分自 aiti-pi-agent 专一 omp）：omp --mode rpc 子进程 + ready 握手 / get_state 能力面 / host tools / login / branch

多 agent 后端 · tags: `omp` · `rpc` · `spawn` · `session-backend` · `host-tools` · `login` · `branch` · `subagents`

## Positioning (English)

Oh My Pi (omp.sh) — RPC spawn backend for pi's largest fork (split from aiti-pi-agent to specialize in omp): `omp --mode rpc` child process + ready handshake / get_state capability surface / host tools / login / branch

## 安装 / 部署

```bash
node pi-web-ext/aiti-omp-agent/tools/deploy.mjs   # 双实例部署 + reconcile + reload；
# 需本机装有 omp（bun install -g @oh-my-pi/pi-coding-agent，bun ≥1.3.14），或 OMP_CLI 指定路径
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-omp-agent.html>
- English docs: <https://aiti.pw/en/extensions/aiti-omp-agent.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
