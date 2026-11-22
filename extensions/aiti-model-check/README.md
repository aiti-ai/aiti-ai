# @aiti-ai/aiti-model-check

> Model health probing — sends a tiny probe message to each model to check availability / 429 rate limiting / errors; parses the rate-limit recovery time (Retry-After etc.), records history to identify availability windows; long-term rate-limit expiry reminders (pure local time checks, zero probing)

English · [简体中文](./README.zh-CN.md)

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- Workbench (aiti-agent, built on pi-web): <https://github.com/aiti-ai/pi-web>
- Ecosystem monorepo: <https://github.com/aiti-ai/aiti-ai>
- Site: <https://aiti.pw>

Category: AI capabilities · Tags: `model` · `probe` · `429` · `rate-limit` · `availability` · `recovery-notify`

## Install

Bundled with **aiti-agent** (`@aiti-ai/pi-web`) — enable it from the in-app extension manager (ExtMan / App Center).

Manual install: place this package at `~/.pi/web/extensions/aiti-model-check/` and reload pi-web.

## Documentation

- Documentation (English): <https://aiti.pw/en/extensions/aiti-model-check.html>
- 文档（中文）: <https://aiti.pw/extensions/aiti-model-check.html>
- Extension registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
