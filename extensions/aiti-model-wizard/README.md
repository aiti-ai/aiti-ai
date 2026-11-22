# @aiti-ai/aiti-model-wizard

> Guided AI provider/model onboarding — catalog search (models.dev + domestic AI catalog, Chinese/English, paste an API URL to reverse-search) → enter token → test (both 2xx/429 count as pass) → pick/type a model → write models.json; on miss, baseUrl reverse matching (auto-extracts URLs from any doc/code snippet) or auto detection (fills missing v1/v2, pulls the model list with a key + OpenAPI/model-prefix brand signals); tokens are masked on every read and never returned to the frontend

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

Category: AI capabilities · Tags: `model` · `provider` · `wizard` · `onboarding` · `models.dev` · `catalog`

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-model-wizard/` and reload pi-web.

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-model-wizard.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-model-wizard.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
