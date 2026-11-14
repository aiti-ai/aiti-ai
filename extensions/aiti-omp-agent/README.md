# @aiti-ai/aiti-omp-agent

> Oh My Pi (omp.sh) — RPC spawn backend for pi's largest fork (split from aiti-pi-agent to specialize in omp): `omp --mode rpc` child process + ready handshake / get_state capability surface / host tools / login / branch

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

Category: Multi-agent backends · Tags: `omp` · `rpc` · `spawn` · `session-backend` · `host-tools` · `login` · `branch` · `subagents`

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-omp-agent/` and reload pi-web.

Requires the omp CLI on the machine: `bun install -g @oh-my-pi/pi-coding-agent` (bun ≥ 1.3.14), or point `OMP_CLI` at the binary.

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-omp-agent.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-omp-agent.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
