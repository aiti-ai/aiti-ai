# @aiti-ai/ext-shared

> Server-side shared layer for aiti-agent extensions: agent-spawn-env (spawn env governance / resolveCliLaunch), seed-tool (history-replay seeds), cursor-cli-store (Cursor CLI session reader), exec-async, git-ops-client and more. Declared in each extension's package.json and installed into the shared node_modules root by extman reconcile (resolved via jiti walk-up).

[English](./README.md) · 简体中文见 [README.zh-CN.md](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

## Install

Not installed directly — it is the shared runtime dependency of aiti extensions. Extensions declare it in their `package.json` dependencies; extman reconcile installs it once into the shared root `node_modules`, where it is resolved via jiti walk-up.

## Documentation

- Documentation (English): <https://aiti.pw/en/guide/ext-services.html>
- 文档（中文）: <https://aiti.pw/guide/ext-services.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
